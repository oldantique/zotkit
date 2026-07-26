import { describe, expect, it, vi } from "vitest";
import { installGeckoStubs } from "./gecko-stubs";

installGeckoStubs();

import { EngineClient, type EngineTranscriptStorage } from "../src/engine-client";
import { ThreadStore } from "../src/codex-app-server";
import type { RpcNotification } from "../src/protocol";
import type { WireAdapter, WireEvent, WireParser } from "../src/wire";
import type { ProviderProfile } from "../src/providers";

const provider: ProviderProfile = {
  id: "p1",
  name: "DeepSeek",
  wire: "openai",
  baseUrl: "https://api.deepseek.com",
  models: [{ id: "deepseek-chat", label: "Chat" }],
  defaultModel: "deepseek-chat",
};

/** Scripted adapter: element N of `script` is the WireEvent[] stream run N produces. */
function scriptedWire(script: WireEvent[][]): WireAdapter {
  let run = 0;
  return {
    buildRequest: (baseUrl, apiKey, messages) => ({
      url: `${baseUrl}/chat/completions`,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ messages }),
    }),
    createParser(): WireParser {
      const events = script[Math.min(run, script.length - 1)]!;
      run += 1;
      return { push: () => events, end: () => [] };
    },
  };
}

function memoryStorage(): EngineTranscriptStorage & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: async (threadId) => files.get(threadId) ?? null,
    write: async (threadId, content) => { files.set(threadId, content); },
  };
}

type EngineOptions = ConstructorParameters<typeof EngineClient>[0];

function makeClient(script: WireEvent[][], overrides: Partial<EngineOptions> = {}) {
  const store = new ThreadStore();
  const notifications: RpcNotification[] = [];
  const storage = memoryStorage();
  const client = new EngineClient({
    store,
    providers: () => [provider],
    readKey: async () => "sk-test",
    onNotification: (notification) => notifications.push(notification),
    streamImpl: async (options) => {
      options.onChunk("scripted");
      return { status: 200, ok: true, errorBody: null };
    },
    wireAdapters: { openai: scriptedWire(script) },
    storage,
    ...overrides,
  });
  return { client, store, notifications, storage };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 25; index += 1) await Promise.resolve();
}

