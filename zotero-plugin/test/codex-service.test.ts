import { describe, expect, it, vi } from "vitest";
import { CodexService } from "../src/codex-service";
import { READER_CONTEXT_TOOLS, READER_TOOL_NAMES } from "../src/reader-context";
import type { ReaderContext, ReaderContextService } from "../src/reader-context";
import type { NativeBridge } from "../src/native-bridge";
import { ZOTERO_MUTATION_TOOL, ZoteroMutationService } from "../src/zotero-mutations";

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
  it("marks Reader and pinned paper content untrusted while keeping host guidance application-owned", async () => {
    const client = {
      turnStart: vi.fn().mockResolvedValue({ turn: { id: "turn-a" } }),
    };
    const { service } = serviceWithClient(client);
    service.setInteractionContext({
      "Pinned Reader selection": { kind: "untrusted", value: "Selected theorem" },
    });

    await service.send("Explain this.", "gpt-5.6-sol", "medium");

    const additionalContext = client.turnStart.mock.calls[0]![0].additionalContext;
    expect(additionalContext["Zotkit Reader integration"]).toMatchObject({
      kind: "application",
    });
    expect(additionalContext["Zotero Reader"]).toMatchObject({
      kind: "untrusted",
      value: expect.stringContaining("Current page"),
    });
    expect(additionalContext["Pinned Reader selection"]).toEqual({
      kind: "untrusted",
      value: "Selected theorem",
    });
    expect(Object.values(
      additionalContext as Record<string, { kind: string }>,
    ).every(
      (entry) => entry.kind === "application" || entry.kind === "untrusted",
    )).toBe(true);
  });

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

