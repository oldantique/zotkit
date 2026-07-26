import { describe, expect, it, vi } from "vitest";
import { CodexService } from "../src/codex-service";
import { setPrefString } from "../src/platform";
import { installGeckoStubs } from "./gecko-stubs";

installGeckoStubs();

import type { NativeBridge } from "../src/native-bridge";
import type { ReaderContext, ReaderContextService } from "../src/reader-context";
import type { AgentClient } from "../src/agent-client";
import { CODEX_CAPABILITIES, ENGINE_CAPABILITIES } from "../src/agent-client";
import { EngineClient } from "../src/engine-client";
import { ThreadStore } from "../src/codex-app-server";
import { saveProviders, type ProviderProfile } from "../src/providers";

function paperContext(): ReaderContext {
  return {
    schemaVersion: 1,
    capturedAt: "2026-07-26T00:00:00.000Z",
    attachment: {
      id: 7, key: "ATTACH", libraryID: 1, title: "Paper PDF",
      filename: "paper.pdf", creators: [], tags: [],
    },
    parent: { id: 6, key: "PARENT", libraryID: 1, title: "A Paper", creators: [], tags: [] },
    pdfPath: "/papers/paper.pdf",
    page: { pageIndex: 2, pageNumber: 3, pageLabel: "3", text: "t", source: "pdfjs", warnings: [] },
    selection: null,
    fullText: { source: "indexed-fulltext", characters: 10 },
    workspace: {
      root: "/profile/papers/1-ATTACH",
      context: "/profile/papers/1-ATTACH/context.json",
      currentPage: "/profile/papers/1-ATTACH/current-page.md",
      currentSelection: "/profile/papers/1-ATTACH/current-selection.md",
      pdfText: "/profile/papers/1-ATTACH/current-pdf-text.txt",
      agents: "/profile/papers/1-ATTACH/AGENTS.md",
      claude: "/profile/papers/1-ATTACH/CLAUDE.md",
    },
    warnings: [],
  } as unknown as ReaderContext;
}

/** Engine-shaped fake that satisfies every method the service touches. */
function fakeEngine() {
  let nextThread = 0;
  const client = {
    agentCapabilities: ENGINE_CAPABILITIES,
    connect: vi.fn().mockResolvedValue({}),
    close: vi.fn(),
    accountRead: vi.fn().mockResolvedValue({ account: null, requiresOpenaiAuth: false }),
    modelList: vi.fn().mockResolvedValue({ data: [] }),
    threadStart: vi.fn().mockImplementation(async () => ({ thread: { id: `eng-${++nextThread}` } })),
    threadResume: vi.fn().mockImplementation(async (params: { threadId: string }) => ({ thread: { id: params.threadId } })),
    threadRead: vi.fn().mockResolvedValue({ thread: { id: "eng-1", turns: [] } }),
    threadSetName: vi.fn().mockResolvedValue({}),
    turnStart: vi.fn().mockResolvedValue({ turn: { id: "turn-1" } }),
    turnInterrupt: vi.fn().mockResolvedValue({}),
    importThread: vi.fn().mockResolvedValue("eng-imported"),
  };
  Object.setPrototypeOf(client, EngineClient.prototype);
  return client as unknown as AgentClient & { importThread: ReturnType<typeof vi.fn> };
}

function makeService(engine: AgentClient) {
  const callbacks = { onState: vi.fn(), onError: vi.fn(), onFallbackRequested: vi.fn() };
  const bridge = {
    start: vi.fn().mockRejectedValue(new Error("bridge must not start for engine backend")),
    spawnPipe: vi.fn(),
    closeSession: vi.fn(),
  } as unknown as NativeBridge;
  const service = new CodexService(
    bridge,
    { tools: [] } as unknown as ReaderContextService,
    "test",
    callbacks,
    null,
    () => engine,
  );
  return { service, callbacks, bridge };
}