describe("EngineClient", () => {
  it("streams a text turn through the codex notification vocabulary", async () => {
    const { client, store, notifications, storage } = makeClient([[
      { type: "textDelta", delta: "你" },
      { type: "textDelta", delta: "好" },
      { type: "stop", reason: "end" },
    ]]);
    const thread = await client.threadStart({});
    await client.turnStart({
      threadId: thread.thread.id,
      input: [{ type: "text", text: "问题", text_elements: [] }],
      model: null,
      effort: "medium",
    });
    await settle();
    const methods = notifications.map((notification) => notification.method);
    expect(methods).toContain("turn/started");
    expect(methods).toContain("item/agentMessage/delta");
    expect(methods).toContain("turn/completed");
    const stored = store.getThread(thread.thread.id)!;
    const items = stored.turns[0]!.items;
    expect(items.some((item) => item.type === "userMessage")).toBe(true);
    expect(items.find((item) => item.type === "agentMessage")?.text).toBe("你好");
    expect(storage.files.get(thread.thread.id)).toContain("你好");
  });

  it("runs the dynamic tool loop and feeds results back", async () => {
    const dynamicToolCall = vi.fn().mockResolvedValue({
      success: true,
      contentItems: [{ type: "inputText", text: "page three text" }],
    });
    const { client, store } = makeClient([
      [
        { type: "toolCalls", calls: [{ id: "c1", name: "zotero_page", argumentsJson: "{\"page\":3}" }] },
        { type: "stop", reason: "toolCalls" },
      ],
      [
        { type: "textDelta", delta: "答案" },
        { type: "stop", reason: "end" },
      ],
    ], { handlers: { dynamicToolCall } });
    const thread = await client.threadStart({
      dynamicTools: [{ type: "function", name: "zotero_page", description: "d", inputSchema: {} }],
    });
    await client.turnStart({
      threadId: thread.thread.id,
      input: [{ type: "text", text: "第三页说了什么", text_elements: [] }],
      model: "engine:p1:deepseek-chat",
      effort: "medium",
    });
    await settle();
    expect(dynamicToolCall).toHaveBeenCalledWith(expect.objectContaining({
      tool: "zotero_page",
      arguments: { page: 3 },
    }));
    const items = store.getThread(thread.thread.id)!.turns[0]!.items;
    expect(items.some((item) => item.type === "dynamicToolCall")).toBe(true);
    const agentTexts = items.filter((item) => item.type === "agentMessage");
    expect(agentTexts[agentTexts.length - 1]?.text).toBe("答案");
  });

  it("fails the turn with turn/failed on HTTP errors", async () => {
    const { client, notifications } = makeClient([[]], {
      streamImpl: async () => ({ status: 401, ok: false, errorBody: null }),
    });
    const thread = await client.threadStart({});
    await client.turnStart({
      threadId: thread.thread.id,
      input: [{ type: "text", text: "问", text_elements: [] }],
      model: null,
      effort: "medium",
    });
    await settle();
    const failed = notifications.find((notification) => notification.method === "turn/failed");
    expect(failed).toBeTruthy();
    expect(JSON.stringify(failed!.params)).toContain("401");
    expect(notifications.some((notification) => notification.method === "turn/completed")).toBe(false);
  });

  it("mints a fresh turn id after a failed turn so a retry doesn't merge into it", async () => {
    let call = 0;
    const { client, store } = makeClient([[
      { type: "textDelta", delta: "second answer" },
      { type: "stop", reason: "end" },
    ]], {
      streamImpl: async (options) => {
        call += 1;
        if (call === 1) return { status: 401, ok: false, errorBody: null };
        options.onChunk("scripted");
        return { status: 200, ok: true, errorBody: null };
      },
    });
    const thread = await client.threadStart({});
    const first = await client.turnStart({
      threadId: thread.thread.id,
      input: [{ type: "text", text: "q1", text_elements: [] }],
      model: null,
      effort: "medium",
    });
    await settle();
    const second = await client.turnStart({
      threadId: thread.thread.id,
      input: [{ type: "text", text: "q2", text_elements: [] }],
      model: null,
      effort: "medium",
    });
    await settle();
    expect(second.turn.id).not.toBe(first.turn.id);
    const stored = store.getThread(thread.thread.id)!;
    expect(stored.turns.length).toBe(2);
    const failedTurn = stored.turns.find((turn) => turn.id === first.turn.id)!;
    expect(failedTurn.status).toBe("failed");
    const secondTurn = stored.turns.find((turn) => turn.id === second.turn.id)!;
    expect(secondTurn.items.find((item) => item.type === "agentMessage")?.text).toBe("second answer");
  });

  it("caps the tool loop at 8 iterations", async () => {
    const dynamicToolCall = vi.fn().mockResolvedValue({
      success: true,
      contentItems: [{ type: "inputText", text: "{}" }],
    });
    const { client, notifications } = makeClient([[
      { type: "toolCalls", calls: [{ id: "c", name: "t", argumentsJson: "{}" }] },
      { type: "stop", reason: "toolCalls" },
    ]], { handlers: { dynamicToolCall } });
    const thread = await client.threadStart({
      dynamicTools: [{ type: "function", name: "t", description: "d", inputSchema: {} }],
    });
    await client.turnStart({
      threadId: thread.thread.id,
      input: [{ type: "text", text: "q", text_elements: [] }],
      model: null,
      effort: "medium",
    });
    await settle();
    expect(dynamicToolCall).toHaveBeenCalledTimes(7);
    const failed = notifications.find((notification) => notification.method === "turn/failed");
    expect(JSON.stringify(failed!.params)).toContain("工具调用次数超限");
  });

  it("resumes a persisted thread into the store", async () => {
    const storage = memoryStorage();
    const first = makeClient([[
      { type: "textDelta", delta: "answer" },
      { type: "stop", reason: "end" },
    ]], { storage });
    const thread = await first.client.threadStart({});
    await first.client.turnStart({
      threadId: thread.thread.id,
      input: [{ type: "text", text: "q1", text_elements: [] }],
      model: null,
      effort: "medium",
    });
    await settle();
    const second = makeClient([[]], { storage });
    const resumed = await second.client.threadResume({ threadId: thread.thread.id });
    expect(resumed.thread.id).toBe(thread.thread.id);
    const stored = second.store.getThread(thread.thread.id)!;
    expect(stored.turns.length).toBe(1);
    expect(stored.turns[0]!.items.find((item) => item.type === "agentMessage")?.text).toBe("answer");
  });

  it("imports migrated history as completed turns", async () => {
    const { client, store } = makeClient([[]]);
    const threadId = await client.importThread("迁移标题", [
      { role: "user", text: "老问题" },
      { role: "assistant", text: "老回答" },
    ]);
    const stored = store.getThread(threadId)!;
    expect(stored.turns.length).toBe(1);
    expect(stored.turns[0]!.items.map((item) => item.type)).toEqual(["userMessage", "agentMessage"]);
  });
});
