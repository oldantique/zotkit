import type {
  AccountLoginParams,
  AccountLoginResponse,
  AccountReadParams,
  AccountReadResponse,
  ApprovalRequest,
  ApprovalResponse,
  ClientInfo,
  CodexUserInput,
  CommandApprovalParams,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  FileChangeApprovalParams,
  InitializeCapabilities,
  InitializeParams,
  InitializeResponse,
  ModelListParams,
  ModelListResponse,
  PermissionsApprovalParams,
  ProtocolThread,
  ProtocolThreadItem,
  ProtocolTurn,
  RpcErrorObject,
  RpcId,
  RpcNotification,
  StoredItem,
  StoredThread,
  StoredTurn,
  ThreadListParams,
  ThreadListResponse,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadSetNameParams,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadStoreSnapshot,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
  WebSocketFactory,
  WebSocketLike,
} from "./protocol";

export * from "./protocol";

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "number" || typeof value === "string";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function textInput(text: string): CodexUserInput {
  return { type: "text", text, text_elements: [] };
}

export { textInput };

export class CodexRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;
  readonly requestId: RpcId;

  constructor(
    error: RpcErrorObject,
    method: string,
    requestId: RpcId,
  ) {
    super(error.message);
    this.name = "CodexRpcError";
    this.code = error.code;
    this.data = error.data;
    this.method = method;
    this.requestId = requestId;
  }
}

export class CodexRequestTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;
  readonly requestId: RpcId;

  constructor(method: string, timeoutMs: number, requestId: RpcId) {
    super(`Codex app-server request \"${method}\" timed out after ${timeoutMs}ms`);
    this.name = "CodexRequestTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
    this.requestId = requestId;
  }
}

export class CodexDisconnectedError extends Error {
  readonly code?: number;
  readonly reason?: string;

  constructor(message = "Codex app-server is disconnected", code?: number, reason?: string) {
    super(message);
    this.name = "CodexDisconnectedError";
    this.code = code;
    this.reason = reason;
  }
}

/** Throw from a server-request callback to choose the JSON-RPC error response. */
export class CodexServerRequestError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "CodexServerRequestError";
    this.code = code;
    this.data = data;
  }
}

export type CodexConnectionState =
  | "idle"
  | "connecting"
  | "initializing"
  | "ready"
  | "disconnected"
  | "closed";

export interface CodexServerRequestHandlers {
  commandApproval?: (
    params: CommandApprovalParams,
  ) => ApprovalResponse | Promise<ApprovalResponse>;
  fileChangeApproval?: (
    params: FileChangeApprovalParams,
  ) => ApprovalResponse | Promise<ApprovalResponse>;
  permissionsApproval?: (
    params: PermissionsApprovalParams,
  ) => ApprovalResponse | Promise<ApprovalResponse>;
  dynamicToolCall?: (
    params: DynamicToolCallParams,
  ) => DynamicToolCallResponse | Promise<DynamicToolCallResponse>;
  unknownRequest?: (
    method: string,
    params: unknown,
  ) => unknown | Promise<unknown>;
}

export interface CodexAppServerClientOptions {
  url: string;
  protocols?: string | string[];
  webSocketFactory?: WebSocketFactory;
  clientInfo?: Partial<ClientInfo>;
  capabilities?: Partial<InitializeCapabilities> | null;
  requestTimeoutMs?: number;
  store?: ThreadStore;
  handlers?: CodexServerRequestHandlers;
  /** Generic approval hook used when a method-specific handler is absent. */
  onApproval?: (
    request: ApprovalRequest,
  ) => ApprovalResponse | Promise<ApprovalResponse>;
  onNotification?: (notification: RpcNotification) => void;
  onUnknownNotification?: (notification: RpcNotification) => void;
  onProtocolError?: (error: Error, frame?: unknown) => void;
  onTransportError?: (event: unknown) => void;
  onStateChange?: (state: CodexConnectionState) => void;
}