describe("CodexService Cursor-style modes and approvals", () => {
  it("uses a read-only Ask turn and an approval-gated workspace Agent turn", async () => {
    vi.stubGlobal("Services", {
      uuid: { generateUUID: () => "{checkpoint-test}" },
    });
    const client = {
      turnStart: vi.fn()
        .mockResolvedValueOnce({ turn: { id: "turn-ask" } })
        .mockResolvedValueOnce({ turn: { id: "turn-agent" } }),
      threadResume: vi.fn().mockResolvedValue({ thread: { id: "thread-a", turns: [] } }),
      turnInterrupt: vi.fn(),
    };
    const { service } = serviceWithClient(client);
    (service as any).saveSessions = vi.fn().mockResolvedValue(undefined);

    await service.send("Explain the theorem.", "gpt-5.6-sol", "high");
    expect(client.turnStart).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cwd: "/profile/papers/1-ATTACH",
      runtimeWorkspaceRoots: ["/profile/papers/1-ATTACH"],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    }));

    service.state.running = false;
    service.state.activeTurnId = null;
    await service.setMode("agent");
    await service.send("Update the reviewed metadata.", "gpt-5.6-sol", "high");
    expect(client.turnStart).toHaveBeenNthCalledWith(2, expect.objectContaining({
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: expect.objectContaining({
        type: "workspaceWrite",
        writableRoots: ["/profile/papers/1-ATTACH"],
        networkAccess: false,
      }),
    }));
    expect(service.getCheckpoints()).toEqual([
      expect.objectContaining({ sourceThreadId: "thread-a", beforeTurnId: "turn-agent" }),
    ]);
    vi.unstubAllGlobals();
  });

  it("waits for the user before answering command, file, and permission requests", async () => {
    const { service, callbacks } = serviceWithClient({});
    service.state.mode = "agent";
    service.state.running = true;
    service.state.activeTurnId = "turn-a";
    const requestApproval = (service as any).requestUserApproval.bind(service);

    const command = requestApproval({
      kind: "commandExecution",
      method: "item/commandExecution/requestApproval",
      requestId: "rpc-command",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "item-command",
        startedAtMs: 1,
        command: "python update_metadata.py",
        cwd: "/papers",
        availableDecisions: ["accept", "decline"],
      },
    });
    expect(service.getPendingApprovals()).toEqual([
      expect.objectContaining({
        kind: "commandExecution",
        requestId: "rpc-command",
        command: "python update_metadata.py",
      }),
    ]);
    expect(service.resolveApproval(service.getPendingApprovals()[0]!.id, "approve-once")).toBe(true);
    await expect(command).resolves.toEqual({ decision: "accept" });

    const permission = requestApproval({
      kind: "permissions",
      method: "item/permissions/requestApproval",
      requestId: 17,
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "item-permission",
        startedAtMs: 2,
        environmentId: null,
        cwd: "/papers",
        reason: "Write the selected attachment",
        permissions: {
          network: null,
          fileSystem: {
            read: ["/papers"],
            write: ["/profile/papers/1-ATTACH"],
          },
        },
      },
    });
    expect(service.resolveApproval(service.getPendingApprovals()[0]!.id, "approve-session")).toBe(true);
    await expect(permission).resolves.toEqual({
      permissions: {
        fileSystem: {
          read: ["/papers"],
          write: ["/profile/papers/1-ATTACH"],
        },
      },
      scope: "session",
    });

    await expect(requestApproval({
      kind: "fileChange",
      method: "item/fileChange/requestApproval",
      requestId: "rpc-outside",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "item-outside",
        startedAtMs: 2,
        grantRoot: "/papers",
      },
    })).resolves.toEqual({ decision: "decline" });
    expect(service.getPendingApprovals()).toEqual([]);

    await expect(requestApproval({
      kind: "permissions",
      method: "item/permissions/requestApproval",
      requestId: "rpc-modern-outside",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "item-modern-outside",
        startedAtMs: 2,
        environmentId: null,
        cwd: "/profile/papers/1-ATTACH",
        reason: "Request modern filesystem entry",
        permissions: {
          network: null,
          fileSystem: {
            read: null,
            write: null,
            entries: [{
              access: "write",
              path: { type: "path", path: "/profile/papers/1-ATTACH/../../outside" },
            }],
          },
        },
      },
    })).resolves.toEqual({ permissions: {}, scope: "turn" });
    expect(service.getPendingApprovals()).toEqual([]);
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("outside its private staging workspace"),
    }));

    await expect(requestApproval({
      kind: "fileChange",
      method: "item/fileChange/requestApproval",
      requestId: "rpc-traversal",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "item-traversal",
        startedAtMs: 2,
        grantRoot: "/profile/papers/1-ATTACH/../../outside",
      },
    })).resolves.toEqual({ decision: "decline" });
    expect(service.getPendingApprovals()).toEqual([]);

    service.state.mode = "ask";
    await expect(requestApproval({
      kind: "fileChange",
      method: "item/fileChange/requestApproval",
      requestId: "rpc-file",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "item-file",
        startedAtMs: 3,
      },
    })).resolves.toEqual({ decision: "decline" });
    expect(service.getPendingApprovals()).toEqual([]);
  });

  it("keeps an in-workspace modern permission request visible for explicit review", async () => {
    const { service } = serviceWithClient({});
    service.state.mode = "agent";
    service.state.running = true;
    service.state.activeTurnId = "turn-a";
    const requestApproval = (service as any).requestUserApproval.bind(service);
    const requestedPermissions = {
      network: { enabled: true },
      fileSystem: {
        read: null,
        write: null,
        entries: [{
          access: "write",
          path: { type: "path", path: "/profile/papers/1-ATTACH/staging" },
        }],
      },
    };

    const response = requestApproval({
      kind: "permissions",
      method: "item/permissions/requestApproval",
      requestId: "rpc-modern-inside",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "item-modern-inside",
        startedAtMs: 2,
        environmentId: null,
        cwd: "/profile/papers/1-ATTACH",
        reason: "Stage a generated PDF",
        permissions: requestedPermissions,
      },
    });

    expect(service.getPendingApprovals()[0]).toMatchObject({
      requestedPermissions,
    });
    service.resolveApproval(service.getPendingApprovals()[0]!.id, "reject");
    await expect(response).resolves.toEqual({ permissions: {}, scope: "turn" });
  });

  it("rejects a writable path whose existing workspace symlink resolves outside", async () => {
    vi.stubGlobal("Components", {
      interfaces: { nsIFile: {} },
      classes: {
        "@mozilla.org/file/local;1": {
          createInstance: () => {
            let path = "";
            return {
              initWithPath(value: string) { path = value; },
              exists: () => true,
              normalize() {
                path = path.replace(
                  "/profile/papers/1-ATTACH/link",
                  "/outside-through-symlink",
                );
              },
              get path() { return path; },
              get leafName() { return path.split("/").pop() || ""; },
              get parent() { return null; },
            };
          },
        },
      },
    });
    const { service } = serviceWithClient({});
    service.state.mode = "agent";
    service.state.running = true;
    service.state.activeTurnId = "turn-a";
    const requestApproval = (service as any).requestUserApproval.bind(service);

    try {
      await expect(requestApproval({
        kind: "fileChange",
        method: "item/fileChange/requestApproval",
        requestId: "rpc-symlink-escape",
        params: {
          threadId: "thread-a",
          turnId: "turn-a",
          itemId: "item-symlink-escape",
          startedAtMs: 3,
          grantRoot: "/profile/papers/1-ATTACH/link/escape.pdf",
        },
      })).resolves.toEqual({ decision: "decline" });
      expect(service.getPendingApprovals()).toEqual([]);
    }
    finally {
      vi.unstubAllGlobals();
    }
  });

  it("only exposes injected writable tools in Agent mode", async () => {
    const readerContext = {
      tools: [{ name: "get_current_page", description: "Read", inputSchema: { type: "object" } }],
      getCachedContext: vi.fn(() => paperContext()),
      invokeTool: vi.fn().mockResolvedValue({ page: 3 }),
    } as unknown as ReaderContextService;
    const provider = {
      tools: [{ name: "preview_zotero_change", description: "Preview", inputSchema: { type: "object" } }],
      invokeTool: vi.fn().mockResolvedValue({ preview: true }),
    };
    const service = new CodexService(
      {} as NativeBridge,
      readerContext,
      "test",
      { onState: vi.fn(), onError: vi.fn() },
      provider,
    );
    const internal = service as any;
    internal.activeContext = paperContext();
    internal.activePaperKey = "1-ATTACH";
    internal.threadPaperKeys.set("thread-a", "1-ATTACH");
    service.state.activeThreadId = "thread-a";

    expect(internal.dynamicToolSpecs().map((tool: { name: string }) => tool.name))
      .toEqual(["get_current_page"]);
    await expect(internal.handleDynamicTool({
      threadId: "thread-a",
      turnId: "turn-a",
      callId: "call-a",
      namespace: null,
      tool: "preview_zotero_change",
      arguments: {},
    })).resolves.toMatchObject({ success: false });

    service.state.mode = "agent";
    expect(internal.dynamicToolSpecs().map((tool: { name: string }) => tool.name))
      .toEqual(["get_current_page", "preview_zotero_change"]);
    await expect(internal.handleDynamicTool({
      threadId: "thread-a",
      turnId: "turn-a",
      callId: "call-b",
      namespace: null,
      tool: "preview_zotero_change",
      arguments: { title: "New title" },
    })).resolves.toMatchObject({ success: true });
    expect(provider.invokeTool).toHaveBeenCalledWith(
      "preview_zotero_change",
      { title: "New title" },
      expect.objectContaining({ pdfPath: "/papers/paper.pdf" }),
    );
  });

  it("statically composes only the real read-only reader tools + zotero_propose_changes for Agent-mode turns -- no annotation/attachment/write tool ever reaches app-server (ADR-0002, MUST 3)", () => {
    // Uses the REAL tool registries (not a hand-rolled fake list), so this
    // locks the actual composition site (dynamicToolSpecs(), around
    // codex-service.ts:readerContext.tools + agentToolProvider.tools).
    const readerContext = { tools: READER_CONTEXT_TOOLS } as unknown as ReaderContextService;
    const mutations = new ZoteroMutationService(
      {} as any,
      { onState: () => {}, getContext: () => null },
    );
    const provider = { tools: mutations.tools, invokeTool: async () => undefined };
    const service = new CodexService(
      {} as NativeBridge,
      readerContext,
      "test",
      { onState: vi.fn(), onError: vi.fn() },
      provider,
    );
    const internal = service as any;
    service.state.mode = "agent";

    const names: string[] = internal.dynamicToolSpecs().map((tool: { name: string }) => tool.name);

    // The full composed set is exactly the known read-only reader tools plus
    // the single reviewed-mutation tool -- nothing more, nothing renamed.
    expect(names).toEqual([...READER_TOOL_NAMES, ZOTERO_MUTATION_TOOL]);

    // Defense in depth: no composed name reads as an annotation/attachment/
    // write tool. zotero_propose_changes is the one legitimate write-shaped
    // name (a reviewed proposal, not a direct mutation); zotero_list_annotations
    // is a legitimate read tool that happens to contain the substring "annot"
    // (it *lists* existing annotations, it does not create/delete them).
    const writeLike = /annot|attach|write|create|delete|erase/i;
    const knownSafeSubstringHits = new Set([ZOTERO_MUTATION_TOOL, "zotero_list_annotations"]);
    for (const name of names) {
      if (knownSafeSubstringHits.has(name)) continue;
      expect(name).not.toMatch(writeLike);
    }
  });

  it("restores a checkpoint by forking before its turn without claiming file restoration", async () => {
    const client = {
      threadFork: vi.fn().mockResolvedValue({
        thread: { id: "thread-restored", turns: [] },
      }),
      turnInterrupt: vi.fn(),
    };
    const { service } = serviceWithClient(client);
    const internal = service as any;
    internal.saveSessions = vi.fn().mockResolvedValue(undefined);
    internal.sessions.checkpoints = {
      "1-ATTACH": [{
        id: "checkpoint-1",
        sourceThreadId: "thread-a",
        beforeTurnId: "turn-mutating",
        label: "Before metadata update",
        createdAt: "2026-07-23T00:00:00.000Z",
        turnDiff: "--- old\n+++ new",
      }],
    };

    await expect(service.restoreCheckpoint("checkpoint-1")).resolves.toEqual({
      threadId: "thread-restored",
      turnDiff: "--- old\n+++ new",
      filesystemRestored: false,
    });
    expect(client.threadFork).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-a",
      beforeTurnId: "turn-mutating",
    }));
    expect(service.state.activeThreadId).toBe("thread-restored");
  });

  it("offers an explicit terminal fallback hook without starting a second transport", () => {
    const onFallbackRequested = vi.fn();
    const service = new CodexService(
      {} as NativeBridge,
      { tools: [] } as unknown as ReaderContextService,
      "test",
      { onState: vi.fn(), onError: vi.fn(), onFallbackRequested },
    );
    service.state.fallbackReason = "app-server protocol mismatch";

    service.requestTerminalFallback();

    expect(onFallbackRequested).toHaveBeenCalledWith(
      expect.objectContaining({ message: "app-server protocol mismatch" }),
    );
  });
});

