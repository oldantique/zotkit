import { describe, expect, it, vi } from "vitest";
import { CodexService } from "../src/codex-service";
import { setPrefString } from "../src/platform";
import { installGeckoStubs } from "./gecko-stubs";

installGeckoStubs();

import type { NativeBridge } from "../src/native-bridge";
import type { ReaderContext, ReaderContextService } from "../src/reader-context";
import type { AgentClient } from "../src/agent-client";
import { ENGINE_CAPABILITIES } from "../src/agent-client";
import { EngineClient } from "../src/engine-client";
import { ThreadStore } from "../src/codex-app-server";

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