export interface RequestOptions {
  timeoutMs?: number;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type ThreadStoreListener = (
  snapshot: ThreadStoreSnapshot,
  notification?: RpcNotification,
) => void;

function normalizeItem(
  item: ProtocolThreadItem,
  fallbackId = "unknown-item",
): StoredItem {
  return {
    ...item,
    id: optionalString(item.id) ?? fallbackId,
  } as StoredItem;
}

function normalizeTurn(turn: ProtocolTurn): StoredTurn {
  const rawItems = Array.isArray(turn.items) ? turn.items : [];
  return {
    ...turn,
    id: turn.id,
    items: rawItems.map((item, index) =>
      normalizeItem(item, `${turn.id}:item:${index}`),
    ),
  } as StoredTurn;
}

function mergeItem(current: StoredItem | undefined, incoming: StoredItem): StoredItem {
  if (!current) return incoming;
  return {
    ...current,
    ...incoming,
    progress: incoming.progress ?? current.progress,
    events: incoming.events ?? current.events,
  };
}

function mergeTurn(current: StoredTurn | undefined, incoming: StoredTurn): StoredTurn {
  if (!current) return incoming;
  const items = [...current.items];
  for (const item of incoming.items) {
    const index = items.findIndex((candidate) => candidate.id === item.id);
    if (index < 0) items.push(item);
    else items[index] = mergeItem(items[index], item);
  }
  return {
    ...current,
    ...incoming,
    items,
    events: incoming.events ?? current.events,
  };
}

/**
 * Framework-neutral observable store. Its snapshot is directly renderable by
 * React/Preact and keeps streamed deltas attached to their thread/turn/item.
 */
export class ThreadStore {
  private readonly threads = new Map<string, StoredThread>();
  private readonly listeners = new Set<ThreadStoreListener>();
  private version = 0;
  private snapshot: ThreadStoreSnapshot = Object.freeze({
    version: 0,
    threads: Object.freeze([]) as readonly StoredThread[],
  });

  getSnapshot = (): ThreadStoreSnapshot => this.snapshot;

  getThread(threadId: string): StoredThread | undefined {
    return this.threads.get(threadId);
  }