describe("engine backend startup", () => {
  it("starts without touching the bridge or codex CLI", async () => {
    setPrefString("backend", "engine");
    const engine = fakeEngine();
    const { service, bridge } = makeService(engine);
    await service.start();
    expect(service.state.backend).toBe("engine");
    expect(service.state.connected).toBe(true);
    expect(service.state.capabilities.supportsAgentMode).toBe(false);
    expect((bridge as any).start).not.toHaveBeenCalled();
    expect((bridge as any).spawnPipe).not.toHaveBeenCalled();
  });
});

describe("backend-scoped sessions", () => {
  it("does not resume a codex-backed record on the engine backend", async () => {
    setPrefString("backend", "engine");
    const engine = fakeEngine();
    const { service } = makeService(engine);
    await service.start();
    (service as any).sessions.papers["1-ATTACH"] = {
      threadId: "codex-old", title: "老会话", workspace: "/w",
      updatedAt: "2026-07-25T00:00:00.000Z", backend: "codex",
    };
    (service as any).saveSessions = vi.fn().mockResolvedValue(undefined);
    await service.setPaper(paperContext());
    expect((engine as any).threadResume).not.toHaveBeenCalled();
    expect((engine as any).threadStart).toHaveBeenCalled();
    expect((service as any).sessions.papers["1-ATTACH"].backend).toBe("engine");
  });
});

describe("switchBackend with history carry-over", () => {
  it("imports codex user/assistant turns into a new engine thread", async () => {
    setPrefString("backend", "codex");
    const engine = fakeEngine();
    const { service } = makeService(engine);
    const internal = service as any;
    internal.sessions = {
      version: 1,
      papers: {
        "1-ATTACH": {
          threadId: "codex-old", title: "论文 A", workspace: "/w",
          updatedAt: "2026-07-25T00:00:00.000Z", backend: "codex",
        },
      },
    };
    internal.activePaperKey = "1-ATTACH";
    internal.activeContext = paperContext();
    internal.saveSessions = vi.fn().mockResolvedValue(undefined);
    internal.loadSessions = vi.fn().mockResolvedValue(undefined);
    service.state.backend = "codex";
    service.state.connected = true;
    service.state.activeThreadId = "codex-old";
    internal.threadPaperKeys.set("codex-old", "1-ATTACH");
    internal.client = { close: vi.fn() };
    service.readThreadTurns = vi.fn().mockResolvedValue([[
      { id: "u1", kind: "user", text: "老问题" },
      { id: "a1", kind: "assistant", text: "老回答" },
      { id: "t1", kind: "tool", text: "工具输出" },
    ]]) as any;
    await service.switchBackend("engine", true);
    expect((engine as any).importThread).toHaveBeenCalledWith("论文 A", [
      { role: "user", text: "老问题" },
      { role: "assistant", text: "老回答" },
    ]);
    expect(service.state.backend).toBe("engine");
    expect(service.state.activeThreadId).toBe("eng-imported");
    expect(internal.sessions.papers["1-ATTACH"].backend).toBe("engine");
    // I1: a migrated thread must get the same dynamicTools/developerInstructions
    // a normal thread start would — importThread alone only seeds history.
    expect((engine as any).threadResume).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "eng-imported",
        developerInstructions: expect.stringContaining("Ask mode"),
      }),
    );
  });
});

describe("switchBackend failure path", () => {
  it("surfaces fallback state and rejects when the target backend fails to start", async () => {
    setPrefString("backend", "codex");
    const engine = fakeEngine();
    (engine as any).connect = vi.fn().mockRejectedValue(new Error("engine boom"));
    const { service, callbacks } = makeService(engine);
    const internal = service as any;
    internal.activeContext = paperContext();
    internal.activePaperKey = "1-ATTACH";
    internal.sessions = { version: 1, papers: {} };
    service.state.backend = "codex";
    service.state.connected = true;
    internal.client = { close: vi.fn() };

    await expect(service.switchBackend("engine", false)).rejects.toThrow("engine boom");

    expect(service.state.appServerAvailable).toBe(false);
    expect(service.state.fallbackReason).toBe("engine boom");
    expect(callbacks.onFallbackRequested).toHaveBeenCalled();
  });
});

