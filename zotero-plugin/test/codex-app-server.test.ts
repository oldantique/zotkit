import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexAppServerClient,
  CodexDisconnectedError,
  CodexRequestTimeoutError,
  CodexRpcError,
  ThreadStore,
  type RpcNotification,
  type WebSocketLike,
} from "../src/codex-app-server";

class MockWebSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  addEventListener(type: string, listener: (event: any) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch("close", { code: code ?? 1000, reason: reason ?? "" });
  }

  open(): void {
    this.readyState = 1;
    this.dispatch("open", {});
  }

  receive(message: unknown): void {
    this.dispatch("message", { data: JSON.stringify(message) });
  }

  receiveRaw(data: unknown): void {
    this.dispatch("message", { data });
  }

  serverClose(code = 1006, reason = "connection lost"): void {
    this.readyState = 3;
    this.dispatch("close", { code, reason });
  }

  parsed(index: number): Record<string, unknown> {
    return JSON.parse(this.sent[index]!) as Record<string, unknown>;
  }

  last(): Record<string, unknown> {
    return this.parsed(this.sent.length - 1);
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

const initializeResult = {
  userAgent: "codex-test",
  codexHome: "/tmp/codex-home",
  platformFamily: "unix",
  platformOs: "macos",
};

async function connectedClient(
  overrides: Partial<ConstructorParameters<typeof CodexAppServerClient>[0]> = {},
): Promise<{ client: CodexAppServerClient; socket: MockWebSocket }> {
  const socket = new MockWebSocket();
  const client = new CodexAppServerClient({
    url: "ws://127.0.0.1:4500",
    webSocketFactory: () => socket,
    ...overrides,
  });
  const connecting = client.connect();
  socket.open();
  await Promise.resolve();
  const initialize = socket.last();
  expect(initialize.method).toBe("initialize");
  socket.receive({ id: initialize.id, result: initializeResult });
  await connecting;
  return { client, socket };
}

async function flushAsyncHandlers(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CodexAppServerClient transport", () => {
  it("opens, initializes exactly once, and acknowledges initialized", async () => {
    const socket = new MockWebSocket();
    const states: string[] = [];
    const client = new CodexAppServerClient({
      url: "ws://127.0.0.1:4500",
      webSocketFactory: () => socket,
      clientInfo: { version: "1.2.3" },
      onStateChange: (state) => states.push(state),
    });

    const connecting = client.connect();
    expect(client.state).toBe("connecting");
    socket.open();
    await Promise.resolve();

    expect(socket.sent).toHaveLength(1);
    const initialize = socket.parsed(0);
    expect(initialize).toMatchObject({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "zotkit_zotero",
          title: "Zotkit",
          version: "1.2.3",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    });
    expect(initialize).not.toHaveProperty("jsonrpc");

    socket.receive({ id: 1, result: initializeResult });
    await expect(connecting).resolves.toEqual(initializeResult);
    expect(socket.parsed(1)).toEqual({ method: "initialized", params: {} });
    expect(client.state).toBe("ready");
    expect(states).toEqual(["connecting", "initializing", "ready"]);

    await expect(client.connect()).resolves.toEqual(initializeResult);
    expect(socket.sent).toHaveLength(2);
  });

  it("routes results and structured JSON-RPC errors by request id", async () => {
    const { client, socket } = await connectedClient();

    const accountPromise = client.accountRead({ refreshToken: true });
    const accountRequest = socket.last();
    expect(accountRequest).toMatchObject({
      method: "account/read",
      params: { refreshToken: true },
    });
    socket.receive({
      id: accountRequest.id,
      result: { account: { email: "reader@example.test" }, requiresOpenaiAuth: true },
    });
    await expect(accountPromise).resolves.toMatchObject({ requiresOpenaiAuth: true });

    const modelsPromise = client.modelList({ includeHidden: false });
    const modelsRequest = socket.last();
    socket.receive({
      id: modelsRequest.id,
      error: { code: -32001, message: "Server overloaded; retry later.", data: { retry: true } },
    });
    const error = await modelsPromise.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CodexRpcError);
    expect(error).toMatchObject({
      code: -32001,
      method: "model/list",
      data: { retry: true },
    });
  });

  it("times out a request and ignores a late result", async () => {
    const protocolError = vi.fn();
    const { client, socket } = await connectedClient({ onProtocolError: protocolError });
    vi.useFakeTimers();

    const promise = client.request("model/list", {}, { timeoutMs: 25 });
    const request = socket.last();
    const rejection = expect(promise).rejects.toBeInstanceOf(CodexRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    socket.receive({ id: request.id, result: { data: [], nextCursor: null } });
    expect(protocolError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("unknown request id") }),
      expect.anything(),
    );
  });

  it("rejects all in-flight requests when the socket disconnects", async () => {
    const { client, socket } = await connectedClient();
    const pending = client.threadList();
    const rejection = pending.catch((error: unknown) => error);

    socket.serverClose(1006, "bridge stopped");
    const error = await rejection;
    expect(error).toBeInstanceOf(CodexDisconnectedError);
    expect(error).toMatchObject({ code: 1006, reason: "bridge stopped" });
    expect(client.state).toBe("disconnected");
  });

  it("surfaces unknown notifications and malformed frames without breaking routing", async () => {
    const unknown = vi.fn();
    const all = vi.fn();
    const protocolError = vi.fn();
    const { client, socket } = await connectedClient({
      onUnknownNotification: unknown,
      onProtocolError: protocolError,
    });
    client.onNotification(all);

    socket.receive({ method: "future/newEvent", params: { value: 7 } });
    expect(all).toHaveBeenCalledWith({ method: "future/newEvent", params: { value: 7 } });
    expect(unknown).toHaveBeenCalledWith({
      method: "future/newEvent",
      params: { value: 7 },
    });

    socket.receiveRaw("not json");
    socket.receiveRaw(new Uint8Array([1, 2, 3]));
    expect(protocolError).toHaveBeenCalledTimes(2);

    const request = client.modelList();
    const frame = socket.last();
    socket.receive({ id: frame.id, result: { data: [], nextCursor: null } });
    await expect(request).resolves.toEqual({ data: [], nextCursor: null });
  });
});

