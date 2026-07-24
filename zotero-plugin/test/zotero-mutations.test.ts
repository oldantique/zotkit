import { describe, expect, it, vi } from "vitest";
import type { ReaderContext } from "../src/reader-context";
import {
  ZOTERO_MUTATION_TOOL,
  ZoteroMutationService,
  createZoteroMutationHost,
  parseOperations,
  type MutationHost,
  type PaperCheckpoint,
  type PaperMutationSnapshot,
} from "../src/zotero-mutations";

function context(key = "ATTACH"): ReaderContext {
  return {
    schemaVersion: 1,
    capturedAt: "2026-07-23T00:00:00.000Z",
    attachment: {
      id: 7,
      key,
      libraryID: 1,
      title: "paper.pdf",
      creators: [],
      tags: [],
      filename: "paper.pdf",
    },
    parent: {
      id: 6,
      key: "PARENT",
      libraryID: 1,
      title: "Current title",
      creators: [],
      tags: [],
    },
    pdfPath: "/papers/paper.pdf",
    page: { pageIndex: 0, pageNumber: 1, text: "page", source: "pdfjs", warnings: [] },
    selection: null,
    fullText: { source: "deferred", characters: 0 },
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
  };
}

function snapshot(title = "Current title"): PaperMutationSnapshot {
  return {
    schemaVersion: 1,
    paper: {
      id: 6,
      key: "PARENT",
      libraryID: 1,
      fields: {
        title,
        abstractNote: "",
        date: "2026",
        DOI: "",
        url: "",
        extra: "",
      },
      collectionKeys: ["ABCDEFGH"],
    },
    attachment: {
      id: 7,
      key: "ATTACH",
      libraryID: 1,
      rawPath: "/papers/paper.pdf",
      resolvedPath: "/papers/paper.pdf",
      linkMode: 2,
    },
  };
}

function harness() {
  let activeContext = context();
  let currentSnapshot = snapshot();
  const checkpoint: PaperCheckpoint = {
    schemaVersion: 1,
    id: "checkpoint-2",
    label: "Rename paper",
    createdAt: "2026-07-23T00:00:01.000Z",
    paperIdentity: "1-ATTACH",
    snapshot: currentSnapshot,
    pdfBackupPath: null,
    pdfBackupBytes: 0,
  };
  const host: MutationHost = {
    snapshot: vi.fn(async () => structuredClone(currentSnapshot)),
    describeCollections: vi.fn(async () => new Map([
      ["ABCDEFGH", "Old collection"],
      ["IJKLMNOP", "New collection"],
    ])),
    validateOperations: vi.fn(async () => {}),
    fingerprintPdf: vi.fn(async (_context, path) => ({
      canonicalPath: path,
      size: 128,
      sha256: "a".repeat(64),
    })),
    createCheckpoint: vi.fn(async () => checkpoint),
    apply: vi.fn(async () => {}),
    restore: vi.fn(async () => ({
      attachmentID: 7,
      attachmentKey: "ATTACH",
      attachmentLibraryID: 1,
      attachmentContentChanged: false,
      attachmentRelinked: false,
      pdfReplaced: false,
    })),
    readCheckpoints: vi.fn(async () => [checkpoint]),
    pruneCheckpoints: vi.fn(async () => {}),
  };
  const onState = vi.fn();
  let sequence = 0;
  const service = new ZoteroMutationService(
    host,
    { onState, getContext: () => activeContext },
    () => new Date("2026-07-23T00:00:00.000Z"),
    (prefix) => `${prefix}-${++sequence}`,
  );
  return {
    service,
    host,
    onState,
    setContext: (next: ReaderContext) => { activeContext = next; },
    setSnapshot: (next: PaperMutationSnapshot) => { currentSnapshot = next; },
  };
}