describe("switchBackend mode reconciliation", () => {
  it("resets agent mode when the target backend does not support it", async () => {
    setPrefString("backend", "codex");
    const engine = fakeEngine();
    const { service } = makeService(engine);
    const internal = service as any;
    internal.activeContext = paperContext();
    internal.activePaperKey = "1-ATTACH";
    internal.sessions = { version: 1, papers: {} };
    internal.saveSessions = vi.fn().mockResolvedValue(undefined);
    service.state.backend = "codex";
    service.state.connected = true;
    service.state.mode = "agent";
    internal.client = { close: vi.fn() };

    await service.switchBackend("engine", false);

    expect(service.state.backend).toBe("engine");
    expect(service.state.mode).toBe("ask");
  });
});

describe("turn/failed notification (C1)", () => {
  it("resets running/activeTurnId the same way turn/completed does", () => {
    const engine = fakeEngine();
    const { service } = makeService(engine);
    service.state.activeThreadId = "thread-a";
    service.state.running = true;
    service.state.activeTurnId = "turn-1";
    (service as any).handleNotification({
      method: "turn/failed",
      params: {
        threadId: "thread-a",
        turnId: "turn-1",
        turn: { id: "turn-1", threadId: "thread-a" },
        error: { message: "boom" },
      },
    });
    expect(service.state.running).toBe(false);
    expect(service.state.activeTurnId).toBeNull();
  });
});

describe("mixed-backend model menu (C2 / spec §六)", () => {
  it("engine backend: refreshModels appends a codex placeholder alongside engine entries", async () => {
    setPrefString("backend", "engine");
    const provider: ProviderProfile = {
      id: "p1",
      name: "DeepSeek",
      wire: "openai",
      baseUrl: "https://api.deepseek.com",
      models: [{ id: "deepseek-chat", label: "DeepSeek Chat" }],
      defaultModel: "deepseek-chat",
    };
    saveProviders([provider]);
    // Real EngineClient (the default engineClientFactory), not the fakeEngine
    // stub — modelList() must actually derive engine entries from providers,
    // which only the real client does.
    const bridge = { start: vi.fn(), spawnPipe: vi.fn(), closeSession: vi.fn() } as unknown as NativeBridge;
    const callbacks = { onState: vi.fn(), onError: vi.fn(), onFallbackRequested: vi.fn() };
    const service = new CodexService(
      bridge,
      { tools: [] } as unknown as ReaderContextService,
      "test",
      callbacks,
      null,
    );
    await service.start();
    const ids = service.state.models.map((model) => model.id);
    expect(ids).toContain("codex");
    expect(ids).toContain("engine:p1:deepseek-chat");
    const placeholder = service.state.models.find((model) => model.id === "codex");
    expect(placeholder?.label).toBe("Codex（订阅）");
    expect(placeholder?.supportedReasoningEfforts).toEqual([]);
  });

  it("codex backend: refreshModels appends engine entries derived from providers", async () => {
    setPrefString("backend", "codex");
    const provider: ProviderProfile = {
      id: "p2",
      name: "OpenAI",
      wire: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: [{ id: "gpt-5-mini", label: "GPT-5 mini", supportsReasoningEffort: true }],
      defaultModel: "gpt-5-mini",
    };
    saveProviders([provider]);
    const { service } = makeService(fakeEngine());
    const internal = service as any;
    service.state.backend = "codex";
    internal.client = {
      agentCapabilities: CODEX_CAPABILITIES,
      modelList: vi.fn().mockResolvedValue({ data: [{ id: "gpt-5", isDefault: true }] }),
    };
    const models = await service.refreshModels();
    const ids = models.map((model) => model.id);
    expect(ids).toContain("gpt-5");
    expect(ids).toContain("engine:p2:gpt-5-mini");
    const engineEntry = models.find((model) => model.id === "engine:p2:gpt-5-mini");
    expect(engineEntry?.label).toBe("OpenAI · GPT-5 mini");
    expect(engineEntry?.supportedReasoningEfforts?.length).toBe(3);
  });
});