describe("Codex protocol convenience API", () => {
  it("uses the v2 method names and hydrates the thread store", async () => {
    const { client, socket } = await connectedClient();

    const login = client.accountLoginStart({ type: "chatgpt" });
    let request = socket.last();
    expect(request.method).toBe("account/login/start");
    socket.receive({
      id: request.id,
      result: { type: "chatgpt", loginId: "login-1", authUrl: "https://example.test/login" },
    });
    await login;

    const start = client.threadStart({
      cwd: "/Users/test/Documents/chancezotero",
      runtimeWorkspaceRoots: ["/Users/test/Documents/chancezotero"],
      sandbox: "read-only",
    });
    request = socket.last();
    expect(request.method).toBe("thread/start");
    socket.receive({
      id: request.id,
      result: { thread: { id: "thread-1", name: null, turns: [] }, model: "gpt-test" },
    });
    await start;
    expect(client.store.getThread("thread-1")).toBeDefined();

    const turn = client.turnStart("thread-1", "Summarize the current paper.");
    request = socket.last();
    expect(request).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [
          { type: "text", text: "Summarize the current paper.", text_elements: [] },
        ],
      },
    });
    socket.receive({
      id: request.id,
      result: { turn: { id: "turn-1", items: [], status: "inProgress" } },
    });
    await turn;

    const steer = client.turnSteer(
      "thread-1",
      "turn-1",
      "Focus on the theorem assumptions.",
    );
    request = socket.last();
    expect(request.method).toBe("turn/steer");
    expect(request.params).toMatchObject({ expectedTurnId: "turn-1" });
    socket.receive({ id: request.id, result: { turnId: "turn-1" } });
    await steer;

    const interrupt = client.turnInterrupt("thread-1", "turn-1");
    request = socket.last();
    expect(request.method).toBe("turn/interrupt");
    socket.receive({ id: request.id, result: {} });
    await interrupt;

    const rename = client.threadSetName("thread-1", "Paper discussion");
    request = socket.last();
    expect(request.method).toBe("thread/name/set");
    socket.receive({ id: request.id, result: {} });
    await rename;
    expect(client.store.getThread("thread-1")?.name).toBe("Paper discussion");

    const logout = client.accountLogout();
    request = socket.last();
    expect(request).toEqual(expect.objectContaining({ method: "account/logout" }));
    expect(request).not.toHaveProperty("params");
    socket.receive({ id: request.id, result: {} });
    await logout;
  });

  it("supports resume, list, and read responses", async () => {
    const { client, socket } = await connectedClient();

    const resume = client.threadResume("thread-r");
    let request = socket.last();
    expect(request).toMatchObject({ method: "thread/resume", params: { threadId: "thread-r" } });
    socket.receive({
      id: request.id,
      result: { thread: { id: "thread-r", turns: [] } },
    });
    await resume;

    const list = client.threadList({ limit: 10 });
    request = socket.last();
    expect(request.method).toBe("thread/list");
    socket.receive({
      id: request.id,
      result: {
        data: [{ id: "thread-l", preview: "Listed", turns: [] }],
        nextCursor: null,
        backwardsCursor: null,
      },
    });
    await list;

    const read = client.threadRead("thread-l");
    request = socket.last();
    expect(request).toMatchObject({
      method: "thread/read",
      params: { threadId: "thread-l", includeTurns: true },
    });
    socket.receive({
      id: request.id,
      result: {
        thread: {
          id: "thread-l",
          turns: [{ id: "turn-l", status: "completed", items: [] }],
        },
      },
    });
    await read;
    expect(client.store.getThread("thread-l")?.turns[0]?.id).toBe("turn-l");
  });
});

