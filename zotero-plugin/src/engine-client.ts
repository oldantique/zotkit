import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  ModelListResponse,
  RpcNotification,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
} from "./codex-app-server";
import { ThreadStore } from "./codex-app-server";
import { ENGINE_CAPABILITIES, type AgentClient } from "./agent-client";
import { streamRequest } from "./http-stream";
import { OpenAIWire } from "./wire-openai";
import type { WireAdapter, WireMessage, WireToolCall, WireToolSpec } from "./wire";
import type { ProviderProfile } from "./providers";
import { connectivityError } from "./providers";
import {
  DEFAULT_CONTEXT_WINDOW,
  buildTurnMessages,
  engineModelId,
  resolveEngineModel,
  type EngineHistoryMessage,
} from "./engine-messages";
import { profilePath, randomID } from "./platform";

export interface EngineTranscriptStorage {
  read(threadId: string): Promise<string | null>;
  write(threadId: string, content: string): Promise<void>;
}

export interface EngineClientOptions {
  store: ThreadStore;
  providers(): ProviderProfile[];
  readKey(providerId: string): Promise<string | null>;
  handlers?: {
    dynamicToolCall?: (params: DynamicToolCallParams) =>
      DynamicToolCallResponse | Promise<DynamicToolCallResponse>;
  };
  onNotification?: (notification: RpcNotification) => void;
  streamImpl?: typeof streamRequest;
  wireAdapters?: Partial<Record<"openai" | "anthropic", WireAdapter>>;
  storage?: EngineTranscriptStorage;
  now?: () => number;
}

const MAX_TOOL_ITERATIONS = 8;

interface EngineThreadState {
  id: string;
  name: string | null;
  createdAt: string;
  history: EngineHistoryMessage[];
  dynamicTools: WireToolSpec[];
  developerInstructions: string | null;
  turnCount: number;
  activeAbort: AbortController | null;
}

class EngineTurnError extends Error {}

/**
 * In-process AgentClient: drives OpenAI/Anthropic-compatible endpoints
 * directly and synthesizes the same ThreadStore notifications the codex
 * app-server client produces, so every downstream consumer (entries
 * rendering, utility-turn waiters, paper trail, noting) works unchanged.
 */
export class EngineClient implements AgentClient {
  readonly agentCapabilities = ENGINE_CAPABILITIES;

  private readonly store: ThreadStore;
  private readonly options: EngineClientOptions;
  private readonly threads = new Map<string, EngineThreadState>();
  private readonly storage: EngineTranscriptStorage;
  private readonly stream: typeof streamRequest;

  constructor(options: EngineClientOptions) {
    this.options = options;
    this.store = options.store;
    this.storage = options.storage ?? defaultStorage();
    this.stream = options.streamImpl ?? streamRequest;
  }

  connect(): Promise<unknown> {
    return Promise.resolve({});
  }

  close(): void {
    for (const thread of this.threads.values()) {
      thread.activeAbort?.abort();
      thread.activeAbort = null;
    }
  }

  accountRead(): Promise<{ account: Record<string, unknown> | null; requiresOpenaiAuth: boolean }> {
    return Promise.resolve({ account: null, requiresOpenaiAuth: false });
  }