describe("CodexService anchors", () => {
  function anchor(id: string): any {
    return {
      anchorId: id, libraryID: 1, itemKey: "PARENT", attachmentKey: "ATTACH",
      pdfSha256: null, selectedText: "s", question: "q", threadId: "thread-a",
      turnRange: [0, 0], status: "open", createdAt: "2026-07-25T00:00:00.000Z",
    };
  }

  it("records, updates, and removes anchors per paper", async () => {
    const { service } = serviceWithClient({});
    (service as any).saveSessions = vi.fn(async () => {});
    const context = paperContext();
    await service.recordAnchor(context, anchor("a1"));
    await service.recordAnchor(context, anchor("a2"));
    expect(service.getAnchors(context).map((a) => a.anchorId)).toEqual(["a1", "a2"]);
    await service.updateAnchor(context, "a1", { status: "resolved", annotationKey: "ANN1" });
    expect(service.getAnchors(context)[0]).toMatchObject({ status: "resolved", annotationKey: "ANN1" });
    await service.removeAnchor(context, "a2");
    expect(service.getAnchors(context).map((a) => a.anchorId)).toEqual(["a1"]);
    expect((service as any).saveSessions).toHaveBeenCalledTimes(4);
  });

  it("returns [] for a paper with no anchors and counts active thread turns", () => {
    const { service } = serviceWithClient({});
    expect(service.getAnchors(paperContext())).toEqual([]);
    (service as any).store = { getThread: () => ({ turns: [{}, {}, {}] }) };
    expect(service.activeThreadTurnCount()).toBe(3);
  });

  it("buckets a recorded anchor by the RECORD's own identity, not the live context passed in (MUST 2)", async () => {
    const { service } = serviceWithClient({});
    (service as any).saveSessions = vi.fn(async () => {});
    // The live context is a different paper than the anchor's own identity --
    // this can happen after a live-context flip mid-turn.
    const liveContext = paperContext();
    const recordAnchor = anchor("a1");
    recordAnchor.libraryID = 2;
    recordAnchor.attachmentKey = "OTHER_ATTACH";

    await service.recordAnchor(liveContext, recordAnchor);

    expect(service.getAnchors(liveContext)).toEqual([]);
    const recordContext: ReaderContext = {
      ...paperContext(),
      attachment: { ...paperContext().attachment, key: "OTHER_ATTACH", libraryID: 2 },
    };
    expect(service.getAnchors(recordContext).map((a) => a.anchorId)).toEqual(["a1"]);
  });

  it("updateAnchor/removeAnchor locate the anchor across buckets, bucket-agnostic (MUST 2)", async () => {
    const { service } = serviceWithClient({});
    (service as any).saveSessions = vi.fn(async () => {});
    const recordContext = paperContext();
    await service.recordAnchor(recordContext, anchor("a1"));

    // Called with a context for a DIFFERENT paper than the anchor's bucket.
    const otherLiveContext: ReaderContext = {
      ...paperContext(),
      attachment: { ...paperContext().attachment, key: "DIFFERENT", libraryID: 9 },
    };
    await service.updateAnchor(otherLiveContext, "a1", { status: "resolved", annotationKey: "ANN1" });
    expect(service.getAnchors(recordContext)[0]).toMatchObject({ status: "resolved", annotationKey: "ANN1" });

    await service.removeAnchor(otherLiveContext, "a1");
    expect(service.getAnchors(recordContext)).toEqual([]);
  });
});