describe("server-initiated requests", () => {
  it("answers approval and dynamic tool callbacks with the original request id", async () => {
    const commandApproval = vi.fn(async () => ({ decision: "accept" as const }));
    const dynamicToolCall = vi.fn(async () => ({
      contentItems: [{ type: "inputText" as const, text: "Current page: 7" }],
      success: true,
    }));
    const { socket } = await connectedClient({
      handlers: { commandApproval, dynamicToolCall },
    });

    socket.receive({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
        command: "pdftotext paper.pdf -",
      },
    });
    await flushAsyncHandlers();
    expect(commandApproval).toHaveBeenCalledWith(
      expect.objectContaining({ command: "pdftotext paper.pdf -" }),
    );
    expect(socket.last()).toEqual({ id: "approval-1", result: { decision: "accept" } });

    socket.receive({
      id: 90,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "zotero_reader",
        tool: "get_current_page",
        arguments: {},
      },
    });
    await flushAsyncHandlers();
    expect(dynamicToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "get_current_page" }),
    );
    expect(socket.last()).toEqual({
      id: 90,
      result: {
        contentItems: [{ type: "inputText", text: "Current page: 7" }],
        success: true,
      },
    });
  });

  it("returns method-not-found for an unhandled server request", async () => {
    const { socket } = await connectedClient();
    socket.receive({ id: 42, method: "future/request", params: {} });
    await flushAsyncHandlers();
    expect(socket.last()).toEqual({
      id: 42,
      error: { code: -32601, message: "Unknown method: future/request" },
    });
  });
});

describe("ThreadStore streaming aggregation", () => {
  it("merges item, reasoning, command, tool, and turn events into one snapshot", () => {
    const store = new ThreadStore();
    const notifications: RpcNotification[] = [
      {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "inProgress", items: [] },
        },
      },
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "agent-1", text: "", phase: null },
          startedAtMs: 10,
        },
      },
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "Hello " },
      },
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "paper" },
      },
      {
        method: "item/reasoning/summaryPartAdded",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", summaryIndex: 0 },
      },
      {
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reason-1",
          summaryIndex: 0,
          delta: "Inspecting theorem",
        },
      },
      {
        method: "item/reasoning/textDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reason-1",
          contentIndex: 0,
          delta: "Internal detail",
        },
      },
      {
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "command-1",
          delta: "page 7 text",
        },
      },
      {
        method: "item/mcpToolCall/progress",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "tool-1",
          message: "Reading PDF",
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "agent-1", text: "Hello paper", phase: "final_answer" },
          completedAtMs: 20,
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [], completedAt: 2 },
        },
      },
    ];

    for (const notification of notifications) {
      expect(store.applyNotification(notification)).toBe(true);
    }

    const snapshot = store.getSnapshot();
    const turn = snapshot.threads[0]?.turns[0];
    expect(turn?.status).toBe("completed");
    expect(turn?.items.find((item) => item.id === "agent-1")).toMatchObject({
      type: "agentMessage",
      text: "Hello paper",
      lifecycle: "completed",
      startedAtMs: 10,
      completedAtMs: 20,
    });
    expect(turn?.items.find((item) => item.id === "reason-1")).toMatchObject({
      type: "reasoning",
      summary: ["Inspecting theorem"],
      content: ["Internal detail"],
    });
    expect(turn?.items.find((item) => item.id === "command-1")?.aggregatedOutput)
      .toBe("page 7 text");
    expect(turn?.items.find((item) => item.id === "tool-1")?.progress)
      .toEqual(["Reading PDF"]);
  });
});