describe("ZoteroMutationService", () => {
  it("turns an Agent tool call into a pending diff without applying anything", async () => {
    const { service, host } = harness();

    const result = await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      title: "Rename paper",
      operations: [
        { type: "set_fields", fields: { title: "Improved title" } },
        { type: "set_collections", collectionKeys: ["IJKLMNOP"] },
      ],
    });

    expect(result.status).toBe("awaiting_user_review");
    expect(host.apply).not.toHaveBeenCalled();
    expect(service.getReviews()[0]).toMatchObject({
      id: "review-1",
      state: "pending",
      title: "Rename paper",
    });
    expect(service.getReviews()[0]?.diff).toContain("- Current title");
    expect(service.getReviews()[0]?.diff).toContain("+ Improved title");
    expect(service.getReviews()[0]?.diff).toContain("New collection (IJKLMNOP)");
  });

  it("creates a checkpoint only after the user accepts the diff", async () => {
    const { service, host } = harness();
    await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "replace_pdf", stagedPath: "/profile/papers/1-ATTACH/output.pdf" }],
    });

    await service.resolveReview("review-1", "accept");

    expect(host.createCheckpoint).toHaveBeenCalledWith(
      "checkpoint-2",
      expect.any(String),
      expect.objectContaining({ attachment: expect.objectContaining({ key: "ATTACH" }) }),
      expect.any(Object),
      true,
    );
    expect(host.apply).toHaveBeenCalledOnce();
    expect(host.apply).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(Array),
      [expect.objectContaining({
        operationIndex: 0,
        size: 128,
        sha256: "a".repeat(64),
      })],
    );
    expect(service.getReviews()[0]?.state).toBe("accepted");
  });

  it("binds the reviewed PDF digest and refuses Apply if the staged bytes change", async () => {
    const { service, host } = harness();
    vi.mocked(host.fingerprintPdf)
      .mockResolvedValueOnce({ canonicalPath: "/profile/papers/1-ATTACH/output.pdf", size: 128, sha256: "a".repeat(64) })
      .mockResolvedValueOnce({ canonicalPath: "/profile/papers/1-ATTACH/output.pdf", size: 129, sha256: "b".repeat(64) });
    await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "replace_pdf", stagedPath: "/profile/papers/1-ATTACH/output.pdf" }],
    });

    await expect(service.resolveReview("review-1", "accept"))
      .rejects.toThrow("staged PDF changed after this diff was prepared");
    expect(host.apply).not.toHaveBeenCalled();
    expect(service.getReviews()[0]).toMatchObject({ state: "failed" });
    expect(await service.getCheckpoints()).toEqual([
      expect.objectContaining({ id: "checkpoint-2" }),
    ]);
  });

  it("surfaces an automatic rollback failure and retains its safety checkpoint", async () => {
    const { service, host } = harness();
    vi.mocked(host.apply).mockRejectedValueOnce(new Error("write failed"));
    vi.mocked(host.restore).mockRejectedValueOnce(new Error("restore failed"));
    await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "replace_pdf", stagedPath: "/profile/papers/1-ATTACH/output.pdf" }],
    });

    await expect(service.resolveReview("review-1", "accept"))
      .rejects.toThrow(/write failed.*rollback also failed.*restore failed.*checkpoint-2/i);
    expect(service.getReviews()[0]).toMatchObject({ state: "failed" });
    expect(await service.getCheckpoints()).toEqual([
      expect.objectContaining({ id: "checkpoint-2" }),
    ]);
  });

  it("refuses Apply after the Reader switched to a different PDF", async () => {
    const { service, host, setContext } = harness();
    await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_fields", fields: { title: "Improved title" } }],
    });
    setContext(context("OTHERKEY"));

    await expect(service.resolveReview("review-1", "accept"))
      .rejects.toThrow("active Zotero paper changed");
    expect(host.createCheckpoint).not.toHaveBeenCalled();
    expect(host.apply).not.toHaveBeenCalled();
  });

  it("refuses Apply when the Zotero record changed after preview", async () => {
    const { service, host, setSnapshot } = harness();
    await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_fields", fields: { title: "Improved title" } }],
    });
    setSnapshot(snapshot("Changed elsewhere"));

    await expect(service.resolveReview("review-1", "accept"))
      .rejects.toThrow("changed after this diff was prepared");
    expect(host.apply).not.toHaveBeenCalled();
  });

  it("restores persisted checkpoints only while their paper is active", async () => {
    const { service, host, setContext } = harness();
    expect(await service.getCheckpoints()).toEqual([{
      id: "checkpoint-2",
      label: "Rename paper",
      createdAt: "2026-07-23T00:00:01.000Z",
    }]);

    await service.restoreCheckpoint("checkpoint-2");
    expect(host.restore).toHaveBeenCalledOnce();

    setContext(context("OTHERKEY"));
    await expect(service.restoreCheckpoint("checkpoint-2"))
      .rejects.toThrow("Open the checkpoint's paper");
  });

  it("rejects a concurrent second accept on the same review and applies only once", async () => {
    const { service, host } = harness();
    await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_fields", fields: { title: "Improved title" } }],
    });

    const first = service.resolveReview("review-1", "accept");
    await expect(service.resolveReview("review-1", "accept"))
      .rejects.toThrow("This change review was already resolved or is being applied");

    await expect(first).resolves.toMatchObject({ decision: "accepted" });
    expect(host.createCheckpoint).toHaveBeenCalledOnce();
    expect(host.apply).toHaveBeenCalledOnce();
  });

  it("refuses a second accept after replace_pdf already completed, so the rollback checkpoint is never overwritten", async () => {
    const { service, host } = harness();
    await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "replace_pdf", stagedPath: "/profile/papers/1-ATTACH/output.pdf" }],
    });

    await service.resolveReview("review-1", "accept");
    expect(host.createCheckpoint).toHaveBeenCalledOnce();
    expect(host.apply).toHaveBeenCalledOnce();

    await expect(service.resolveReview("review-1", "accept"))
      .rejects.toThrow("This change review was already resolved or is being applied");

    // The second click must never re-run snapshot -> checkpoint -> apply: doing
    // so would back up the already-replaced PDF bytes as "original.pdf" and
    // destroy the only usable rollback checkpoint.
    expect(host.createCheckpoint).toHaveBeenCalledOnce();
    expect(host.apply).toHaveBeenCalledOnce();
  });

  it("refuses accept after the review was already rejected", async () => {
    const { service, host } = harness();
    await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_fields", fields: { title: "Improved title" } }],
    });

    await service.resolveReview("review-1", "reject");
    expect(service.getReviews()[0]?.state).toBe("rejected");

    await expect(service.resolveReview("review-1", "accept"))
      .rejects.toThrow("This change review was already resolved or is being applied");
    expect(host.createCheckpoint).not.toHaveBeenCalled();
    expect(host.apply).not.toHaveBeenCalled();
  });

  it("serializes concurrent accepts for different reviews without interleaving their apply calls", async () => {
    const { service, host } = harness();
    await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_fields", fields: { title: "Title A" } }],
    });
    await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_fields", fields: { title: "Title B" } }],
    });

    const order: string[] = [];
    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => { resolve = r; });
      return { promise, resolve };
    };
    const gateA = deferred<void>();
    const gateB = deferred<void>();

    vi.mocked(host.apply).mockImplementation(async (_context, _current, operations) => {
      const label = (operations[0] as { type: "set_fields"; fields: { title?: string } }).fields.title === "Title A" ? "A" : "B";
      order.push(`start-${label}`);
      await (label === "A" ? gateA.promise : gateB.promise);
      order.push(`end-${label}`);
    });

    const flush = async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    };

    const acceptA = service.resolveReview("review-1", "accept");
    const acceptB = service.resolveReview("review-2", "accept");

    await flush();
    // Review B must never start applying while review A's run is still in
    // flight, proving the queue serializes rather than interleaves.
    expect(order).toEqual(["start-A"]);

    gateA.resolve();
    await acceptA;
    await flush();
    expect(order).toEqual(["start-A", "end-A", "start-B"]);

    gateB.resolve();
    await acceptB;
    expect(order).toEqual(["start-A", "end-A", "start-B", "end-B"]);
  });
});