  subscribe(listener: ThreadStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ingestThread(thread: ProtocolThread): void {
    this.ingestThreads([thread]);
  }

  ingestThreads(threads: ProtocolThread[]): void {
    let changed = false;
    for (const thread of threads) {
      if (!thread || typeof thread.id !== "string") continue;
      const current = this.threads.get(thread.id);
      const turns = current ? [...current.turns] : [];
      const incomingTurns = Array.isArray(thread.turns) ? thread.turns : [];
      for (const rawTurn of incomingTurns) {
        if (!rawTurn || typeof rawTurn.id !== "string") continue;
        const incoming = normalizeTurn(rawTurn);
        const index = turns.findIndex((turn) => turn.id === incoming.id);
        if (index < 0) turns.push(incoming);
        else turns[index] = mergeTurn(turns[index], incoming);
      }
      const next = {
        ...current,
        ...thread,
        id: thread.id,
        turns,
      } as StoredThread;
      this.threads.set(thread.id, next);
      changed = true;
    }
    if (changed) this.emit();
  }

  ingestTurn(threadId: string, turn: ProtocolTurn): void {
    if (!threadId || !turn || typeof turn.id !== "string") return;
    const thread = this.ensureThread(threadId);
    const turns = [...thread.turns];
    const incoming = normalizeTurn(turn);
    const index = turns.findIndex((candidate) => candidate.id === turn.id);
    if (index < 0) turns.push(incoming);
    else turns[index] = mergeTurn(turns[index], incoming);
    this.threads.set(threadId, { ...thread, turns });
    this.emit();
  }

  setThreadName(threadId: string, name: string | null): void {
    const thread = this.ensureThread(threadId);
    this.threads.set(threadId, { ...thread, name });
    this.emit();
  }

  /** Returns true when the notification was incorporated into the store. */
  applyNotification(notification: RpcNotification): boolean {
    const params = isRecord(notification.params) ? notification.params : {};
    const threadId = optionalString(params.threadId);
    const turnId = optionalString(params.turnId);

    switch (notification.method) {
      case "thread/started": {
        if (!isRecord(params.thread) || typeof params.thread.id !== "string") return false;
        this.ingestThread(params.thread as ProtocolThread);
        return true;
      }
      case "thread/name/updated": {
        if (!threadId) return false;
        const name = optionalString(params.threadName) ?? null;
        this.setThreadName(threadId, name);
        return true;
      }
      case "thread/status/changed": {
        if (!threadId) return false;
        const thread = this.ensureThread(threadId);
        this.threads.set(threadId, { ...thread, status: params.status });
        this.emit(notification);
        return true;
      }
      case "thread/tokenUsage/updated": {
        if (!threadId || !turnId) return false;
        const thread = this.ensureThread(threadId);
        this.threads.set(threadId, { ...thread, tokenUsage: params.tokenUsage });
        this.updateTurn(threadId, turnId, (turn) => ({
          ...turn,
          tokenUsage: params.tokenUsage,
        }), notification);
        return true;
      }
      case "turn/started":
      case "turn/completed": {
        if (!threadId || !isRecord(params.turn) || typeof params.turn.id !== "string") {
          return false;
        }
        this.ingestTurn(threadId, params.turn as ProtocolTurn);
        return true;
      }
      case "turn/plan/updated": {
        if (!threadId || !turnId) return false;
        this.updateTurn(threadId, turnId, (turn) => ({
          ...turn,
          plan: Array.isArray(params.plan) ? params.plan : [],
          planExplanation: params.explanation,
        }), notification);
        return true;
      }
      case "turn/diff/updated": {
        if (!threadId || !turnId || typeof params.diff !== "string") return false;
        this.updateTurn(threadId, turnId, (turn) => ({
          ...turn,
          diff: params.diff,
        }), notification);
        return true;
      }
      case "item/started":
      case "item/completed": {
        if (!threadId || !turnId || !isRecord(params.item)) return false;
        const itemId = optionalString(params.item.id);
        const itemType = optionalString(params.item.type);
        if (!itemId || !itemType) return false;
        const lifecycle = notification.method === "item/started" ? "started" : "completed";
        const timing = lifecycle === "started"
          ? { startedAtMs: params.startedAtMs }
          : { completedAtMs: params.completedAtMs };
        this.upsertItem(
          threadId,
          turnId,
          {
            ...(params.item as ProtocolThreadItem),
            id: itemId,
            type: itemType,
            lifecycle,
            ...timing,
          } as StoredItem,
          notification,
        );
        return true;
      }
      case "item/agentMessage/delta":
        return this.appendTextDelta(notification, "agentMessage", "text");
      case "item/plan/delta":
        return this.appendTextDelta(notification, "plan", "text");
      case "item/commandExecution/outputDelta":
        return this.appendTextDelta(notification, "commandExecution", "aggregatedOutput");
      case "item/fileChange/outputDelta":
        return this.appendTextDelta(notification, "fileChange", "output");
      case "item/fileChange/patchUpdated": {
        if (!threadId || !turnId) return false;
        const itemId = optionalString(params.itemId);
        if (!itemId) return false;
        this.updateItem(threadId, turnId, itemId, "fileChange", (item) => ({
          ...item,
          changes: Array.isArray(params.changes) ? params.changes : [],
        }), notification);
        return true;
      }
      case "item/commandExecution/terminalInteraction": {
        if (!threadId || !turnId) return false;
        const itemId = optionalString(params.itemId);
        if (!itemId) return false;
        this.updateItem(threadId, turnId, itemId, "commandExecution", (item) => ({
          ...item,
          terminalInteractions: [
            ...(Array.isArray(item.terminalInteractions) ? item.terminalInteractions : []),
            {
              processId: params.processId,
              stdin: params.stdin,
            },
          ],
        }), notification);
        return true;
      }
      case "item/reasoning/textDelta": {
        return this.appendIndexedDelta(notification, "content", params.contentIndex);
      }
      case "item/reasoning/summaryTextDelta": {
        return this.appendIndexedDelta(notification, "summary", params.summaryIndex);
      }
      case "item/reasoning/summaryPartAdded": {
        if (!threadId || !turnId) return false;
        const itemId = optionalString(params.itemId);
        const summaryIndex = params.summaryIndex;
        if (!itemId || typeof summaryIndex !== "number") return false;
        this.updateItem(threadId, turnId, itemId, "reasoning", (item) => {
          const summary = stringArray(item.summary);
          while (summary.length <= summaryIndex) summary.push("");
          return { ...item, summary };
        }, notification);
        return true;
      }
      case "item/mcpToolCall/progress": {
        if (!threadId || !turnId) return false;
        const itemId = optionalString(params.itemId);
        const message = optionalString(params.message);
        if (!itemId || message === undefined) return false;
        this.updateItem(threadId, turnId, itemId, "mcpToolCall", (item) => ({
          ...item,
          progress: [...(item.progress ?? []), message],
        }), notification);
        return true;
      }
      case "error": {
        if (!threadId || !turnId) return false;
        this.updateTurn(threadId, turnId, (turn) => ({
          ...turn,
          error: params.error,
          status: params.willRetry ? turn.status : "failed",
        }), notification);
        return true;
      }
      default:
        break;
    }

    // Preserve newly introduced item/turn progress notifications even before
    // this client version learns their display-specific fields.
    if (notification.method.startsWith("item/") && threadId && turnId) {
      const itemId = optionalString(params.itemId);
      if (!itemId) return false;
      this.updateItem(threadId, turnId, itemId, "unknown", (item) => ({
        ...item,
        events: [...(item.events ?? []), { method: notification.method, params }],
      }), notification);
      return true;
    }
    if (notification.method.startsWith("turn/") && threadId && turnId) {
      this.updateTurn(threadId, turnId, (turn) => ({
        ...turn,
        events: [...(turn.events ?? []), { method: notification.method, params }],
      }), notification);
      return true;
    }
    return false;
  }

  private appendTextDelta(
    notification: RpcNotification,
    itemType: string,
    field: string,
  ): boolean {
    const params = isRecord(notification.params) ? notification.params : {};
    const threadId = optionalString(params.threadId);
    const turnId = optionalString(params.turnId);
    const itemId = optionalString(params.itemId);
    const delta = optionalString(params.delta);
    if (!threadId || !turnId || !itemId || delta === undefined) return false;
    this.updateItem(threadId, turnId, itemId, itemType, (item) => ({
      ...item,
      [field]: `${typeof item[field] === "string" ? item[field] : ""}${delta}`,
    }), notification);
    return true;
  }

  private appendIndexedDelta(
    notification: RpcNotification,
    field: "summary" | "content",
    rawIndex: unknown,
  ): boolean {
    const params = isRecord(notification.params) ? notification.params : {};
    const threadId = optionalString(params.threadId);
    const turnId = optionalString(params.turnId);
    const itemId = optionalString(params.itemId);
    const delta = optionalString(params.delta);
    if (!threadId || !turnId || !itemId || delta === undefined || typeof rawIndex !== "number") {
      return false;
    }
    this.updateItem(threadId, turnId, itemId, "reasoning", (item) => {
      const values = stringArray(item[field]);
      while (values.length <= rawIndex) values.push("");
      values[rawIndex] += delta;
      return { ...item, [field]: values };
    }, notification);
    return true;
  }

  private updateItem(
    threadId: string,
    turnId: string,
    itemId: string,
    itemType: string,
    update: (item: StoredItem) => StoredItem,
    notification?: RpcNotification,
  ): void {
    const thread = this.ensureThread(threadId);
    const turns = [...thread.turns];
    let turnIndex = turns.findIndex((turn) => turn.id === turnId);
    if (turnIndex < 0) {
      turns.push({ id: turnId, items: [], status: "inProgress" } as StoredTurn);
      turnIndex = turns.length - 1;
    }
    const turn = turns[turnIndex]!;
    const items = [...turn.items];
    let itemIndex = items.findIndex((item) => item.id === itemId);
    if (itemIndex < 0) {
      items.push({ id: itemId, type: itemType } as StoredItem);
      itemIndex = items.length - 1;
    }
    items[itemIndex] = update(items[itemIndex]!);
    turns[turnIndex] = { ...turn, items };
    this.threads.set(threadId, { ...thread, turns });
    this.emit(notification);
  }

  private upsertItem(
    threadId: string,
    turnId: string,
    incoming: StoredItem,
    notification?: RpcNotification,
  ): void {
    this.updateItem(
      threadId,
      turnId,
      incoming.id,
      incoming.type,
      (current) => mergeItem(current, incoming),
      notification,
    );
  }

  private updateTurn(
    threadId: string,
    turnId: string,
    update: (turn: StoredTurn) => StoredTurn,
    notification?: RpcNotification,
  ): void {
    const thread = this.ensureThread(threadId);
    const turns = [...thread.turns];
    let index = turns.findIndex((turn) => turn.id === turnId);
    if (index < 0) {
      turns.push({ id: turnId, items: [], status: "inProgress" } as StoredTurn);
      index = turns.length - 1;
    }
    turns[index] = update(turns[index]!);
    this.threads.set(threadId, { ...thread, turns });
    this.emit(notification);
  }

  private ensureThread(threadId: string): StoredThread {
    const existing = this.threads.get(threadId);
    if (existing) return existing;
    const thread = { id: threadId, turns: [] } as StoredThread;
    this.threads.set(threadId, thread);
    return thread;
  }

  private emit(notification?: RpcNotification): void {
    this.version += 1;
    this.snapshot = Object.freeze({
      version: this.version,
      threads: Object.freeze([...this.threads.values()]),
    });
    for (const listener of [...this.listeners]) {
      try {
        listener(this.snapshot, notification);
      } catch {
        // A rendering subscriber must not prevent later stream events or
        // other subscribers from receiving updates.
      }
    }
  }
}

const KNOWN_NON_STORE_NOTIFICATIONS = new Set([
  "account/updated",
  "account/login/completed",
  "account/rateLimits/updated",
  "serverRequest/resolved",
  "mcpServer/oauthLogin/completed",
  "configWarning",
  "deprecationNotice",
]);

function defaultWebSocketFactory(
  url: string,
  protocols?: string | string[],
): WebSocketLike {
  const WebSocketConstructor = (
    globalThis as unknown as {
      WebSocket?: new (url: string, protocols?: string | string[]) => WebSocketLike;
    }
  ).WebSocket;
  if (!WebSocketConstructor) {
    throw new Error("WebSocket is not available in this environment");
  }
  return protocols === undefined
    ? new WebSocketConstructor(url)
    : new WebSocketConstructor(url, protocols);
}

export class CodexAppServerClient {
  readonly store: ThreadStore;