describe("stale agent mode reset on start (I2)", () => {
  it("falls back to ask when starting lands on capabilities without agent mode support", async () => {
    setPrefString("backend", "engine");
    const engine = fakeEngine();
    const { service } = makeService(engine);
    service.state.mode = "agent";
    await service.start();
    expect(service.state.capabilities.supportsAgentMode).toBe(false);
    expect(service.state.mode).toBe("ask");
  });
});

describe("resume-failure archives the stale session record (I5)", () => {
  it("keeps the old thread pointer in sessions.history instead of dropping it", async () => {
    setPrefString("backend", "engine");
    const engine = fakeEngine();
    (engine as any).threadResume = vi.fn().mockRejectedValue(new Error("resume failed"));
    const { service } = makeService(engine);
    await service.start();
    const internal = service as any;
    const staleRecord = {
      threadId: "eng-stale",
      title: "旧会话",
      workspace: "/w",
      updatedAt: "2026-07-20T00:00:00.000Z",
      backend: "engine",
    };
    internal.sessions.papers["1-ATTACH"] = staleRecord;
    internal.saveSessions = vi.fn().mockResolvedValue(undefined);
    await service.setPaper(paperContext());
    // A fresh thread was started (via threadStart, since threadResume rejected).
    expect(service.state.activeThreadId).not.toBe("eng-stale");
    expect(internal.sessions.papers["1-ATTACH"].threadId).not.toBe("eng-stale");
    // The old record is archived, not lost.
    const history = internal.sessions.history?.["1-ATTACH"] ?? [];
    expect(history.some((record: { threadId: string }) => record.threadId === "eng-stale")).toBe(true);
  });
});