  modelList(): Promise<ModelListResponse> {
    const providers = this.options.providers();
    const data = providers.flatMap((provider, providerIndex) =>
      provider.models.map((model) => ({
        id: engineModelId(provider.id, model.id),
        displayName: `${provider.name} · ${model.label}`,
        supportedReasoningEfforts: model.supportsReasoningEffort
          ? [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }]
          : [],
        isDefault: providerIndex === 0 && model.id === provider.defaultModel,
      })),
    );
    return Promise.resolve({ data, nextCursor: null } as ModelListResponse);
  }

  async threadStart(params: ThreadStartParams = {}): Promise<ThreadStartResponse> {
    const id = randomID("eng").slice(0, 48);
    const thread: EngineThreadState = {
      id,
      name: null,
      createdAt: new Date().toISOString(),
      history: [],
      dynamicTools: normalizeToolSpecs(params.dynamicTools),
      developerInstructions: typeof params.developerInstructions === "string"
        ? params.developerInstructions
        : null,
      turnCount: 0,
      activeAbort: null,
    };
    this.threads.set(id, thread);
    this.store.ingestThread({ id, turns: [] });
    await this.persist(thread);
    return { thread: { id } } as ThreadStartResponse;
  }

  async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    const thread = this.threads.get(params.threadId) ?? await this.loadThread(params.threadId);
    if (!thread) throw new Error("找不到这个引擎会话");
    const tools = normalizeToolSpecs(params.dynamicTools);
    if (tools.length) thread.dynamicTools = tools;
    if (typeof params.developerInstructions === "string") {
      thread.developerInstructions = params.developerInstructions;
    }
    this.ingestHistory(thread);
    return { thread: { id: thread.id } } as ThreadResumeResponse;
  }

  async threadRead(threadId: string): Promise<ThreadReadResponse> {
    const thread = this.threads.get(threadId) ?? await this.loadThread(threadId);
    if (!thread) throw new Error("找不到这个引擎会话");
    this.ingestHistory(thread);
    return { thread: this.store.getThread(threadId) } as unknown as ThreadReadResponse;
  }

  async threadSetName(threadId: string, name: string): Promise<Record<string, never>> {
    const thread = this.threads.get(threadId) ?? await this.loadThread(threadId);
    if (thread) {
      thread.name = name;
      this.store.setThreadName(threadId, name);
      await this.persist(thread);
    }
    return {};
  }

  async turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
    const thread = this.threads.get(params.threadId) ?? await this.loadThread(params.threadId);
    if (!thread) throw new Error("找不到这个引擎会话");
    if (thread.activeAbort) throw new Error("当前回答尚未结束");
    const userText = extractUserText(params.input);
    const turnId = `${thread.id}:turn:${thread.turnCount + 1}`;
    const abort = new AbortController();
    thread.activeAbort = abort;
    void this.runTurn(thread, turnId, userText, params, abort)
      .catch(() => { /* runTurn reports via notifications */ })
      .finally(() => {
        if (thread.activeAbort === abort) thread.activeAbort = null;
      });
    return { turn: { id: turnId } } as TurnStartResponse;
  }

  turnInterrupt(params: TurnInterruptParams): Promise<Record<string, never>> {
    this.threads.get(params.threadId)?.activeAbort?.abort();
    return Promise.resolve({});
  }

  /** Seeds a new thread with migrated history (backend switch carry-over). */
  async importThread(name: string, messages: EngineHistoryMessage[]): Promise<string> {
    const started = await this.threadStart({});
    const thread = this.threads.get(started.thread.id)!;
    thread.name = name;
    thread.history = messages.filter((message) => message.text.trim());
    thread.turnCount = Math.ceil(thread.history.length / 2);
    this.ingestHistory(thread);
    this.store.setThreadName(thread.id, name);
    await this.persist(thread);
    return thread.id;
  }

  private async runTurn(
    thread: EngineThreadState,
    turnId: string,
    userText: string,
    params: TurnStartParams,
    abort: AbortController,
  ): Promise<void> {
    const threadId = thread.id;
    this.notify("turn/started", {
      threadId,
      turn: { id: turnId, threadId, status: "inProgress", items: [] },
    });
    this.notify("item/completed", {
      threadId,
      turnId,
      item: {
        id: `${turnId}:user`,
        type: "userMessage",
        content: [{ type: "text", text: userText }],
      },
      completedAtMs: this.now(),
    });
    let finalText = "";
    let lastItemId = "";
    try {
      const providers = this.options.providers();
      const { provider, model } = resolveEngineModel(params.model ?? null, providers);
      const apiKey = await this.options.readKey(provider.id);
      if (!apiKey) {
        throw new EngineTurnError(`模型服务 ${provider.name} 还没有保存 API key，请在设置中填写`);
      }
      const wire = this.wireFor(provider);
      const baseMessages = buildTurnMessages({
        developerInstructions: thread.developerInstructions,
        history: thread.history,
        additionalContext: params.additionalContext,
        userText,
        contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      });
      const effort = model.supportsReasoningEffort && typeof params.effort === "string"
        ? params.effort
        : null;
      const exchange: WireMessage[] = [];
      for (let iteration = 1; ; iteration += 1) {
        const itemId = `${turnId}:assistant:${iteration}`;
        lastItemId = itemId;
        this.notify("item/started", {
          threadId,
          turnId,
          item: { id: itemId, type: "agentMessage", text: "" },
          startedAtMs: this.now(),
        });
        const request = wire.buildRequest(
          provider.baseUrl,
          apiKey,
          [...baseMessages, ...exchange],
          thread.dynamicTools,
          { model: model.id, effort },
        );
        const parser = wire.createParser();
        let text = "";
        let toolCalls: WireToolCall[] | null = null;
        let streamError: string | null = null;
        const handleEvents = (events: ReturnType<typeof parser.push>) => {
          for (const event of events) {
            if (event.type === "textDelta") {
              text += event.delta;
              finalText = text;
              this.notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: event.delta });
            }
            else if (event.type === "toolCalls") toolCalls = event.calls;
            else if (event.type === "error") streamError = event.message;
          }
        };
        const result = await this.stream({
          url: request.url,
          headers: request.headers,
          body: request.body,
          signal: abort.signal,
          onChunk: (chunk) => handleEvents(parser.push(chunk)),
        });
        handleEvents(parser.end());
        if (streamError) throw new EngineTurnError(streamError);
        if (!result.ok) throw new EngineTurnError(connectivityError(result));
        this.notify("item/completed", {
          threadId,
          turnId,
          item: { id: itemId, type: "agentMessage", text },
          completedAtMs: this.now(),
        });
        const calls = toolCalls as WireToolCall[] | null;
        if (!calls || !calls.length) {
          finalText = text;
          break;
        }
        if (iteration >= MAX_TOOL_ITERATIONS) {
          throw new EngineTurnError(`工具调用次数超限（${MAX_TOOL_ITERATIONS} 次），已停止本轮`);
        }
        exchange.push({ role: "assistant", text, toolCalls: calls });
        for (const [position, call] of calls.entries()) {
          const resultText = await this.invokeTool(thread, turnId, iteration, position, call);
          exchange.push({ role: "tool", text: resultText, toolCallId: call.id });
        }
      }
      thread.history = [
        ...thread.history,
        { role: "user", text: userText },
        { role: "assistant", text: finalText },
      ];
      thread.turnCount += 1;
      await this.persist(thread);
      this.notify("turn/completed", {
        threadId,
        turn: { id: turnId, threadId, status: "completed" },
      });
    }
    catch (error) {
      if ((error as Error)?.name === "AbortError") {
        thread.history = [
          ...thread.history,
          { role: "user", text: userText },
          { role: "assistant", text: finalText },
        ];
        thread.turnCount += 1;
        await this.persist(thread);
        if (lastItemId) {
          this.notify("item/completed", {
            threadId,
            turnId,
            item: { id: lastItemId, type: "agentMessage", text: finalText },
            completedAtMs: this.now(),
          });
        }
        this.notify("turn/completed", {
          threadId,
          turn: { id: turnId, threadId, status: "completed" },
        });
        return;
      }
      const message = error instanceof Error && error.message
        ? error.message
        : "模型服务调用失败，请重试";
      this.notify("error", { threadId, turnId, error: { message }, willRetry: false });
      this.notify("turn/failed", {
        threadId,
        turnId,
        turn: { id: turnId, threadId },
        error: { message },
      });
    }
  }

  private async invokeTool(
    thread: EngineThreadState,
    turnId: string,
    iteration: number,
    position: number,
    call: WireToolCall,
  ): Promise<string> {
    const threadId = thread.id;
    const itemId = `${turnId}:tool:${iteration}:${position}`;
    let argumentsValue: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(call.argumentsJson || "{}") as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        argumentsValue = parsed as Record<string, unknown>;
      }
    }
    catch { /* malformed arguments fall through as {} */ }
    this.notify("item/started", {
      threadId,
      turnId,
      item: { id: itemId, type: "dynamicToolCall", tool: call.name, arguments: argumentsValue },
      startedAtMs: this.now(),
    });
    const handler = this.options.handlers?.dynamicToolCall;
    const response: DynamicToolCallResponse = handler
      ? await handler({
          threadId,
          turnId,
          callId: call.id,
          namespace: null,
          tool: call.name,
          arguments: argumentsValue,
        })
      : { success: false, contentItems: [{ type: "inputText", text: "没有可用的工具执行器" }] };
    const resultText = response.contentItems
      .map((item) => (item.type === "inputText" ? item.text : ""))
      .filter(Boolean)
      .join("\n") || "（无输出）";
    this.notify("item/completed", {
      threadId,
      turnId,
      item: {
        id: itemId,
        type: "dynamicToolCall",
        tool: call.name,
        arguments: argumentsValue,
        progress: [resultText.slice(0, 2000)],
      },
      completedAtMs: this.now(),
    });
    return resultText;
  }

  private wireFor(provider: ProviderProfile): WireAdapter {
    const custom = this.options.wireAdapters?.[provider.wire];
    if (custom) return custom;
    if (provider.wire === "openai") return new OpenAIWire();
    throw new EngineTurnError("Anthropic 兼容接入将在后续版本提供");
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const notification = { method, params } as RpcNotification;
    this.store.applyNotification(notification);
    this.options.onNotification?.(notification);
  }

  private ingestHistory(thread: EngineThreadState): void {
    const turns = [];
    for (let index = 0; index < thread.history.length; index += 2) {
      const user = thread.history[index];
      const assistant = thread.history[index + 1];
      const turnId = `${thread.id}:turn:${index / 2 + 1}`;
      const items = [];
      if (user) {
        items.push({
          id: `${turnId}:user`,
          type: "userMessage",
          content: [{ type: "text", text: user.text }],
        });
      }
      if (assistant) {
        items.push({ id: `${turnId}:assistant:1`, type: "agentMessage", text: assistant.text });
      }
      turns.push({ id: turnId, status: "completed", items });
    }
    this.store.replaceThread({ id: thread.id, name: thread.name, turns } as never);
  }

  private async loadThread(threadId: string): Promise<EngineThreadState | null> {
    const content = await this.storage.read(threadId).catch(() => null);
    if (!content) return null;
    const thread: EngineThreadState = {
      id: threadId,
      name: null,
      createdAt: new Date().toISOString(),
      history: [],
      dynamicTools: [],
      developerInstructions: null,
      turnCount: 0,
      activeAbort: null,
    };
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as Record<string, unknown>;
        if (record.kind === "meta") {
          if (typeof record.name === "string") thread.name = record.name;
          if (typeof record.createdAt === "string") thread.createdAt = record.createdAt;
        }
        else if (
          record.kind === "message"
          && (record.role === "user" || record.role === "assistant")
          && typeof record.text === "string"
        ) {
          thread.history.push({ role: record.role, text: record.text });
        }
      }
      catch { /* skip corrupt lines */ }
    }
    thread.turnCount = Math.ceil(thread.history.length / 2);
    this.threads.set(threadId, thread);
    return thread;
  }

  private async persist(thread: EngineThreadState): Promise<void> {
    const lines = [
      JSON.stringify({
        kind: "meta",
        version: 1,
        name: thread.name,
        createdAt: thread.createdAt,
      }),
      ...thread.history.map((message) => JSON.stringify({
        kind: "message",
        role: message.role,
        text: message.text,
      })),
    ];
    await this.storage.write(thread.id, `${lines.join("\n")}\n`).catch(() => {
      // Persistence is best-effort: a failed write must not fail the turn.
    });
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}