  private readonly options: CodexAppServerClientOptions;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: RpcNotification) => void>();
  private readonly stateListeners = new Set<(state: CodexConnectionState) => void>();
  private socket: WebSocketLike | null = null;
  private stateValue: CodexConnectionState = "idle";
  private connectPromise: Promise<InitializeResponse> | null = null;
  private initializeResult: InitializeResponse | null = null;
  private nextRequestId = 1;

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.store = options.store ?? new ThreadStore();
  }

  get state(): CodexConnectionState {
    return this.stateValue;
  }

  get initialized(): InitializeResponse | null {
    return this.initializeResult;
  }

  onNotification(listener: (notification: RpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onStateChange(listener: (state: CodexConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  connect(): Promise<InitializeResponse> {
    if (this.stateValue === "ready" && this.initializeResult) {
      return Promise.resolve(this.initializeResult);
    }
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.performConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  disconnect(code = 1000, reason = "Client closed"): void {
    const socket = this.socket;
    this.socket = null;
    this.initializeResult = null;
    this.rejectPending(new CodexDisconnectedError("Codex app-server connection closed", code, reason));
    this.setState("closed");
    if (socket && socket.readyState < SOCKET_CLOSED) {
      socket.close(code, reason);
    }
  }

  close(code = 1000, reason = "Client closed"): void {
    this.disconnect(code, reason);
  }

  async request<R = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<R> {
    if (this.stateValue !== "ready") await this.connect();
    return this.sendRequest<R>(method, params, options?.timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    if (this.stateValue !== "ready") {
      throw new CodexDisconnectedError("Cannot send a notification before initialization");
    }
    this.sendNotification(method, params);
  }

  accountRead(params: AccountReadParams = {}): Promise<AccountReadResponse> {
    return this.request("account/read", params);
  }

  accountLoginStart(params: AccountLoginParams): Promise<AccountLoginResponse> {
    return this.request("account/login/start", params);
  }

  accountLogout(): Promise<Record<string, never>> {
    return this.request("account/logout");
  }

  modelList(params: ModelListParams = {}): Promise<ModelListResponse> {
    return this.request("model/list", params);
  }

  async threadStart(params: ThreadStartParams = {}): Promise<ThreadStartResponse> {
    const result = await this.request<ThreadStartResponse>("thread/start", params);
    if (result.thread) this.store.ingestThread(result.thread);
    return result;
  }

  async threadResume(
    params: string | ThreadResumeParams,
  ): Promise<ThreadResumeResponse> {
    const normalized = typeof params === "string" ? { threadId: params } : params;
    const result = await this.request<ThreadResumeResponse>("thread/resume", normalized);
    if (result.thread) this.store.ingestThread(result.thread);
    return result;
  }

  async threadList(params: ThreadListParams = {}): Promise<ThreadListResponse> {
    const result = await this.request<ThreadListResponse>("thread/list", params);
    if (Array.isArray(result.data)) this.store.ingestThreads(result.data);
    return result;
  }

  async threadRead(
    params: string | ThreadReadParams,
    includeTurns = true,
  ): Promise<ThreadReadResponse> {
    const normalized = typeof params === "string"
      ? { threadId: params, includeTurns }
      : params;
    const result = await this.request<ThreadReadResponse>("thread/read", normalized);
    if (result.thread) this.store.ingestThread(result.thread);
    return result;
  }

  async threadSetName(
    params: ThreadSetNameParams | string,
    name?: string,
  ): Promise<Record<string, never>> {
    const normalized = typeof params === "string"
      ? { threadId: params, name: name ?? "" }
      : params;
    const result = await this.request<Record<string, never>>(
      "thread/name/set",
      normalized,
    );
    this.store.setThreadName(normalized.threadId, normalized.name);
    return result;
  }

  turnStart(params: TurnStartParams): Promise<TurnStartResponse>;
  turnStart(
    threadId: string,
    input: string | CodexUserInput[],
    options?: Omit<TurnStartParams, "threadId" | "input">,
  ): Promise<TurnStartResponse>;
  async turnStart(
    paramsOrThreadId: TurnStartParams | string,
    input?: string | CodexUserInput[],
    options: Omit<TurnStartParams, "threadId" | "input"> = {},
  ): Promise<TurnStartResponse> {
    const params = typeof paramsOrThreadId === "string"
      ? {
          ...options,
          threadId: paramsOrThreadId,
          input: typeof input === "string" ? [textInput(input)] : (input ?? []),
        }
      : paramsOrThreadId;
    const result = await this.request<TurnStartResponse>("turn/start", params);
    if (result.turn) this.store.ingestTurn(params.threadId, result.turn);
    return result;
  }

  turnSteer(params: TurnSteerParams): Promise<TurnSteerResponse>;
  turnSteer(
    threadId: string,
    expectedTurnId: string,
    input: string | CodexUserInput[],
    options?: Omit<TurnSteerParams, "threadId" | "expectedTurnId" | "input">,
  ): Promise<TurnSteerResponse>;
  turnSteer(
    paramsOrThreadId: TurnSteerParams | string,
    expectedTurnId?: string,
    input?: string | CodexUserInput[],
    options: Omit<
      TurnSteerParams,
      "threadId" | "expectedTurnId" | "input"
    > = {},
  ): Promise<TurnSteerResponse> {
    const params = typeof paramsOrThreadId === "string"
      ? {
          ...options,
          threadId: paramsOrThreadId,
          expectedTurnId: expectedTurnId ?? "",
          input: typeof input === "string" ? [textInput(input)] : (input ?? []),
        }
      : paramsOrThreadId;
    return this.request("turn/steer", params);
  }

  turnInterrupt(
    params: TurnInterruptParams | string,
    turnId?: string,
  ): Promise<Record<string, never>> {
    const normalized = typeof params === "string"
      ? { threadId: params, turnId: turnId ?? "" }
      : params;
    return this.request("turn/interrupt", normalized);
  }

  // UI-friendly aliases matching the terminology used by IDE integrations.
  readAccount = this.accountRead.bind(this);
  startAccountLogin = this.accountLoginStart.bind(this);
  logoutAccount = this.accountLogout.bind(this);
  listModels = this.modelList.bind(this);
  startThread = this.threadStart.bind(this);
  resumeThread = this.threadResume.bind(this);
  listThreads = this.threadList.bind(this);
  readThread = this.threadRead.bind(this);
  setThreadName = this.threadSetName.bind(this);
  startTurn = this.turnStart.bind(this);
  steerTurn = this.turnSteer.bind(this);
  interruptTurn = this.turnInterrupt.bind(this);

  private async performConnect(): Promise<InitializeResponse> {
    this.setState("connecting");
    let socket: WebSocketLike;
    try {
      socket = this.webSocketFactory(this.options.url, this.options.protocols);
    } catch (error) {
      this.setState("disconnected");
      throw error;
    }
    this.socket = socket;
    this.attachSocket(socket);

    try {
      await this.waitForOpen(socket);
      if (this.socket !== socket) {
        throw new CodexDisconnectedError("Connection was replaced before initialization");
      }
      this.setState("initializing");
      const initializeParams = this.buildInitializeParams();
      const result = await this.sendRequest<InitializeResponse>(
        "initialize",
        initializeParams,
      );
      this.sendNotification("initialized", {});
      this.initializeResult = result;
      this.setState("ready");
      return result;
    } catch (error) {
      if (this.socket === socket) {
        this.socket = null;
        this.initializeResult = null;
        this.rejectPending(
          error instanceof Error
            ? error
            : new CodexDisconnectedError("Initialization failed"),
        );
        this.setState("disconnected");
        if (socket.readyState < SOCKET_CLOSING) {
          socket.close(1011, "Initialization failed");
        }
      }
      throw error;
    }
  }

  private buildInitializeParams(): InitializeParams {
    const clientInfo: ClientInfo = {
      name: "zotkit_zotero",
      title: "Zotkit",
      version: "0.2.3",
      ...this.options.clientInfo,
    };
    const capabilities = this.options.capabilities === null
      ? null
      : {
          experimentalApi: true,
          requestAttestation: false,
          ...this.options.capabilities,
        };
    return { clientInfo, capabilities };
  }

  private attachSocket(socket: WebSocketLike): void {
    socket.addEventListener("message", (event: { data?: unknown }) => {
      if (this.socket !== socket) return;
      this.handleMessage(event.data);
    });
    socket.addEventListener("close", (event: { code?: number; reason?: string }) => {
      if (this.socket !== socket) return;
      const code = event.code;
      const reason = event.reason;
      this.socket = null;
      this.initializeResult = null;
      this.rejectPending(
        new CodexDisconnectedError(
          reason
            ? `Codex app-server disconnected: ${reason}`
            : "Codex app-server disconnected",
          code,
          reason,
        ),
      );
      this.setState("disconnected");
    });
    socket.addEventListener("error", (event: unknown) => {
      if (this.socket === socket) this.options.onTransportError?.(event);
    });
  }

  private waitForOpen(socket: WebSocketLike): Promise<void> {
    if (socket.readyState === SOCKET_OPEN) return Promise.resolve();
    if (socket.readyState === SOCKET_CLOSING || socket.readyState === SOCKET_CLOSED) {
      return Promise.reject(new CodexDisconnectedError("WebSocket closed before opening"));
    }
    return new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onClose = (event: { code?: number; reason?: string }) => {
        cleanup();
        reject(
          new CodexDisconnectedError(
            "WebSocket closed before opening",
            event.code,
            event.reason,
          ),
        );
      };
      const onError = () => {
        cleanup();
        reject(new CodexDisconnectedError("WebSocket failed before opening"));
      };
      const cleanup = () => {
        socket.removeEventListener?.("open", onOpen);
        socket.removeEventListener?.("close", onClose);
        socket.removeEventListener?.("error", onError);
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);
    });
  }

  private sendRequest<R>(
    method: string,
    params?: unknown,
    timeoutOverride?: number,
  ): Promise<R> {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      return Promise.reject(new CodexDisconnectedError());
    }
    const id = this.nextRequestId++;
    const timeoutMs = timeoutOverride ?? this.options.requestTimeoutMs ?? 30_000;
    const message: UnknownRecord = { id, method };
    if (params !== undefined) message.params = params;

    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRequestTimeoutError(method, timeoutMs, id));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      throw new CodexDisconnectedError();
    }
    const message: UnknownRecord = { method };
    if (params !== undefined) message.params = params;
    socket.send(JSON.stringify(message));
  }

  private handleMessage(frame: unknown): void {
    if (typeof frame !== "string") {
      this.reportProtocolError(
        new Error("Codex app-server WebSocket frames must contain text JSON"),
        frame,
      );
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(frame);
    } catch {
      this.reportProtocolError(new Error("Invalid JSON from Codex app-server"), frame);
      return;
    }
    if (!isRecord(message)) {
      this.reportProtocolError(new Error("Invalid Codex app-server message"), message);
      return;
    }

    if (typeof message.method === "string" && isRpcId(message.id)) {
      void this.handleServerRequest(message.id, message.method, message.params);
      return;
    }
    if (isRpcId(message.id)) {
      this.handleResponse(message);
      return;
    }
    if (typeof message.method === "string") {
      this.handleNotification({ method: message.method, params: message.params });
      return;
    }
    this.reportProtocolError(new Error("Unrecognized Codex app-server message"), message);
  }

  private handleResponse(message: UnknownRecord): void {
    const id = message.id as RpcId;
    const pending = this.pending.get(id);
    if (!pending) {
      this.reportProtocolError(new Error(`Response for unknown request id ${String(id)}`), message);
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (isRecord(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : -32603;
      const errorMessage = typeof message.error.message === "string"
        ? message.error.message
        : "Unknown Codex app-server error";
      pending.reject(
        new CodexRpcError(
          { code, message: errorMessage, data: message.error.data },
          pending.method,
          id,
        ),
      );
      return;
    }
    if (!("result" in message)) {
      pending.reject(new Error("Codex app-server response has neither result nor error"));
      return;
    }
    pending.resolve(message.result);
  }

  private handleNotification(notification: RpcNotification): void {
    const stored = this.store.applyNotification(notification);
    this.invokeSafely(() => this.options.onNotification?.(notification));
    for (const listener of [...this.notificationListeners]) {
      this.invokeSafely(() => listener(notification));
    }
    if (!stored && !KNOWN_NON_STORE_NOTIFICATIONS.has(notification.method)) {
      this.invokeSafely(() => this.options.onUnknownNotification?.(notification));
    }
  }

  private async handleServerRequest(
    id: RpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    try {
      let result: unknown;
      switch (method) {
        case "item/commandExecution/requestApproval": {
          const typed = params as CommandApprovalParams;
          const generic: ApprovalRequest = {
            kind: "commandExecution",
            method,
            params: typed,
          };
          const handler = this.options.handlers?.commandApproval;
          if (handler) result = await handler(typed);
          else if (this.options.onApproval) result = await this.options.onApproval(generic);
          else throw new CodexServerRequestError(-32601, `No handler for ${method}`);
          break;
        }
        case "item/fileChange/requestApproval": {
          const typed = params as FileChangeApprovalParams;
          const generic: ApprovalRequest = { kind: "fileChange", method, params: typed };
          const handler = this.options.handlers?.fileChangeApproval;
          if (handler) result = await handler(typed);
          else if (this.options.onApproval) result = await this.options.onApproval(generic);
          else throw new CodexServerRequestError(-32601, `No handler for ${method}`);
          break;
        }
        case "item/permissions/requestApproval": {
          const typed = params as PermissionsApprovalParams;
          const generic: ApprovalRequest = { kind: "permissions", method, params: typed };
          const handler = this.options.handlers?.permissionsApproval;
          if (handler) result = await handler(typed);
          else if (this.options.onApproval) result = await this.options.onApproval(generic);
          else throw new CodexServerRequestError(-32601, `No handler for ${method}`);
          break;
        }
        case "item/tool/call": {
          const handler = this.options.handlers?.dynamicToolCall;
          if (!handler) throw new CodexServerRequestError(-32601, `No handler for ${method}`);
          result = await handler(params as DynamicToolCallParams);
          break;
        }
        default: {
          const handler = this.options.handlers?.unknownRequest;
          if (!handler) throw new CodexServerRequestError(-32601, `Unknown method: ${method}`);
          result = await handler(method, params);
        }
      }
      this.sendServerResponse(id, { result });
    } catch (error) {
      const rpcError = error instanceof CodexServerRequestError
        ? { code: error.code, message: error.message, data: error.data }
        : {
            code: -32603,
            message: error instanceof Error ? error.message : "Server request handler failed",
          };
      this.sendServerResponse(id, { error: rpcError });
    }
  }

  private sendServerResponse(
    id: RpcId,
    payload: { result: unknown } | { error: RpcErrorObject },
  ): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return;
    socket.send(JSON.stringify({ id, ...payload }));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private setState(state: CodexConnectionState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.invokeSafely(() => this.options.onStateChange?.(state));
    for (const listener of [...this.stateListeners]) {
      this.invokeSafely(() => listener(state));
    }
  }

  private invokeSafely(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.reportProtocolError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private reportProtocolError(error: Error, frame?: unknown): void {
    try {
      this.options.onProtocolError?.(error, frame);
    } catch {
      // Protocol diagnostics must never break transport routing.
    }
  }
}