describe("parseOperations", () => {
  it("rejects unknown fields, malformed collection keys, and empty operations", () => {
    expect(() => parseOperations([])).toThrow("between 1 and 20");
    expect(() => parseOperations([{ type: "set_fields", fields: { creators: "x" } }]))
      .toThrow("not editable");
    expect(() => parseOperations([{ type: "set_collections", collectionKeys: ["bad"] }]))
      .toThrow("Invalid Zotero collection key");
    expect(() => parseOperations([
      { type: "relink_attachment", newPath: "/papers/other.pdf" },
      { type: "replace_pdf", stagedPath: "/profile/staged.pdf" },
    ])).toThrow("cannot be combined");
  });
});

describe("createZoteroMutationHost", () => {
  it("clears Zotero full-text state and queues reindexing after relinking", async () => {
    const globals = {
      Zotero: (globalThis as any).Zotero,
      PathUtils: (globalThis as any).PathUtils,
      Components: (globalThis as any).Components,
    };
    const attachment = {
      id: 7,
      key: "ATTACH",
      libraryID: 1,
      attachmentPath: "/papers/paper.pdf",
      attachmentLinkMode: 2,
      relinkAttachmentFile: vi.fn(async (path: string) => { attachment.attachmentPath = path; }),
    };
    const paper = { id: 6, key: "PARENT", libraryID: 1 };
    const clearItemWords = vi.fn(async () => {});
    const queueItem = vi.fn(async () => {});
    const trigger = vi.fn(async () => {});
    const executeTransaction = vi.fn(async (callback: () => Promise<void>) => callback());
    const runtime = {
      Items: {
        getAsync: vi.fn(async (id: number) => id === 7 ? attachment : paper),
        loadDataTypes: vi.fn(async () => {}),
      },
      Attachments: { LINK_MODE_LINKED_FILE: 2 },
      Fulltext: { clearItemWords, queueItem },
      DB: { executeTransaction },
      Notifier: { trigger },
    };
    (globalThis as any).Zotero = { Profile: { dir: "/profile" } };
    (globalThis as any).PathUtils = { join: (...parts: string[]) => parts.join("/").replace(/\/{2,}/g, "/") };
    (globalThis as any).Components = {
      classes: {
        "@mozilla.org/file/local;1": {
          createInstance: () => ({
            path: "",
            initWithPath(path: string) { this.path = path; },
            normalize() {},
            isSymlink: () => false,
          }),
        },
      },
      interfaces: { nsIFile: {} },
    };
    const ioUtils = {
      stat: vi.fn(async () => ({ type: "regular", size: 16 })),
      read: vi.fn(async (_path: string, options?: { maxBytes?: number }) => (
        options?.maxBytes ? Uint8Array.from([37, 80, 68, 70, 45]) : new Uint8Array(16)
      )),
    };

    try {
      const host = createZoteroMutationHost(runtime, ioUtils, (globalThis as any).PathUtils);
      await host.apply(
        context(),
        snapshot(),
        [{ type: "relink_attachment", newPath: "/papers/relinked.pdf" }],
        [],
      );

      expect(attachment.relinkAttachmentFile).toHaveBeenCalledWith("/papers/relinked.pdf");
      expect(executeTransaction).toHaveBeenCalledOnce();
      expect(clearItemWords).toHaveBeenCalledWith(7);
      expect(trigger).toHaveBeenCalledWith("modify", "item", [7], { 7: {} });
      expect(queueItem).toHaveBeenCalledWith(attachment);
    }
    finally {
      if (globals.Zotero === undefined) delete (globalThis as any).Zotero;
      else (globalThis as any).Zotero = globals.Zotero;
      if (globals.PathUtils === undefined) delete (globalThis as any).PathUtils;
      else (globalThis as any).PathUtils = globals.PathUtils;
      if (globals.Components === undefined) delete (globalThis as any).Components;
      else (globalThis as any).Components = globals.Components;
    }
  });
});
