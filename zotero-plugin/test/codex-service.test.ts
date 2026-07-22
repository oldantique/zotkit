import { describe, expect, it, vi } from "vitest";
import { CodexService } from "../src/codex-service";
import type { ReaderContext, ReaderContextService } from "../src/reader-context";
import type { NativeBridge } from "../src/native-bridge";

function paperContext(): ReaderContext {
  return {
    schemaVersion: 1,
    capturedAt: "2026-07-22T00:00:00.000Z",
    attachment: {
      id: 7,
      key: "ATTACH",
      libraryID: 1,
      title: "Paper PDF",
      filename: "paper.pdf",
      creators: [],
      tags: []
    },
    parent: {
      id: 6,
      key: "PARENT",
      libraryID: 1,
      title: "A Paper",
      creators: [],
      tags: []
    },
    pdfPath: "/papers/paper.pdf",
    page: {
      pageIndex: 2,
      pageNumber: 3,
      pageLabel: "3",
      text: "Current page",
      source: "pdfjs",
      warnings: []
    },
    selection: {
      text: "Selected theorem",
      pageIndex: 2,
      pageNumber: 3,
      capturedAt: "2026-07-22T00:00:00.000Z"
    },
    fullText: { source: "indexed-fulltext", characters: 1000 },
    workspace: {
      root: "/profile/papers/1-ATTACH",
      context: "/profile/papers/1-ATTACH/context.json",
      currentPage: "/profile/papers/1-ATTACH/current-page.md",
      currentSelection: "/profile/papers/1-ATTACH/current-selection.md",
      pdfText: "/profile/papers/1-ATTACH/current-pdf-text.txt",
      agents: "/profile/papers/1-ATTACH/AGENTS.md",
      claude: "/profile/papers/1-ATTACH/CLAUDE.md"
    },
    warnings: []
  };
}

function serviceWithClient(client: Record<string, unknown>) {
  const callbacks = { onState: vi.fn(), onError: vi.fn() };
  const service = new CodexService(
    {} as NativeBridge,
    { tools: [] } as unknown as ReaderContextService,
    "test",
    callbacks
  );
  const internal = service as any;
  internal.client = client;
  internal.activeContext = paperContext();
  internal.activePaperKey = "1-ATTACH";
  internal.threadPaperKeys.set("thread-a", "1-ATTACH");
  service.state.connected = true;
  service.state.activeThreadId = "thread-a";
  return { service, callbacks };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("CodexService follow-up turns", () => {
  it("steers the exact active thread and turn while a response is running", async () => {
    const client = {
      turnStart: vi.fn(),
      turnSteer: vi.fn().mockResolvedValue({ turnId: "turn-a" })
    };
    const { service } = serviceWithClient(client);
    service.state.running = true;
    service.state.activeTurnId = "turn-a";

    await service.send("Also check the appendix.", "gpt-5.6-sol", "max");

    expect(client.turnStart).not.toHaveBeenCalled();
    expect(client.turnSteer).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-a",
      expectedTurnId: "turn-a",
      input: [{ type: "text", text: "Also check the appendix.", text_elements: [] }]
    }));
    expect(service.state).toMatchObject({ running: true, activeTurnId: "turn-a" });
  });

  it("serializes an immediate second submission behind turn/start and then steers that turn", async () => {
    const started = deferred<{ turn: { id: string } }>();
    const client = {
      turnStart: vi.fn(() => started.promise),
      turnSteer: vi.fn().mockResolvedValue({ turnId: "turn-new" })
    };
    const { service } = serviceWithClient(client);

    const first = service.send("Explain the proof.", "gpt-5.6-sol", "high");
    const second = service.send("Focus on the third step.", "gpt-5.6-sol", "high");
    await vi.waitFor(() => expect(client.turnStart).toHaveBeenCalledOnce());
    expect(client.turnSteer).not.toHaveBeenCalled();

    started.resolve({ turn: { id: "turn-new" } });
    await Promise.all([first, second]);

    expect(client.turnSteer).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-a",
      expectedTurnId: "turn-new",
      input: [{ type: "text", text: "Focus on the third step.", text_elements: [] }]
    }));
  });

  it("does not mark the active answer stopped when steering fails", async () => {
    const client = {
      turnSteer: vi.fn().mockRejectedValue(new Error("turn already completed"))
    };
    const { service } = serviceWithClient(client);
    service.state.running = true;
    service.state.activeTurnId = "turn-a";

    await expect(service.send("One more detail.", "", "medium"))
      .rejects.toThrow("turn already completed");
    expect(service.state).toMatchObject({ running: true, activeTurnId: "turn-a" });
  });
});

describe("CodexService model capabilities", () => {
  it("preserves per-model supported and default reasoning efforts including max and ultra", async () => {
    const client = {
      modelList: vi.fn().mockResolvedValue({
        data: [{
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "max", description: "Maximum" },
            { reasoningEffort: "ultra", description: "Automatic delegation" }
          ],
          defaultReasoningEffort: "low"
        }],
        nextCursor: null
      })
    };
    const { service } = serviceWithClient(client);

    await service.refreshModels();

    expect(service.state.models).toEqual([{
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      isDefault: true,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "max", description: "Maximum" },
        { reasoningEffort: "ultra", description: "Automatic delegation" }
      ]
    }]);
  });

  it("clears live turn state when the transport disconnects", () => {
    const { service, callbacks } = serviceWithClient({});
    service.state.running = true;
    service.state.activeTurnId = "turn-a";

    (service as any).markDisconnected();

    expect(service.state).toMatchObject({
      connected: false,
      running: false,
      activeThreadId: null,
      activeTurnId: null
    });
    expect(callbacks.onState).toHaveBeenCalledOnce();
  });
});