function normalizeToolSpecs(raw: unknown): WireToolSpec[] {
  if (!Array.isArray(raw)) return [];
  const specs: WireToolSpec[] = [];
  for (const value of raw) {
    const record = value as Record<string, unknown>;
    if (typeof record?.name !== "string") continue;
    specs.push({
      name: record.name,
      description: typeof record.description === "string" ? record.description : "",
      inputSchema: (record.inputSchema && typeof record.inputSchema === "object")
        ? record.inputSchema as Record<string, unknown>
        : { type: "object" },
    });
  }
  return specs;
}

function extractUserText(input: unknown): string {
  if (!Array.isArray(input)) return "";
  return input
    .map((item) => {
      const record = item as Record<string, unknown>;
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function defaultStorage(): EngineTranscriptStorage {
  const pathFor = (threadId: string) => profilePath("engine-threads", `${threadId}.jsonl`);
  return {
    async read(threadId) {
      try {
        return await IOUtils.readUTF8(pathFor(threadId));
      }
      catch {
        return null;
      }
    },
    async write(threadId, content) {
      await IOUtils.makeDirectory(profilePath("engine-threads"), {
        createAncestors: true,
        ignoreExisting: true,
        permissions: 0o700,
      });
      await IOUtils.writeUTF8(pathFor(threadId), content, { tmpPath: `${pathFor(threadId)}.tmp` });
    },
  };
}