describe("deleteThread (bug-triage #3)", () => {
  it("removes a non-active thread's history record without touching the active thread", async () => {
    setPrefString("backend", "engine");
    const engine = fakeEngine();
    const { service } = makeService(engine);
    await service.start();
    const internal = service as any;
    internal.saveSessions = vi.fn().mockResolvedValue(undefined);
    await service.setPaper(paperContext());
    const activeId = service.state.activeThreadId!;
    internal.sessions.history = {
      "1-ATTACH": [
        { threadId: "eng-old", title: "旧会话", workspace: "/w", updatedAt: "t0", backend: "engine" },
      ],
    };

    await service.deleteThread("eng-old");

    expect(internal.sessions.history["1-ATTACH"]).toEqual([]);
    expect(internal.sessions.papers["1-ATTACH"].threadId).toBe(activeId);
    expect(service.state.activeThreadId).toBe(activeId);
    expect((engine as any).turnInterrupt).not.toHaveBeenCalled();
    expect((engine as any).threadResume).not.toHaveBeenCalled();
    expect(internal.saveSessions).toHaveBeenCalled();
  });

  it("deleting the active thread interrupts a running turn and resumes the most recently used remaining record", async () => {
    setPrefString("backend", "engine");
    const engine = fakeEngine();
    const { service } = makeService(engine);
    await service.start();
    const internal = service as any;
    internal.saveSessions = vi.fn().mockResolvedValue(undefined);
    await service.setPaper(paperContext());
    const activeId = service.state.activeThreadId!;
    internal.sessions.history = {
      "1-ATTACH": [
        { threadId: "eng-old-2", title: "较新的旧会话", workspace: "/w", updatedAt: "t2", backend: "engine" },
        { threadId: "eng-old-1", title: "更旧的会话", workspace: "/w", updatedAt: "t1", backend: "engine" },
      ],
    };
    service.state.running = true;
    service.state.activeTurnId = "turn-live";

    await service.deleteThread(activeId);

    expect((engine as any).turnInterrupt).toHaveBeenCalledWith({ threadId: activeId, turnId: "turn-live" });
    expect((engine as any).threadResume).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "eng-old-2" }),
    );
    expect(service.state.running).toBe(false);
    expect(service.state.activeThreadId).toBe("eng-old-2");
    expect(internal.sessions.papers["1-ATTACH"].threadId).toBe("eng-old-2");
    expect(internal.sessions.history["1-ATTACH"]).toEqual([
      { threadId: "eng-old-1", title: "更旧的会话", workspace: "/w", updatedAt: "t1", backend: "engine" },
    ]);
  });

  it("deleting the active thread with no remaining records leaves activeThreadId null -- the next send() starts fresh", async () => {
    setPrefString("backend", "engine");
    const engine = fakeEngine();
    const { service } = makeService(engine);
    await service.start();
    const internal = service as any;
    internal.saveSessions = vi.fn().mockResolvedValue(undefined);
    await service.setPaper(paperContext());
    const activeId = service.state.activeThreadId!;

    await service.deleteThread(activeId);

    expect(service.state.activeThreadId).toBeNull();
    expect(service.state.activeTurnId).toBeNull();
    expect(internal.sessions.papers["1-ATTACH"]).toBeUndefined();
    expect((engine as any).threadResume).not.toHaveBeenCalled();
  });

  it("no-ops for a thread id that isn't the paper's current record or in its history, but still re-renders (reviewer Important #3: FIFO-queue race feedback)", async () => {
    setPrefString("backend", "engine");
    const engine = fakeEngine();
    const { service, callbacks } = makeService(engine);
    await service.start();
    const internal = service as any;
    internal.saveSessions = vi.fn().mockResolvedValue(undefined);
    await service.setPaper(paperContext());
    const activeId = service.state.activeThreadId!;
    internal.saveSessions.mockClear();
    callbacks.onState.mockClear();

    await service.deleteThread("nonexistent-thread");

    expect(service.state.activeThreadId).toBe(activeId);
    expect(internal.saveSessions).not.toHaveBeenCalled();
    // No destructive write happened, but the UI still needs to re-render
    // against reality (e.g. a queued setPaper()/switchThread() moved the
    // active paper on before this ran) instead of showing stale state.
    expect(callbacks.onState).toHaveBeenCalled();
  });

  it("no-ops with a re-render when there is no active paper at all", async () => {
    setPrefString("backend", "engine");
    const engine = fakeEngine();
    const { service, callbacks } = makeService(engine);
    await service.start();
    callbacks.onState.mockClear();

    await service.deleteThread("thread-x");

    expect((service as any).activePaperKey).toBeNull();
    expect(callbacks.onState).toHaveBeenCalled();
  });

  it("deleting an active engine thread does not wipe unrelated-backend (codex) history records (reviewer Critical: cross-backend history wipe)", async () => {
    setPrefString("backend", "engine");
    const engine = fakeEngine();
    const { service } = makeService(engine);
    await service.start();
    const internal = service as any;
    internal.saveSessions = vi.fn().mockResolvedValue(undefined);
    await service.setPaper(paperContext());
    const activeId = service.state.activeThreadId!;
    // Full history mixes backends: one other engine record (the fallback
    // candidate) plus two codex records that must survive the delete
    // untouched.
    internal.sessions.history = {
      "1-ATTACH": [
        { threadId: "engine-old", title: "较新的 engine 会话", workspace: "/w", updatedAt: "t3", backend: "engine" },
        { threadId: "codex-old-1", title: "Codex 会话 1", workspace: "/w", updatedAt: "t2", backend: "codex" },
        { threadId: "codex-old-2", title: "Codex 会话 2", workspace: "/w", updatedAt: "t1", backend: "codex" },
      ],
    };

    await service.deleteThread(activeId);

    expect((engine as any).threadResume).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "engine-old" }),
    );
    expect(service.state.activeThreadId).toBe("engine-old");
    expect(internal.sessions.papers["1-ATTACH"].threadId).toBe("engine-old");
    const remainingIds = internal.sessions.history["1-ATTACH"].map((record: { threadId: string }) => record.threadId);
    expect(remainingIds).toEqual(["codex-old-1", "codex-old-2"]);
  });
});