describe("CodexService utility turns", () => {
  it("runs a turn on a hidden thread and resolves with the assistant text", async () => {
    const store = new Map<string, any>();
    store.set("util-1", { turns: [{ id: "t1", status: "completed", items: [
      { id: "i1", type: "agentMessage", text: "两句要点。" },
    ] }] });
    const client = {
      threadStart: vi.fn(async () => ({ thread: { id: "util-1" } })),
      turnStart: vi.fn(async () => ({ turn: { id: "t1" } })),
    };
    const { service } = serviceWithClient(client);
    (service as any).store = { getThread: (id: string) => store.get(id) };
    const pending = service.runUtilityTurn("总结一下", { timeoutMs: 5000 });
    await Promise.resolve();
    // handleNotification's real eventThreadId extraction reads params.threadId
    // (or params.turn.threadId) — not params.thread.id — so the notification
    // below is shaped to match src/codex-service.ts:776-778, not the brief's
    // literal `{ thread: { id } }` shape.
    (service as any).handleNotification({
      method: "turn/completed",
      params: { threadId: "util-1", turn: { id: "t1" } },
    });
    await expect(pending).resolves.toBe("两句要点。");
    expect(service.state.activeThreadId).toBe("thread-a"); // 活动线程未被切换
  });

  it("rejects on timeout", async () => {
    const client = {
      threadStart: vi.fn(async () => ({ thread: { id: "util-2" } })),
      turnStart: vi.fn(async () => ({ turn: { id: "t9" } })),
    };
    const { service } = serviceWithClient(client);
    vi.useFakeTimers();
    const pending = service.runUtilityTurn("x", { timeoutMs: 50 });
    const guarded = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(60);
    expect(String(await guarded)).toContain("超时");
    vi.useRealTimers();
  });

  it("cleans up the waiter if turnStart throws", async () => {
    const client = {
      threadStart: vi.fn(async () => ({ thread: { id: "util-3" } })),
      turnStart: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    const { service } = serviceWithClient(client);
    await expect(service.runUtilityTurn("x", { timeoutMs: 5000 })).rejects.toThrow("network down");
    expect((service as any).utilityWaiters.size).toBe(0);
    expect(service.state.activeThreadId).toBe("thread-a");
    expect(service.state.running).toBe(false);
  });

  it("rejects (not resolves) when the hidden turn fails, so a partial agentMessage is never returned as success", async () => {
    const store = new Map<string, any>();
    // The failed turn still has a partially-streamed agentMessage in the
    // store; runUtilityTurn must never hand this back as if it succeeded.
    store.set("util-4", { turns: [{ id: "t1", status: "failed", items: [
      { id: "i1", type: "agentMessage", text: "半句还没说完" },
    ] }] });
    const client = {
      threadStart: vi.fn(async () => ({ thread: { id: "util-4" } })),
      turnStart: vi.fn(async () => ({ turn: { id: "t1" } })),
    };
    const { service } = serviceWithClient(client);
    (service as any).store = { getThread: (id: string) => store.get(id) };
    const pending = service.runUtilityTurn("总结一下", { timeoutMs: 5000 });
    await Promise.resolve();
    (service as any).handleNotification({
      method: "turn/failed",
      params: { threadId: "util-4", turn: { id: "t1", error: { message: "沙盒被拒绝" } } },
    });
    await expect(pending).rejects.toThrow("沙盒被拒绝");
    expect((service as any).utilityWaiters.size).toBe(0);
    expect(service.state.activeThreadId).toBe("thread-a");
    expect(service.state.running).toBe(false);
  });

  it("reads another thread's turns without touching active state", async () => {
    const client = { threadRead: vi.fn(async () => ({ thread: { id: "old" } })) };
    const { service } = serviceWithClient(client);
    (service as any).store = { getThread: (id: string) => (id === "old" ? { turns: [
      { id: "t1", status: "completed", items: [
        { id: "u1", type: "userMessage", content: [{ type: "text", text: "问" }] },
        { id: "a1", type: "agentMessage", text: "答" },
      ] },
    ] } : undefined) };
    const turns = await service.readThreadTurns("old");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.map((entry) => entry.kind)).toEqual(["user", "assistant"]);
    expect(service.state.activeThreadId).toBe("thread-a");
  });

  it("returns [] when threadRead fails and the store has nothing for the thread", async () => {
    const client = { threadRead: vi.fn(async () => { throw new Error("offline"); }) };
    const { service } = serviceWithClient(client);
    (service as any).store = { getThread: () => undefined };
    await expect(service.readThreadTurns("missing")).resolves.toEqual([]);
  });
});

