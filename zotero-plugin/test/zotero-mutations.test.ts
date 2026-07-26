import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ReaderContext } from "../src/reader-context";
import { sha256Bytes } from "../src/hashing";
import {
  ZOTERO_MUTATION_TOOL,
  ZoteroMutationService,
  createZoteroMutationHost,
  parseOperations,
  validatePdfPath,
  type MutationHost,
  type PaperCheckpoint,
  type PaperMutationSnapshot,
  type ZoteroMutationOperation,
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
    resolveReplacementDestination: vi.fn(async (path: string) => path),
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

  it("serializes checkpoint restore with review resolution so their host calls never interleave", async () => {
    const { service, host } = harness();
    await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_fields", fields: { title: "Improved title" } }],
    });

    const order: string[] = [];
    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => { resolve = r; });
      return { promise, resolve };
    };
    const gateRestore = deferred<void>();
    const gateApply = deferred<void>();

    vi.mocked(host.restore).mockImplementation(async () => {
      order.push("start-restore");
      await gateRestore.promise;
      order.push("end-restore");
      return {
        attachmentID: 7,
        attachmentKey: "ATTACH",
        attachmentLibraryID: 1,
        attachmentContentChanged: false,
        attachmentRelinked: false,
        pdfReplaced: false,
      };
    });
    vi.mocked(host.apply).mockImplementation(async () => {
      order.push("start-apply");
      await gateApply.promise;
      order.push("end-apply");
    });

    const flush = async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    };

    // Called in this order: a checkpoint Restore click immediately followed
    // by an unrelated review's Apply click.
    const restorePromise = service.restoreCheckpoint("checkpoint-2");
    const acceptPromise = service.resolveReview("review-1", "accept");

    await flush();
    // The accept's host.apply must never start while the restore's
    // host.restore is still in flight -- proving restore and review
    // resolution share one serialized queue instead of running
    // independently and letting their Zotero writes interleave.
    expect(order).toEqual(["start-restore"]);

    gateRestore.resolve();
    await restorePromise;
    await flush();
    expect(order).toEqual(["start-restore", "end-restore", "start-apply"]);

    gateApply.resolve();
    await acceptPromise;
    expect(order).toEqual(["start-restore", "end-restore", "start-apply", "end-apply"]);
  });
});

