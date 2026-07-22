/**
 * Small, browser-safe protocol surface for the Codex app-server methods used by
 * ZoteroChat. The app-server wire format follows JSON-RPC 2.0 semantics but,
 * per the Codex protocol, omits the `jsonrpc` member from WebSocket frames.
 */

export type RpcId = number | string;

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcRequest<P = unknown> {
  id: RpcId;
  method: string;
  params?: P;
}

export interface RpcNotification<P = unknown> {
  method: string;
  params?: P;
}

export type RpcResponse<R = unknown> =
  | { id: RpcId; result: R }
  | { id: RpcId; error: RpcErrorObject };

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
}

export type WebSocketFactory = (
  url: string,
  protocols?: string | string[],
) => WebSocketLike;

export interface ClientInfo {
  name: string;
  title: string;
  version: string;
}

export interface InitializeCapabilities {
  experimentalApi: boolean;
  requestAttestation: boolean;
  mcpServerOpenaiFormElicitation?: boolean;
  optOutNotificationMethods?: string[] | null;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
  [key: string]: unknown;
}

export interface AccountReadParams {
  refreshToken?: boolean;
}

export interface AccountReadResponse {
  account: Record<string, unknown> | null;
  requiresOpenaiAuth: boolean;
}

export type AccountLoginParams =
  | { type: "apiKey"; apiKey: string }
  | {
      type: "chatgpt";
      codexStreamlinedLogin?: boolean;
      useHostedLoginSuccessPage?: boolean;
      appBrand?: Record<string, unknown> | null;
    }
  | { type: "chatgptDeviceCode" }
  | {
      type: "chatgptAuthTokens";
      accessToken: string;
      chatgptAccountId: string;
      chatgptPlanType?: string | null;
    };

export type AccountLoginResponse =
  | { type: "apiKey" }
  | { type: "chatgpt"; loginId: string; authUrl: string }
  | {
      type: "chatgptDeviceCode";
      loginId: string;
      verificationUrl: string;
      userCode: string;
    }
  | { type: "chatgptAuthTokens" };

export interface ModelListParams {
  cursor?: string | null;
  limit?: number | null;
  includeHidden?: boolean | null;
}

export interface ModelListResponse {
  data: Array<Record<string, unknown>>;
  nextCursor: string | null;
}

export type AskForApproval =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never"
  | Record<string, unknown>;

export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access"
  | Record<string, unknown>;

export interface ThreadStartParams {
  model?: string | null;
  modelProvider?: string | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: unknown;
  sandbox?: SandboxMode | null;
  permissions?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: string | null;
  ephemeral?: boolean | null;
  dynamicTools?: Array<Record<string, unknown>> | null;
  [key: string]: unknown;
}

export interface ThreadResumeParams extends ThreadStartParams {
  threadId: string;
  excludeTurns?: boolean;
}

export interface ThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: string | null;
  sortDirection?: string | null;
  modelProviders?: string[] | null;
  sourceKinds?: string[] | null;
  archived?: boolean | null;
  cwd?: string | string[] | null;
  useStateDbOnly?: boolean;
  searchTerm?: string | null;
  parentThreadId?: string | null;
  ancestorThreadId?: string | null;
}

export interface ThreadReadParams {
  threadId: string;
  includeTurns?: boolean;
}

export interface ThreadSetNameParams {
  threadId: string;
  name: string;
}

export type CodexUserInput =
  | { type: "text"; text: string; text_elements: unknown[] }
  | { type: "image"; url: string; detail?: string }
  | { type: "localImage"; path: string; detail?: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export interface TurnStartParams {
  threadId: string;
  clientUserMessageId?: string | null;
  input: CodexUserInput[];
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: unknown;
  sandboxPolicy?: unknown;
  permissions?: string | null;
  model?: string | null;
  serviceTier?: string | null;
  effort?: string | null;
  summary?: string | null;
  personality?: string | null;
  additionalContext?: Record<string, unknown> | null;
  responsesapiClientMetadata?: Record<string, string> | null;
  [key: string]: unknown;
}

export interface TurnSteerParams {
  threadId: string;
  expectedTurnId: string;
  clientUserMessageId?: string | null;
  input: CodexUserInput[];
  additionalContext?: Record<string, unknown> | null;
  responsesapiClientMetadata?: Record<string, string> | null;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface ProtocolThreadItem {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface ProtocolTurn {
  id: string;
  items?: ProtocolThreadItem[];
  status?: unknown;
  error?: unknown;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  [key: string]: unknown;
}

export interface ProtocolThread {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  status?: unknown;
  turns?: ProtocolTurn[];
  [key: string]: unknown;
}

export interface ThreadStartResponse {
  thread: ProtocolThread;
  [key: string]: unknown;
}

export interface ThreadResumeResponse extends ThreadStartResponse {}

export interface ThreadListResponse {
  data: ProtocolThread[];
  nextCursor: string | null;
  backwardsCursor?: string | null;
}

export interface ThreadReadResponse {
  thread: ProtocolThread;
}

export interface TurnStartResponse {
  turn: ProtocolTurn;
}

export interface TurnSteerResponse {
  turnId: string;
}

export type CommandApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | Record<string, unknown>;

export interface CommandApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  approvalId?: string | null;
  environmentId?: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  availableDecisions?: CommandApprovalDecision[] | null;
  [key: string]: unknown;
}

export interface FileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  reason?: string | null;
  grantRoot?: string | null;
}

export interface PermissionsApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  environmentId: string | null;
  cwd: string;
  reason: string | null;
  permissions: Record<string, unknown>;
}

export type ApprovalRequest =
  | {
      kind: "commandExecution";
      method: "item/commandExecution/requestApproval";
      params: CommandApprovalParams;
    }
  | {
      kind: "fileChange";
      method: "item/fileChange/requestApproval";
      params: FileChangeApprovalParams;
    }
  | {
      kind: "permissions";
      method: "item/permissions/requestApproval";
      params: PermissionsApprovalParams;
    };

export type ApprovalResponse =
  | { decision: CommandApprovalDecision }
  | {
      permissions: Record<string, unknown>;
      scope: unknown;
      strictAutoReview?: boolean;
    };

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

export type DynamicToolContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };

export interface DynamicToolCallResponse {
  contentItems: DynamicToolContentItem[];
  success: boolean;
}

export interface StoredItem extends ProtocolThreadItem {
  id: string;
  lifecycle?: "started" | "completed";
  startedAtMs?: number;
  completedAtMs?: number;
  progress?: string[];
  events?: Array<{ method: string; params: unknown }>;
}

export interface StoredTurn extends Omit<ProtocolTurn, "items"> {
  items: StoredItem[];
  events?: Array<{ method: string; params: unknown }>;
}

export interface StoredThread extends Omit<ProtocolThread, "turns"> {
  turns: StoredTurn[];
}

export interface ThreadStoreSnapshot {
  version: number;
  threads: readonly StoredThread[];
}