describe("CodexService entriesForTurn duplicate-user defense (bug-triage #1)", () => {
  it("collapses two userMessage items with different ids but identical text into a single user entry", () => {
    const { service } = serviceWithClient({});
    (service as any).store = {
      getThread: () => ({
        turns: [
          {
            id: "t1",
            status: "completed",
            items: [
              // Index-fallback id from a turn/started snapshot ...
              { id: "t1:item:0", type: "userMessage", content: [{ type: "text", text: "浮点数怎么表示?" }] },
              // ... and the server's real id from a later item/completed notification.
              { id: "real-item-9", type: "userMessage", content: [{ type: "text", text: "浮点数怎么表示?" }] },
              { id: "a1", type: "agentMessage", text: "用 IEEE 754。" },
            ],
          },
        ],
      }),
    };
    const chatEntries = service.getChatEntries();
    const userEntries = chatEntries.filter((entry) => entry.kind === "user");
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]!.text).toBe("浮点数怎么表示?");
    expect(chatEntries.map((entry) => entry.kind)).toEqual(["user", "assistant"]);
  });

  it("keeps both user entries when the texts genuinely differ (steering within the same turn)", () => {
    const { service } = serviceWithClient({});
    (service as any).store = {
      getThread: () => ({
        turns: [
          {
            id: "t1",
            status: "completed",
            items: [
              { id: "u1", type: "userMessage", content: [{ type: "text", text: "先看第 2 节" }] },
              { id: "u2", type: "userMessage", content: [{ type: "text", text: "不,先看摘要" }] },
              { id: "a1", type: "agentMessage", text: "好的。" },
            ],
          },
        ],
      }),
    };
    const userEntries = service.getChatEntries().filter((entry) => entry.kind === "user");
    expect(userEntries.map((entry) => entry.text)).toEqual(["先看第 2 节", "不,先看摘要"]);
  });

  it("does not dedup identical user text across two different turns", () => {
    const { service } = serviceWithClient({});
    (service as any).store = {
      getThread: () => ({
        turns: [
          {
            id: "t1",
            status: "completed",
            items: [
              { id: "u1", type: "userMessage", content: [{ type: "text", text: "重复问题" }] },
              { id: "a1", type: "agentMessage", text: "答一" },
            ],
          },
          {
            id: "t2",
            status: "completed",
            items: [
              { id: "u2", type: "userMessage", content: [{ type: "text", text: "重复问题" }] },
              { id: "a2", type: "agentMessage", text: "答二" },
            ],
          },
        ],
      }),
    };
    const userEntries = service.getChatEntries().filter((entry) => entry.kind === "user");
    expect(userEntries).toHaveLength(2);
    expect(userEntries.map((entry) => entry.text)).toEqual(["重复问题", "重复问题"]);
  });
});