describe("diff fidelity: review must show exactly what Apply will write", () => {
  it("keeps every character of a long value instead of hiding the tail past 800 chars", async () => {
    const { service } = harness();
    const longValue = `${"A".repeat(800)}TAIL_MARKER_NEVER_SHOWN_BEFORE`;

    const result = await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_fields", fields: { abstractNote: longValue } }],
    });

    expect(result.diff).toContain("TAIL_MARKER_NEVER_SHOWN_BEFORE");
    expect(result.diff).not.toContain("…");
  });

  it("renders multi-line values line by line with matching diff-sign continuation prefixes, without flattening", async () => {
    const { service } = harness();

    const result = await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_fields", fields: { abstractNote: "First line\nSecond line\nThird line" } }],
    });

    const diffText = String(result.diff);
    expect(diffText).toContain("+ First line");
    expect(diffText).toContain("+   Second line");
    expect(diffText).toContain("+   Third line");
    expect(diffText).not.toContain("First line Second line Third line");
  });

  it("escapes bidi override characters into a visible literal escape instead of passing them through invisibly", async () => {
    const { service } = harness();

    const result = await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_fields", fields: { title: "Evil\u202Etitle" } }],
    });

    const diffText = String(result.diff);
    expect(diffText).toContain("\\u202E");
    expect(diffText).not.toMatch(/\u202E/);
  });

  it("rejects field values beyond the 20000-character reviewable limit instead of silently truncating them", async () => {
    const { service } = harness();

    await expect(service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_fields", fields: { abstractNote: "A".repeat(20_001) } }],
    })).rejects.toThrow("Field abstractNote exceeds the 20000-character reviewable limit");
  });

  it("escapes control characters hidden inside a collection label before they reach the diff", async () => {
    const { service, host } = harness();
    vi.mocked(host.describeCollections).mockResolvedValueOnce(new Map([
      ["ABCDEFGH", "Old collection"],
      ["IJKLMNOP", "Evil\x07Label\x1BHidden"],
    ]));

    const result = await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_collections", collectionKeys: ["IJKLMNOP"] }],
    });

    const diffText = String(result.diff);
    expect(diffText).toContain("\\u0007");
    expect(diffText).toContain("\\u001B");
    expect(diffText).not.toMatch(/[\x00-\x08\x0B-\x1F]/);
  });

  it("sanitizes bidi-override characters in review.title to prevent card/checkpoint label scrambling", async () => {
    const { service } = harness();

    const result = await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      title: "Malicious\u202Etitle",
      operations: [{ type: "set_fields", fields: { title: "New title" } }],
    });

    const review = service.getReviews()[0]!;
    expect(review.title).toContain("\\u202E");
    expect(review.title).not.toMatch(/\u202E/);
  });

  it("sanitizes control/bidi characters in boundedError output to prevent error-message injection", async () => {
    const { service, host } = harness();
    vi.mocked(host.apply).mockRejectedValueOnce(new Error("Error with\u202Ebidi"));

    await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_fields", fields: { title: "New title" } }],
    });

    let errorThrown = "";
    try {
      await service.resolveReview("review-1", "accept");
    }
    catch (e) {
      errorThrown = String(e);
    }

    expect(errorThrown).toContain("\\u202E");
    expect(errorThrown).not.toMatch(/\u202E/);
  });

  it("sanitizes DEL (U+007F) along with other control characters", async () => {
    const { service } = harness();

    const result = await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_fields", fields: { abstractNote: "Text with\x7fDel" } }],
    });

    const diffText = String(result.diff);
    expect(diffText).toContain("\\u007F");
    expect(diffText).not.toMatch(/\x7f/);
  });

  it("escapes zero-width joiners, BOM, word joiner, ALM, and line/paragraph separators into visible literal escapes", async () => {
    const { service } = harness();
    // Every codepoint DANGEROUS_DIFF_CHARS gained in round 3: these can hide
    // text, fake whitespace, or (U+2028/U+2029) inject what looks like a
    // fresh line into a rendered diff -- all invisible in most UIs.
    const attack =
      "A\u200Bb\u200Cc\u200Dd\uFEFFe\u2060f\u061Cg\u2028h\u2029i";

    const result = await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_fields", fields: { title: attack } }],
    });

    const diffText = String(result.diff);
    for (const code of ["200B", "200C", "200D", "FEFF", "2060", "061C", "2028", "2029"]) {
      expect(diffText).toContain(`\\u${code}`);
    }
    expect(diffText).not.toMatch(/[\u200B\u200C\u200D\uFEFF\u2060\u061C\u2028\u2029]/);
  });

  it("escapes soft hyphen, invisible math operators, variation selectors, and astral Tag characters that the round-3 gate missed", async () => {
    const { service } = harness();
    // Empirically unescaped before this fix: U+00AD (soft hyphen, hides
    // inside a word), U+2064 (invisible plus -- adjacent to the already-
    // covered U+2060 but outside its old single-codepoint match), U+FE0F
    // (variation selector-16), and U+E0041 -- a member of the astral Tags
    // block (U+E0000-U+E007F), the "hidden ASCII in emoji" smuggling
    // vector. The old regex lacked the `u` flag, so a `\u{E0000}-\u{E007F}`
    // range wasn't even expressible, and an astral codepoint like this
    // passed through completely unescaped regardless.
    const attack = "A\u00ADb\u2064c\uFE0Fd\u{E0041}e";

    const result = await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_fields", fields: { title: attack } }],
    });

    const diffText = String(result.diff);
    for (const code of ["00AD", "2064", "FE0F"]) {
      expect(diffText).toContain(`\\u${code}`);
    }
    // A plain `\uXXXX` escape can't represent more than 4 hex digits, so
    // the astral codepoint must render in the `\u{XXXXX}` curly-brace form.
    expect(diffText).toContain("\\u{E0041}");
    expect(diffText).not.toMatch(/[\u00AD\u2064\uFE0F\u{E0041}]/u);
  });

  it("inline-escapes a newline embedded in a collection label instead of letting it fake an extra diff line", async () => {
    const { service, host } = harness();
    vi.mocked(host.describeCollections).mockResolvedValueOnce(new Map([
      ["ABCDEFGH", "Old collection"],
      ["IJKLMNOP", "Evil\nLabel"],
    ]));

    const result = await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_collections", collectionKeys: ["IJKLMNOP"] }],
    });

    const diffText = String(result.diff);
    // header(2) + "@@ collections @@"(1) + removed ABCDEFGH(1) + added IJKLMNOP(1).
    // A raw '\n' inside the label would silently add a 6th line here, forging
    // what looks like an extra reviewed diff entry.
    expect(diffText.split("\n")).toHaveLength(5);
    expect(diffText).toContain("Evil\\u000ALabel");
    expect(diffText).not.toMatch(/Evil\nLabel/);
  });

  it("inline-escapes a tab embedded in a collection label the same way", async () => {
    const { service, host } = harness();
    vi.mocked(host.describeCollections).mockResolvedValueOnce(new Map([
      ["ABCDEFGH", "Old collection"],
      ["IJKLMNOP", "Evil\tLabel"],
    ]));

    const result = await service.invokeTool(ZOTERO_MUTATION_TOOL, {
      operations: [{ type: "set_collections", collectionKeys: ["IJKLMNOP"] }],
    });

    const diffText = String(result.diff);
    expect(diffText).toContain("Evil\\u0009Label");
    expect(diffText).not.toMatch(/Evil\tLabel/);
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

// The configured PDF library root used by every relink test below.
// `configuredLibraryRoot()` reads it via `Services.prefs.getStringPref`, so
// each test bed stubs `Services` to return this value rather than falling
// through to the real `Services.dirsvc`-backed `homePath()` default.
const LIBRARY_ROOT = "/library/root";

interface RelinkFsHooks {
  // Keyed by the raw (pre-normalize) path the mock nsIFile was initialized
  // with. Lets a test flip a single path "hostile" (symlink / relocated)
  // independently of every other path the same run touches (including the
  // allowed-root file itself, which goes through the identical stub).
  isSymlink?: (rawPath: string) => boolean;
  normalize?: (rawPath: string) => string;
}

/**
 * Builds a `MutationHost` wired to fully-stubbed Zotero/Components/Services
 * globals, plus the `attachment` stub `relinkAttachmentFile` is asserted
 * against. `hooks` controls the mock nsIFile's `isSymlink()`/`normalize()`
 * behavior per path so tests can simulate symlink leaves, TOCTOU retargeting
 * between calls, and normalize() rewriting a path to its canonical form.
 */
function makeRelinkTestBed(hooks: RelinkFsHooks = {}) {
  const globals = {
    Zotero: (globalThis as any).Zotero,
    PathUtils: (globalThis as any).PathUtils,
    Components: (globalThis as any).Components,
    Services: (globalThis as any).Services,
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
  (globalThis as any).Services = {
    prefs: { getStringPref: (_key: string, fallback: string) => LIBRARY_ROOT || fallback },
    uuid: { generateUUID: () => "{00000000-0000-0000-0000-000000000000}" },
  };
  (globalThis as any).Components = {
    classes: {
      "@mozilla.org/file/local;1": {
        createInstance: () => ({
          path: "",
          initWithPath(path: string) { this.path = path; },
          normalize() { this.path = hooks.normalize ? hooks.normalize(this.path) : this.path; },
          isSymlink() { return hooks.isSymlink ? hooks.isSymlink(this.path) : false; },
        }),
      },
      // Real Node-crypto-backed nsICryptoHash, for the replace_pdf apply
      // path below: it calls sha256Bytes(...) on the (mocked) staged file's
      // read() output to re-derive the fingerprint it compares against a
      // caller-supplied StagedPdfBinding. A stub that returns a fixed digest
      // wouldn't let a test assert a *specific*, independently-computable
      // expected hash, so this drives an actual SHA-256 through the same
      // update()/finish() shape hashing.ts expects.
      "@mozilla.org/security/hash;1": {
        createInstance: () => {
          let chunks: number[] = [];
          return {
            SHA256: 4,
            init() { chunks = []; },
            update(bytes: Uint8Array) { chunks.push(...bytes); },
            finish() {
              const digest = createHash("sha256").update(Uint8Array.from(chunks)).digest();
              return String.fromCharCode(...digest);
            },
          };
        },
      },
    },
    interfaces: { nsIFile: {}, nsICryptoHash: {} },
  };
  const ioUtils = {
    stat: vi.fn(async () => ({ type: "regular", size: 16 })),
    read: vi.fn(async (_path: string, options?: { maxBytes?: number }) => (
      options?.maxBytes ? Uint8Array.from([37, 80, 68, 70, 45]) : new Uint8Array(16)
    )),
    write: vi.fn(async () => {}),
  };
  const host = createZoteroMutationHost(runtime, ioUtils, (globalThis as any).PathUtils);
  const restore = () => {
    if (globals.Zotero === undefined) delete (globalThis as any).Zotero;
    else (globalThis as any).Zotero = globals.Zotero;
    if (globals.PathUtils === undefined) delete (globalThis as any).PathUtils;
    else (globalThis as any).PathUtils = globals.PathUtils;
    if (globals.Components === undefined) delete (globalThis as any).Components;
    else (globalThis as any).Components = globals.Components;
    if (globals.Services === undefined) delete (globalThis as any).Services;
    else (globalThis as any).Services = globals.Services;
  };
  return {
    host,
    attachment,
    ioUtils,
    fulltext: { clearItemWords, queueItem, trigger, executeTransaction },
    restore,
  };
}

describe("createZoteroMutationHost", () => {
  it("clears Zotero full-text state and queues reindexing after relinking", async () => {
    const { host, attachment, fulltext, restore } = makeRelinkTestBed();
    try {
      await host.apply(
        context(),
        snapshot(),
        [{ type: "relink_attachment", newPath: `${LIBRARY_ROOT}/relinked.pdf` }],
        [],
      );

      expect(attachment.relinkAttachmentFile).toHaveBeenCalledWith(`${LIBRARY_ROOT}/relinked.pdf`);
      expect(fulltext.executeTransaction).toHaveBeenCalledOnce();
      expect(fulltext.clearItemWords).toHaveBeenCalledWith(7);
      expect(fulltext.trigger).toHaveBeenCalledWith("modify", "item", [7], { 7: {} });
      expect(fulltext.queueItem).toHaveBeenCalledWith(attachment);
    }
    finally {
      restore();
    }
  });

  describe("relink_attachment containment + symlink/TOCTOU safety", () => {
    it("rejects an absolute relink target outside the configured PDF library root", async () => {
      const { host, attachment, restore } = makeRelinkTestBed();
      try {
        await expect(host.validateOperations(
          context(),
          snapshot(),
          [{ type: "relink_attachment", newPath: "/outside/other.pdf" }],
        )).rejects.toThrow(/library root/i);
        expect(attachment.relinkAttachmentFile).not.toHaveBeenCalled();
      }
      finally {
        restore();
      }
    });

    it("rejects a symlink leaf even when normalize() resolves it to a legitimate in-root target", async () => {
      // Simulates the pre-fix bug: if isSymlink() were checked *after*
      // normalize(), this.path would already be the resolved
      // "legit.pdf" -- which the hook reports as NOT a symlink -- so the
      // check would silently pass. Checking before normalize() (the fix)
      // must still catch the raw symlink leaf.
      const { host, attachment, restore } = makeRelinkTestBed({
        isSymlink: (path) => path === `${LIBRARY_ROOT}/link.pdf`,
        normalize: (path) => path === `${LIBRARY_ROOT}/link.pdf` ? `${LIBRARY_ROOT}/legit.pdf` : path,
      });
      try {
        await expect(host.validateOperations(
          context(),
          snapshot(),
          [{ type: "relink_attachment", newPath: `${LIBRARY_ROOT}/link.pdf` }],
        )).rejects.toThrow("Symbolic-link PDF targets are not accepted");
        expect(attachment.relinkAttachmentFile).not.toHaveBeenCalled();
      }
      finally {
        restore();
      }
    });

    it("rejects at Apply when the target turns hostile after the review already validated it (TOCTOU)", async () => {
      // Also gives normalize() a legitimate-looking resolved target for the
      // hostile leaf -- exactly the shape that would defeat an isSymlink()
      // check that (incorrectly) ran after normalize() instead of before it.
      let hostile = false;
      const rawPath = `${LIBRARY_ROOT}/paper.pdf`;
      const resolvedPath = `${LIBRARY_ROOT}/paper-real.pdf`;
      const { host, attachment, restore } = makeRelinkTestBed({
        isSymlink: (path) => hostile && path === rawPath,
        normalize: (path) => hostile && path === rawPath ? resolvedPath : path,
      });
      try {
        const operations: ZoteroMutationOperation[] = [
          { type: "relink_attachment", newPath: rawPath },
        ];
        // Legitimate at proposal/review time.
        await host.validateOperations(context(), snapshot(), operations);

        // Retargeted to a symlink between review and Apply.
        hostile = true;

        await expect(host.apply(context(), snapshot(), operations, []))
          .rejects.toThrow("Symbolic-link PDF targets are not accepted");
        expect(attachment.relinkAttachmentFile).not.toHaveBeenCalled();
      }
      finally {
        restore();
      }
    });

    it("forwards the canonical (post-normalize) path to relinkAttachmentFile, not the raw operation.newPath", async () => {
      const rawPath = `${LIBRARY_ROOT}/./a.pdf`;
      const canonicalPath = `${LIBRARY_ROOT}/a.pdf`;
      const { host, attachment, restore } = makeRelinkTestBed({
        normalize: (path) => path === rawPath ? canonicalPath : path,
      });
      try {
        const operations: ZoteroMutationOperation[] = [
          { type: "relink_attachment", newPath: rawPath },
        ];

        await host.apply(context(), snapshot(), operations, []);

        expect(attachment.relinkAttachmentFile).toHaveBeenCalledWith(canonicalPath);
        expect(attachment.relinkAttachmentFile).not.toHaveBeenCalledWith(rawPath);
        // validateOperations canonicalizes operation.newPath in place, so the
        // diff (built from the same operations array) also reflects it.
        expect(operations[0]).toMatchObject({ newPath: canonicalPath });
      }
      finally {
        restore();
      }
    });

    it("refuses to relink when the target's canonical resolution shifts between apply's own pre-check and its write-time re-validation", async () => {
      // apply() re-validates the relink target twice in quick succession:
      // once via its shared top-level validateOperations() call, then again
      // (write-time) inside the relink branch itself, right before
      // relinkAttachmentFile is invoked -- with real Zotero.Items lookups
      // awaited in between. A symlink parent directory swapped in that
      // window would make the two calls resolve to different canonical
      // paths; a stub whose normalize() mapping for the *target* path is
      // unstable across calls simulates exactly that, without needing real
      // wall-clock timing. (Only the target path's mapping is call-counted --
      // the allowed-root path also runs through normalize() during the
      // containment check, and must keep resolving to itself or every call
      // would spuriously fail containment instead.)
      const targetPath = `${LIBRARY_ROOT}/paper.pdf`;
      const firstCanonical = targetPath;
      const retargetedCanonical = `${LIBRARY_ROOT}/paper-retargeted.pdf`;
      let targetNormalizeCalls = 0;
      const { host, attachment, restore } = makeRelinkTestBed({
        normalize: (path) => {
          if (path !== targetPath) return path;
          targetNormalizeCalls += 1;
          return targetNormalizeCalls === 1 ? firstCanonical : retargetedCanonical;
        },
      });
      try {
        const operations: ZoteroMutationOperation[] = [
          { type: "relink_attachment", newPath: targetPath },
        ];

        await expect(host.apply(context(), snapshot(), operations, []))
          .rejects.toThrow("The relink target's real path changed after review. Generate a fresh proposal.");
        expect(attachment.relinkAttachmentFile).not.toHaveBeenCalled();
      }
      finally {
        restore();
      }
    });
  });

  describe("replace_pdf destination containment + symlink/TOCTOU safety", () => {
    it("rejects resolving a replacement destination that is itself a symlink leaf", async () => {
      const { host, restore } = makeRelinkTestBed({
        isSymlink: (path) => path === "/papers/paper.pdf",
      });
      try {
        await expect(host.resolveReplacementDestination("/papers/paper.pdf"))
          .rejects.toThrow("Symbolic-link PDF targets are not accepted");
      }
      finally {
        restore();
      }
    });

    it("refuses to write and touches no bytes when the destination's canonical path no longer matches the reviewed binding (TOCTOU)", async () => {
      // The binding below simulates one staged at propose time, pinning
      // destinationCanonicalPath to the attachment's real path *then*.
      // Flipping `retargeted` simulates a symlinked parent directory
      // swapped in the window between that proposal and this Apply.
      const targetPath = "/papers/paper.pdf";
      let retargeted = false;
      const { host, ioUtils, restore } = makeRelinkTestBed({
        normalize: (path) => (retargeted && path === targetPath) ? "/papers/paper-retargeted.pdf" : path,
      });
      try {
        const stagedPdfBindings = [{
          operationIndex: 0,
          stagedPath: "/profile/papers/1-ATTACH/output.pdf",
          canonicalPath: "/profile/papers/1-ATTACH/output.pdf",
          size: 16,
          sha256: sha256Bytes(new Uint8Array(16)),
          destinationCanonicalPath: targetPath,
        }];
        retargeted = true;

        const operations: ZoteroMutationOperation[] = [
          { type: "replace_pdf", stagedPath: "/profile/papers/1-ATTACH/output.pdf" },
        ];
        await expect(host.apply(context(), snapshot(), operations, stagedPdfBindings))
          .rejects.toThrow("The replacement target's real path changed after review. Generate a fresh proposal.");
        expect(ioUtils.write).not.toHaveBeenCalled();
      }
      finally {
        restore();
      }
    });

    it("rejects Apply when the staged PDF binding is missing its destination fingerprint", async () => {
      const { host, ioUtils, restore } = makeRelinkTestBed();
      try {
        // Simulates a binding built before destinationCanonicalPath existed
        // (in-memory state only -- bindings are never persisted -- but
        // defended against regardless of how it could arise).
        const stagedPdfBindings = [{
          operationIndex: 0,
          stagedPath: "/profile/papers/1-ATTACH/output.pdf",
          canonicalPath: "/profile/papers/1-ATTACH/output.pdf",
          size: 16,
          sha256: sha256Bytes(new Uint8Array(16)),
        } as any];

        const operations: ZoteroMutationOperation[] = [
          { type: "replace_pdf", stagedPath: "/profile/papers/1-ATTACH/output.pdf" },
        ];
        await expect(host.apply(context(), snapshot(), operations, stagedPdfBindings))
          .rejects.toThrow("The staged PDF binding is missing its destination fingerprint");
        expect(ioUtils.write).not.toHaveBeenCalled();
      }
      finally {
        restore();
      }
    });

    it("writes to the canonical destination path, not the raw attachment path, when normalize() rewrites it", async () => {
      const rawTarget = "/papers/paper.pdf";
      const canonicalTarget = "/real/papers/paper.pdf";
      const { host, ioUtils, restore } = makeRelinkTestBed({
        normalize: (path) => path === rawTarget ? canonicalTarget : path,
      });
      try {
        const stagedPath = "/profile/papers/1-ATTACH/output.pdf";
        const stagedPdfBindings = [{
          operationIndex: 0,
          stagedPath,
          canonicalPath: stagedPath,
          size: 16,
          sha256: sha256Bytes(new Uint8Array(16)),
          destinationCanonicalPath: canonicalTarget,
        }];

        const operations: ZoteroMutationOperation[] = [
          { type: "replace_pdf", stagedPath },
        ];
        await host.apply(context(), snapshot(), operations, stagedPdfBindings);

        expect(ioUtils.write).toHaveBeenCalledWith(
          canonicalTarget,
          expect.anything(),
          expect.objectContaining({ tmpPath: expect.stringContaining(canonicalTarget) }),
        );
        expect(ioUtils.write).not.toHaveBeenCalledWith(rawTarget, expect.anything(), expect.anything());
      }
      finally {
        restore();
      }
    });
  });

  describe("validatePdfPath empty-root fail-closed", () => {
    it("rejects PDF when allowedRoots is an array with only an empty string", async () => {
      const { host, ioUtils, restore } = makeRelinkTestBed();
      try {
        await expect(validatePdfPath(
          "/anywhere/x.pdf",
          [""],
          ioUtils,
          "test containment error"
        )).rejects.toThrow("test containment error");
      }
      finally {
        restore();
      }
    });

    it("rejects PDF when allowedRoots contains null (type-unsafe)", async () => {
      const { host, ioUtils, restore } = makeRelinkTestBed();
      try {
        await expect(validatePdfPath(
          "/anywhere/x.pdf",
          [null as any],
          ioUtils,
          "test containment error"
        )).rejects.toThrow("test containment error");
      }
      finally {
        restore();
      }
    });

    it("rejects PDF when allowedRoots is an array with only a root slash", async () => {
      const { host, ioUtils, restore } = makeRelinkTestBed();
      try {
        await expect(validatePdfPath(
          "/anywhere/x.pdf",
          ["/"],
          ioUtils,
          "test containment error"
        )).rejects.toThrow("test containment error");
      }
      finally {
        restore();
      }
    });

    it("accepts PDF when allowedRoots contains a valid path alongside invalid entries", async () => {
      const { ioUtils, restore } = makeRelinkTestBed();
      try {
        const result = await validatePdfPath(
          "/valid/x.pdf",
          ["", "/valid"],
          ioUtils
        );
        expect(result).toMatchObject({
          canonicalPath: "/valid/x.pdf",
          size: 16
        });
      }
      finally {
        restore();
      }
    });
  });
});
