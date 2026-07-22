import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  READER_CONTEXT_TOOLS,
  READER_TOOL_NAMES,
  ReaderContextService,
  StaleReaderCaptureError,
  createGeckoProfileAdapter,
  createZotero9ReadAdapter,
  renderAgentInstructions,
  renderZotkitLibrarySnapshot,
  searchPageText,
  type AttachmentMetadata,
  type LibraryFileEntry,
  type ReaderAnnotation,
  type ReaderContextHostAdapter,
  type ReaderHook,
  type ReaderPageStats,
  type ReaderSelection,
  type ZoteroItemMetadata,
  type ZoteroReadAdapter,
  type ZotkitLibrarySnapshot,
} from "../src/reader-context";

interface MockReader {
  id: string;
}

interface MockItem {
  id: number;
  key: string;
  kind: "attachment" | "parent";
}

class MemoryHost implements ReaderContextHostAdapter {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly replaceCalls: Array<{ path: string; text: string }> = [];
  readonly pruneCalls: Array<{
    root: string;
    keepDirectory: string;
    maxEntries: number;
    maxAgeMs: number;
    nowMs: number;
  }> = [];
  readonly workspaceModified = new Map<string, number>();
  entries: LibraryFileEntry[] = [];
  scanCalls: Array<{ root: string; maxDepth: number; maxFiles: number }> = [];

  async getProfileWorkspaceRoot(): Promise<string> {
    return "/profile/zoterochat/reader-context";
  }

  joinPath(...parts: string[]): string {
    return parts.join("/").replace(/\/{2,}/g, "/");
  }

  async ensureProfileDirectory(path: string): Promise<void> {
    this.directories.add(path);
  }

  async replaceProfileText(path: string, text: string): Promise<void> {
    if (!path.startsWith("/profile/zoterochat/reader-context/")) {
      throw new Error("test host rejected profile escape");
    }
    this.replaceCalls.push({ path, text });
    this.files.set(path, text);
    if (path.endsWith("/context.json")) {
      const workspace = path.slice(0, -"/context.json".length);
      try {
        const capturedAt = JSON.parse(text).capturedAt;
        this.workspaceModified.set(workspace, Date.parse(capturedAt));
      } catch {
        this.workspaceModified.set(workspace, Date.now());
      }
    }
  }

  async pruneProfileWorkspaceCache(
    root: string,
    options: {
      keepDirectory: string;
      maxEntries: number;
      maxAgeMs: number;
      nowMs: number;
    },
  ): Promise<{ removed: string[]; removedFiles: string[]; skipped: string[] }> {
    this.pruneCalls.push({ root, ...options });
    const workspaces = [...this.directories]
      .filter((path) => path.startsWith(`${root}/`) && !path.slice(root.length + 1).includes("/"))
      .map((path) => ({ path, modified: this.workspaceModified.get(path) ?? options.nowMs }));
    const removal = new Set(
      workspaces
        .filter(({ path, modified }) =>
          path !== options.keepDirectory && options.nowMs - modified > options.maxAgeMs)
        .map(({ path }) => path),
    );
    const survivors = workspaces
      .filter(({ path }) => !removal.has(path))
      .sort((left, right) => left.modified - right.modified);
    let excess = Math.max(0, survivors.length - options.maxEntries);
    for (const workspace of survivors) {
      if (!excess) break;
      if (workspace.path === options.keepDirectory) continue;
      removal.add(workspace.path);
      excess -= 1;
    }
    const removedFiles: string[] = [];
    for (const { path: workspace } of workspaces) {
      const legacy = `${workspace}/paper-fulltext.txt`;
      if (this.files.delete(legacy)) removedFiles.push(legacy);
    }
    for (const workspace of removal) {
      this.directories.delete(workspace);
      this.workspaceModified.delete(workspace);
      for (const path of [...this.files.keys()]) {
        if (path.startsWith(`${workspace}/`)) this.files.delete(path);
      }
    }
    return { removed: [...removal], removedFiles, skipped: [] };
  }

  async scanLibraryFileNames(
    root: string,
    options: { maxDepth: number; maxFiles: number },
  ): Promise<LibraryFileEntry[]> {
    this.scanCalls.push({ root, ...options });
    return this.entries;
  }

  async resolveLibraryPdfPath(
    root: string,
    relativePath: string,
  ): Promise<LibraryFileEntry | null> {
    const normalized = relativePath.replace(/\\/g, "/");
    return this.entries.find((entry) => {
      const entryRelative = entry.relativePath
        ?? entry.path.slice(root.replace(/\/+$/, "").length).replace(/^\/+/, "");
      return entryRelative === normalized && entry.path.startsWith(`${root.replace(/\/+$/, "")}/`);
    }) ?? null;
  }
}

function makeMetadata(): {
  attachment: AttachmentMetadata;
  parent: ZoteroItemMetadata;
} {
  return {
    attachment: {
      id: 17,
      key: "ATTACH01",
      libraryID: 1,
      parentID: 10,
      itemType: "attachment",
      title: "Paper PDF",
      filename: "paper.pdf",
      contentType: "application/pdf",
      creators: [],
      tags: [],
    },
    parent: {
      id: 10,
      key: "PARENT01",
      libraryID: 1,
      itemType: "journalArticle",
      title: "A Read-Only Research Paper",
      creators: [{ firstName: "Ada", lastName: "Lovelace", creatorType: "author" }],
      date: "2025-03-12",
      year: "2025",
      doi: "10.1000/read-only",
      tags: ["test"],
    },
  };
}

function makeAdapter(overrides: Partial<ZoteroReadAdapter<MockReader, MockItem>> = {}): {
  adapter: ZoteroReadAdapter<MockReader, MockItem>;
  reader: MockReader;
  attachment: MockItem;
  parent: MockItem;
} {
  const metadata = makeMetadata();
  const reader: MockReader = { id: "reader-1" };
  const attachment: MockItem = { id: 17, key: "ATTACH01", kind: "attachment" };
  const parent: MockItem = { id: 10, key: "PARENT01", kind: "parent" };
  const hook: ReaderHook<MockReader, MockItem> = {
    reader,
    item: attachment,
    capturedAt: "2026-07-22T10:00:00.000Z",
  };
  const adapter: ZoteroReadAdapter<MockReader, MockItem> = {
    getActiveReaderHook: vi.fn(async () => hook),
    resolveAttachment: vi.fn(async () => attachment),
    resolveParent: vi.fn(async () => parent),
    describeAttachment: vi.fn(async () => metadata.attachment),
    describeItem: vi.fn(async () => metadata.parent),
    getPdfPath: vi.fn(async () => "/papers/paper.pdf"),
    getPageStats: vi.fn(async (): Promise<ReaderPageStats> => ({
      pageIndex: 1,
      pageNumber: 2,
      pageCount: 3,
      pageLabel: "2",
    })),
    getSelection: vi.fn(async (): Promise<ReaderSelection> => ({
      text: "selected theorem",
      pageIndex: 1,
      pageNumber: 2,
      annotationKey: "ANN-SEL",
      annotationType: "highlight",
      capturedAt: "2026-07-22T10:00:00.000Z",
    })),
    extractPdfJsPage: vi.fn(async (_reader, pageIndex) => `PDF.js page ${pageIndex + 1}`),
    readIndexedFullText: vi.fn(async () => ({
      text: "first page\fsecond theorem page\fthird page",
      extractedPages: 3,
      totalPages: 3,
    })),
    readPdfWorkerText: vi.fn(async (_item: MockItem, pageIndexes: readonly number[] | null) => {
      const pages = ["worker first", "worker second", "worker third"];
      const selected = pageIndexes ?? [0, 1, 2];
      return {
        text: selected.map((index) => pages[index]).join("\f"),
        extractedPages: selected.length,
        totalPages: 3,
      };
    }),
    findLoadedAttachmentByPath: vi.fn(async () => ({
      status: "matched" as const,
      attachment,
      candidateCount: 1,
    })),
    listAnnotations: vi.fn(async (): Promise<ReaderAnnotation[]> => [
      { key: "ANN-B", text: "page two", pageIndex: 1, pageNumber: 2 },
      { key: "ANN-A", text: "page one", pageIndex: 0, pageNumber: 1 },
    ]),
    ...overrides,
  };
  return { adapter, reader, attachment, parent };
}

describe("ReaderContextService", () => {
  let host: MemoryHost;

  beforeEach(() => {
    host = new MemoryHost();
  });

  it("captures live context into five small profile files without duplicating the PDF", async () => {
    const { adapter, reader, attachment } = makeAdapter();
    const service = new ReaderContextService(adapter, host, {
      libraryRoot: "/configured/library",
      now: () => new Date("2026-07-22T10:00:00.000Z"),
    });

    const context = await service.acceptReaderHook({
      reader,
      item: attachment,
      selectionAnnotation: { text: "selected theorem" },
      capturedAt: "2026-07-22T10:00:00.000Z",
    });

    expect(context.attachment.key).toBe("ATTACH01");
    expect(context.parent).toMatchObject({
      key: "PARENT01",
      title: "A Read-Only Research Paper",
      doi: "10.1000/read-only",
    });
    expect(context.pdfPath).toBe("/papers/paper.pdf");
    expect(context.page).toMatchObject({
      pageIndex: 1,
      pageNumber: 2,
      pageCount: 3,
      text: "PDF.js page 2",
      source: "pdfjs",
    });
    expect(context.selection).toMatchObject({
      text: "selected theorem",
      pageNumber: 2,
      annotationKey: "ANN-SEL",
    });
    expect(context.workspace?.root).toBe(
      "/profile/zoterochat/reader-context/papers/1-ATTACH01",
    );

    const expectedNames = [
      "context.json",
      "current-page.md",
      "current-selection.md",
      "AGENTS.md",
      "CLAUDE.md",
    ];
    expect([...host.files.keys()].map((path) => path.split("/").pop()).sort()).toEqual(
      expectedNames.sort(),
    );
    expect(host.replaceCalls).toHaveLength(5);
    expect(host.files.get(context.workspace!.currentPage)).toContain("PDF.js page 2");
    expect(host.files.get(context.workspace!.currentSelection)).toContain("selected theorem");
    expect(host.files.get(context.workspace!.agents)).toContain("zotero_get_reader_context");
    expect(host.files.get(context.workspace!.claude)).toBe(
      host.files.get(context.workspace!.agents),
    );
    const diskContext = JSON.parse(host.files.get(context.workspace!.context)!);
    expect(diskContext).toMatchObject({
      attachment: { key: "ATTACH01" },
      pdfPath: "/papers/paper.pdf",
      fullText: { source: "deferred", characters: 0 },
      workspace: { root: context.workspace!.root },
    });
    expect(diskContext.page.text).toBeUndefined();
    expect(diskContext.selection.text).toBeUndefined();
    expect([...host.files.keys()].some((path) => path.endsWith("paper-fulltext.txt"))).toBe(false);
    expect(adapter.readIndexedFullText).not.toHaveBeenCalled();
    expect(adapter.readPdfWorkerText).not.toHaveBeenCalled();
  });

  it("builds one shared library snapshot only on terminal-open or explicit refresh", async () => {
    let nowMs = Date.parse("2026-07-22T10:00:00.000Z");
    const buildZotkitLibrarySnapshot = vi.fn(async (libraryID): Promise<ZotkitLibrarySnapshot> => ({
      schemaVersion: 1,
      libraryID,
      generatedAt: new Date(nowMs).toISOString(),
      complete: true,
      collections: [{
        key: "COLL0001",
        name: "Quantum",
        parentKey: null,
        path: "Quantum",
        version: 1,
      }],
      tags: [{ tag: "topic:quantum", count: 1 }],
      items: [{
        _topLevel: true,
        key: "PARENT01",
        itemType: "journalArticle",
        title: "A Read-Only Research Paper",
        creators: [],
        date: "2025",
        publicationTitle: "Journal",
        DOI: "10.1000/read-only",
        url: "",
        abstractNote: "",
        language: "en",
        tags: ["topic:quantum"],
        collections: ["Quantum"],
        collectionKeys: ["COLL0001"],
        version: 2,
      }],
    }));
    const { adapter, reader, attachment } = makeAdapter({ buildZotkitLibrarySnapshot });
    const service = new ReaderContextService(adapter, host, {
      now: () => new Date(nowMs),
      librarySnapshotTtlMs: 5 * 60 * 1_000,
    });

    const context = await service.acceptReaderHook({ reader, item: attachment });
    expect(buildZotkitLibrarySnapshot).not.toHaveBeenCalled();

    const first = await service.ensureZotkitLibrarySnapshot();
    expect(buildZotkitLibrarySnapshot).toHaveBeenCalledTimes(1);
    expect(first?.path).toBe(
      "/profile/zoterochat/reader-context/library-snapshots/1.jsonl",
    );
    expect(first?.complete).toBe(true);
    expect(first?.itemCount).toBe(1);
    expect(first?.path.startsWith(`${context.workspace!.root}/`)).toBe(false);
    const snapshotText = host.files.get(first!.path)!;
    const records = snapshotText.trim().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ kind: "meta", itemCount: 1, complete: true });
    expect(records.find((record) => record.kind === "item")).toMatchObject({
      topLevel: true,
      value: { key: "PARENT01", DOI: "10.1000/read-only" },
    });
    const diskContext = JSON.parse(host.files.get(context.workspace!.context)!);
    expect(diskContext.zotkitLibrarySnapshot).toMatchObject({
      path: first!.path,
      libraryID: 1,
    });

    await service.acceptReaderHook({ reader, item: attachment });
    expect(buildZotkitLibrarySnapshot).toHaveBeenCalledTimes(1);
    await service.ensureZotkitLibrarySnapshot();
    expect(buildZotkitLibrarySnapshot).toHaveBeenCalledTimes(1);

    nowMs += 5 * 60 * 1_000 + 1;
    await service.acceptReaderHook({ reader, item: attachment });
    expect(buildZotkitLibrarySnapshot).toHaveBeenCalledTimes(1);
    await service.ensureZotkitLibrarySnapshot();
    expect(buildZotkitLibrarySnapshot).toHaveBeenCalledTimes(2);
  });

  it("persists a failed built-in Zotkit snapshot warning in the active workspace", async () => {
    let shouldFail = true;
    const buildZotkitLibrarySnapshot = vi.fn(async (libraryID): Promise<ZotkitLibrarySnapshot> => {
      if (shouldFail) {
        // Zotero chrome objects can throw Errors from another JS realm, so the
        // value has the standard Error shape without passing instanceof Error.
        throw { name: "Error", message: "lazy item metadata could not be loaded" };
      }
      return {
        schemaVersion: 1,
        libraryID,
        generatedAt: "2026-07-22T10:00:00.000Z",
        complete: true,
        collections: [],
        tags: [],
        items: [],
      };
    });
    const { adapter, reader, attachment } = makeAdapter({ buildZotkitLibrarySnapshot });
    const service = new ReaderContextService(adapter, host);
    const context = await service.acceptReaderHook({ reader, item: attachment });

    await expect(service.ensureZotkitLibrarySnapshot()).resolves.toBeNull();

    const warning = "Built-in Zotkit library snapshot unavailable: lazy item metadata could not be loaded";
    expect(service.getCachedContext()?.warnings).toContain(warning);
    const diskContext = JSON.parse(host.files.get(context.workspace!.context)!);
    expect(diskContext.warnings).toContain(warning);
    expect(diskContext.zotkitLibrarySnapshot).toBeNull();
    expect(host.files.get(context.workspace!.currentPage)).toContain("PDF page: 2");

    shouldFail = false;
    await expect(service.ensureZotkitLibrarySnapshot(true)).resolves.toMatchObject({
      libraryID: 1,
      complete: true,
    });
    expect(service.getCachedContext()?.warnings).not.toContain(warning);
    const recoveredContext = JSON.parse(host.files.get(context.workspace!.context)!);
    expect(recoveredContext.warnings).not.toContain(warning);
    expect(recoveredContext.zotkitLibrarySnapshot).toMatchObject({ libraryID: 1 });
  });

  it("never writes an old page back when a library snapshot finishes after a Reader refresh", async () => {
    let pageIndex = 1;
    let finishSnapshot!: (snapshot: ZotkitLibrarySnapshot) => void;
    const delayedSnapshot = new Promise<ZotkitLibrarySnapshot>((resolve) => {
      finishSnapshot = resolve;
    });
    const buildZotkitLibrarySnapshot = vi.fn(() => delayedSnapshot);
    const { adapter, reader, attachment } = makeAdapter({
      getPageStats: vi.fn(async () => ({
        pageIndex,
        pageNumber: pageIndex + 1,
        pageCount: 3,
        pageLabel: String(pageIndex + 1),
      })),
      buildZotkitLibrarySnapshot,
    });
    const service = new ReaderContextService(adapter, host);
    const first = await service.acceptReaderHook({ reader, item: attachment });
    const snapshotBuild = service.ensureZotkitLibrarySnapshot();
    await vi.waitFor(() => expect(buildZotkitLibrarySnapshot).toHaveBeenCalledOnce());

    pageIndex = 2;
    const latest = await service.refresh();
    expect(latest.page.pageNumber).toBe(3);
    finishSnapshot({
      schemaVersion: 1,
      libraryID: 1,
      generatedAt: "2026-07-22T10:01:00.000Z",
      complete: true,
      collections: [],
      tags: [],
      items: [],
    });
    await snapshotBuild;

    const diskContext = JSON.parse(host.files.get(first.workspace!.context)!);
    expect(diskContext.page.pageNumber).toBe(3);
    expect(diskContext.zotkitLibrarySnapshot.libraryID).toBe(1);
    expect(host.files.get(first.workspace!.currentPage)).toContain("PDF page: 3");
  });

  it("bounds Reader metadata before writing the native MCP context", async () => {
    const metadata = makeMetadata();
    const huge = "量".repeat(10_000);
    const creators = Array.from({ length: 300 }, () => ({
      firstName: huge,
      lastName: huge,
      creatorType: huge,
    }));
    const tags = Array.from({ length: 500 }, (_, index) => `${huge}-${index}`);
    const { adapter, reader, attachment } = makeAdapter({
      describeAttachment: vi.fn(async () => ({
        ...metadata.attachment,
        title: huge,
        creators,
        tags,
      })),
      describeItem: vi.fn(async () => ({
        ...metadata.parent,
        title: huge,
        creators,
        tags,
        abstractNote: huge,
      })),
    });
    const service = new ReaderContextService(adapter, host);
    const context = await service.acceptReaderHook({ reader, item: attachment });
    const serialized = host.files.get(context.workspace!.context)!;
    const diskContext = JSON.parse(serialized);

    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(1_048_576);
    expect(diskContext.attachment.creators).toHaveLength(16);
    expect(diskContext.attachment.tags).toHaveLength(64);
    expect(diskContext.parent.creators).toHaveLength(16);
    expect(diskContext.parent.tags).toHaveLength(64);
    expect(diskContext.parent.title.length).toBeLessThanOrEqual(2_048);
  });

  it("uses existing indexed text before PDFWorker when PDF.js rejects", async () => {
    const { adapter, reader, attachment } = makeAdapter({
      extractPdfJsPage: vi.fn(async () => {
        throw new Error("viewer not initialized");
      }),
    });
    const service = new ReaderContextService(adapter, host);
    const context = await service.acceptReaderHook({ reader, item: attachment });

    expect(context.page.text).toBe("second theorem page");
    expect(context.page.source).toBe("indexed-fulltext");
    expect(context.warnings).toContain("PDF.js page extraction failed: viewer not initialized");
    expect(adapter.readIndexedFullText).toHaveBeenCalledWith(attachment);
    expect(adapter.readPdfWorkerText).not.toHaveBeenCalled();
  });

  it("never starts PDFWorker during automatic refresh of a late page", async () => {
    const getPageStats = vi.fn(async () => ({
      pageIndex: 79,
      pageNumber: 80,
      pageCount: 100,
      pageLabel: "80",
    }));
    const { adapter, reader, attachment } = makeAdapter({
      getPageStats,
      extractPdfJsPage: vi.fn(async () => null),
      readIndexedFullText: vi.fn(async () => null),
    });
    const service = new ReaderContextService(adapter, host);
    const context = await service.acceptReaderHook({ reader, item: attachment });

    expect(context.page.pageNumber).toBe(80);
    expect(context.page.text).toBe("");
    expect(context.page.source).toBe("none");
    expect(adapter.readPdfWorkerText).not.toHaveBeenCalled();
  });

  it("never starts PDFWorker during automatic refresh of an early page", async () => {
    const { adapter, reader, attachment } = makeAdapter({
      extractPdfJsPage: vi.fn(async () => null),
      readIndexedFullText: vi.fn(async () => null),
    });
    const service = new ReaderContextService(adapter, host);
    const context = await service.acceptReaderHook({ reader, item: attachment });

    expect(context.page.text).toBe("");
    expect(context.page.source).toBe("none");
    expect(context.page.warnings).toContain("No text could be extracted for PDF page 2");
    expect(adapter.readPdfWorkerText).not.toHaveBeenCalled();
  });

  it("bounds mirrored page/selection text and prunes stale paper caches", async () => {
    const cacheRoot = "/profile/zoterochat/reader-context/papers";
    const stale = `${cacheRoot}/1-STALE`;
    const recent = `${cacheRoot}/1-RECENT`;
    const currentLegacyFullText = `${cacheRoot}/1-ATTACH01/paper-fulltext.txt`;
    host.directories.add(stale);
    host.directories.add(recent);
    host.files.set(`${stale}/context.json`, "{}");
    host.files.set(`${recent}/context.json`, "{}");
    host.files.set(currentLegacyFullText, "legacy duplicated full text");
    host.workspaceModified.set(stale, Date.parse("2026-06-01T00:00:00.000Z"));
    host.workspaceModified.set(recent, Date.parse("2026-07-21T00:00:00.000Z"));
    const { adapter, reader, attachment } = makeAdapter({
      extractPdfJsPage: vi.fn(async () => "P".repeat(80)),
      getSelection: vi.fn(async () => ({
        text: "S".repeat(80),
        pageIndex: 1,
        pageNumber: 2,
        capturedAt: "2026-07-22T10:00:00.000Z",
      })),
    });
    const service = new ReaderContextService(adapter, host, {
      now: () => new Date("2026-07-22T10:00:00.000Z"),
      maxWorkspaceTextCharacters: 16,
      maxWorkspaceCacheEntries: 2,
      workspaceCacheMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
    });

    const context = await service.acceptReaderHook({ reader, item: attachment });

    expect(host.pruneCalls).toHaveLength(1);
    expect(host.pruneCalls[0]).toMatchObject({
      root: cacheRoot,
      keepDirectory: context.workspace!.root,
      maxEntries: 2,
    });
    expect(host.directories.has(stale)).toBe(false);
    expect(host.directories.has(recent)).toBe(true);
    expect(host.files.has(currentLegacyFullText)).toBe(false);
    expect(host.files.get(context.workspace!.currentPage)).toContain(`${"P".repeat(15)}…`);
    expect(host.files.get(context.workspace!.currentSelection)).toContain(`${"S".repeat(15)}…`);
    const diskContext = JSON.parse(host.files.get(context.workspace!.context)!);
    expect(diskContext.page.text).toBeUndefined();
    expect(diskContext.selection.text).toBeUndefined();
    expect([...host.replaceCalls].every(({ path }) => path.startsWith("/profile/zoterochat/"))).toBe(true);
  });

  it("observes a live page change even though Zotero exposes no page-change plugin event", async () => {
    let pageIndex = 0;
    const { adapter, reader, attachment } = makeAdapter({
      getPageStats: vi.fn(async () => ({
        pageIndex,
        pageNumber: pageIndex + 1,
        pageCount: 3,
      })),
    });
    const service = new ReaderContextService(adapter, host);
    await service.acceptReaderHook({ reader, item: attachment });
    pageIndex = 2;

    await expect(service.getCurrentPage()).resolves.toMatchObject({
      pageIndex: 2,
      pageNumber: 3,
      text: "PDF.js page 3",
    });
    expect(service.getCachedContext()?.page.pageNumber).toBe(3);
    expect(host.replaceCalls).toHaveLength(8);
    expect(adapter.readIndexedFullText).not.toHaveBeenCalled();
  });

  it("deduplicates repeated page-change notifications without re-extracting or rewriting context", async () => {
    let pageIndex = 0;
    const pageStats = vi.fn(async () => ({
      pageIndex,
      pageNumber: pageIndex + 1,
      pageCount: 3,
      pageLabel: String(pageIndex + 1),
    }));
    const { adapter, reader, attachment } = makeAdapter({ getPageStats: pageStats });
    const service = new ReaderContextService(adapter, host);
    await service.acceptReaderHook({ reader, item: attachment });

    await expect(service.refreshForPageChange()).resolves.toBeNull();
    expect(adapter.resolveAttachment).toHaveBeenCalledTimes(1);
    expect(adapter.extractPdfJsPage).toHaveBeenCalledTimes(1);
    expect(host.replaceCalls).toHaveLength(5);

    pageIndex = 1;
    await expect(service.refreshForPageChange()).resolves.toMatchObject({
      page: { pageIndex: 1, pageNumber: 2, text: "PDF.js page 2" },
    });
    expect(adapter.extractPdfJsPage).toHaveBeenCalledTimes(2);
    expect(host.replaceCalls).toHaveLength(8);
  });

  it("always refreshes from the active Reader when switching A to B to A", async () => {
    const readerA: MockReader = { id: "reader-a" };
    const readerB: MockReader = { id: "reader-b" };
    const attachmentA: MockItem = { id: 17, key: "ATTACH-A", kind: "attachment" };
    const attachmentB: MockItem = { id: 18, key: "ATTACH-B", kind: "attachment" };
    let activeHook: ReaderHook<MockReader, MockItem> = { reader: readerA, item: attachmentA };
    const indexed = vi.fn(async (item: MockItem) => ({
      text: `${item.key} page 1\f${item.key} page 2\f${item.key} page 3`,
      extractedPages: 3,
      totalPages: 3,
    }));
    const { adapter: base } = makeAdapter();
    const adapter: ZoteroReadAdapter<MockReader, MockItem> = {
      ...base,
      getActiveReaderHook: vi.fn(async () => activeHook),
      resolveAttachment: vi.fn(async (reader, item) => item ?? (reader.id === "reader-a" ? attachmentA : attachmentB)),
      describeAttachment: vi.fn(async (item) => ({
        ...makeMetadata().attachment,
        id: item.id,
        key: item.key,
      })),
      getPdfPath: vi.fn(async (item) => `/papers/${item.key}.pdf`),
      extractPdfJsPage: vi.fn(async (reader, pageIndex) => `${reader.id} page ${pageIndex + 1}`),
      readIndexedFullText: indexed,
    };
    const service = new ReaderContextService(adapter, host);

    const firstA = await service.refresh();
    activeHook = { reader: readerB, item: attachmentB };
    const contextB = await service.refresh();
    activeHook = { reader: readerA, item: attachmentA };
    const secondA = await service.refresh();

    expect([firstA.attachment.key, contextB.attachment.key, secondA.attachment.key]).toEqual([
      "ATTACH-A",
      "ATTACH-B",
      "ATTACH-A",
    ]);
    expect(secondA.page.text).toBe("reader-a page 2");
    expect(service.getCachedContext()?.attachment.key).toBe("ATTACH-A");
    expect(adapter.getActiveReaderHook).toHaveBeenCalledTimes(3);
    expect(indexed).not.toHaveBeenCalled();
    expect(host.replaceCalls).toHaveLength(13);
  });

  it("loads full text only on first search and keeps static workspace files small", async () => {
    let pageIndex = 0;
    let selectionText = "first selection";
    const indexed = vi.fn(async () => null);
    const worker = vi.fn(async () => ({
      text: "cached page one\fcached page two\fcached page three",
      extractedPages: 3,
      totalPages: 3,
    }));
    const { adapter, reader, attachment } = makeAdapter({
      getPageStats: vi.fn(async () => ({
        pageIndex,
        pageNumber: pageIndex + 1,
        pageCount: 3,
      })),
      getSelection: vi.fn(async () => ({
        text: selectionText,
        pageIndex,
        pageNumber: pageIndex + 1,
        capturedAt: "2026-07-22T10:00:00.000Z",
      })),
      readIndexedFullText: indexed,
      readPdfWorkerText: worker,
    });
    const service = new ReaderContextService(adapter, host);

    await service.acceptReaderHook({ reader, item: attachment });
    pageIndex = 1;
    await service.refresh();
    selectionText = "second selection";
    await service.acceptReaderHook({
      reader,
      item: attachment,
      selectionAnnotation: { text: selectionText, pageIndex },
    });

    expect(indexed).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
    await service.searchCurrentPdf("cached", 5);
    await service.searchCurrentPdf("page", 5);
    expect(indexed).toHaveBeenCalledTimes(1);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(worker).toHaveBeenCalledWith(attachment, null);
    for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
      expect(host.replaceCalls.filter(({ path }) => path.endsWith(filename))).toHaveLength(1);
    }
    expect(host.replaceCalls.some(({ path }) => path.endsWith("paper-fulltext.txt"))).toBe(false);
    for (const filename of ["context.json", "current-page.md", "current-selection.md"]) {
      expect(host.replaceCalls.filter(({ path }) => path.endsWith(filename))).toHaveLength(3);
    }
    expect(service.getCachedContext()?.selection?.text).toBe("second selection");
  });

  it("keeps PDFWorker full text memory-only when a search requests it", async () => {
    const { adapter, reader, attachment } = makeAdapter({
      readIndexedFullText: vi.fn(async () => null),
      extractPdfJsPage: vi.fn(async () => null),
    });
    const service = new ReaderContextService(adapter, host);
    const context = await service.acceptReaderHook({ reader, item: attachment });

    expect(context.fullText).toMatchObject({ source: "deferred", characters: 0 });
    expect(context.page).toMatchObject({ text: "", source: "none" });
    expect(adapter.readPdfWorkerText).not.toHaveBeenCalled();
    await expect(service.searchCurrentPdf("worker")).resolves.toMatchObject({
      source: "pdf-worker",
      matches: [{ pageNumber: 1 }, { pageNumber: 2 }, { pageNumber: 3 }],
    });
    expect(adapter.readPdfWorkerText).toHaveBeenCalledWith(attachment, null);
    expect(context.fullText).toMatchObject({ source: "pdf-worker", totalPages: 3 });
    expect(host.replaceCalls.some(({ path }) => path.endsWith("paper-fulltext.txt"))).toBe(false);
  });

  it("fills a partial indexed cache lazily from the read-only PDFWorker result", async () => {
    const worker = vi.fn(async (_item: MockItem, pages: readonly number[] | null) => ({
      text: pages
        ? pages.map((page) => `bounded page ${page + 1}`).join("\f")
        : "complete one\fcomplete two\fcomplete three",
      extractedPages: pages?.length ?? 3,
      totalPages: 3,
    }));
    const { adapter, reader, attachment } = makeAdapter({
      readIndexedFullText: vi.fn(async () => ({
        text: "partial first page",
        extractedPages: 1,
        totalPages: 3,
      })),
      readPdfWorkerText: worker,
      extractPdfJsPage: vi.fn(async () => null),
    });
    const service = new ReaderContextService(adapter, host);
    const context = await service.acceptReaderHook({ reader, item: attachment });

    expect(context.fullText.source).toBe("deferred");
    expect(worker).not.toHaveBeenCalled();
    expect(context.page.text).toBe("");
    await service.searchCurrentPdf("complete");
    expect(worker).toHaveBeenCalledWith(attachment, null);
    expect(context.fullText).toMatchObject({
      source: "pdf-worker",
      characters: "complete one\fcomplete two\fcomplete three".length,
    });
  });

  it("keeps missing text a non-throwing, explicit empty result", async () => {
    const { adapter, reader, attachment } = makeAdapter({
      readIndexedFullText: vi.fn(async () => null),
      readPdfWorkerText: vi.fn(async () => null),
      extractPdfJsPage: vi.fn(async () => null),
    });
    const service = new ReaderContextService(adapter, host);
    const context = await service.acceptReaderHook({ reader, item: attachment });

    expect(context.page).toMatchObject({ text: "", source: "none" });
    expect(context.page.warnings[0]).toContain("No text could be extracted");
    expect(context.fullText).toMatchObject({ source: "deferred", characters: 0 });
    await service.searchCurrentPdf("anything");
    expect(context.fullText).toMatchObject({ source: "none", characters: 0 });
  });

  it("implements every advertised dynamic tool under the exact stable name", async () => {
    const { adapter } = makeAdapter();
    host.entries = [
      {
        name: "Research Paper.pdf",
        path: "/configured/library/topic/Research Paper.pdf",
      },
    ];
    const service = new ReaderContextService(adapter, host, {
      libraryRoot: "/configured/library",
    });

    expect(READER_CONTEXT_TOOLS.map((tool) => tool.name)).toEqual(READER_TOOL_NAMES);
    await expect(service.invokeTool("zotero_get_reader_context")).resolves.toMatchObject({
      attachment: { key: "ATTACH01" },
    });
    await expect(service.invokeTool("zotero_get_current_page")).resolves.toMatchObject({
      pageNumber: 2,
    });
    await expect(service.invokeTool("zotero_get_current_selection")).resolves.toMatchObject({
      text: "selected theorem",
    });
    await expect(
      service.invokeTool("zotero_search_current_pdf", { query: "theorem" }),
    ).resolves.toMatchObject({ matches: [{ pageNumber: 2 }] });
    await expect(
      service.invokeTool("zotero_read_pdf_pages", { start_page: 1, end_page: 2 }),
    ).resolves.toMatchObject({ pages: [{ pageNumber: 1 }, { pageNumber: 2 }] });
    await expect(
      service.invokeTool("zotero_search_library", { query: "research" }),
    ).resolves.toMatchObject({ matches: [{ name: "Research Paper.pdf" }] });
    await expect(
      service.invokeTool("zotero_read_library_pdf_pages", {
        path: "topic/Research Paper.pdf",
        start_page: 1,
        end_page: 2,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      relativePath: "topic/Research Paper.pdf",
      pages: [{ pageNumber: 1 }, { pageNumber: 2 }],
    });
    await expect(
      service.invokeTool("zotero_search_library_pdf", {
        path: "topic/Research Paper.pdf",
        query: "theorem",
      }),
    ).resolves.toMatchObject({ status: "ok", matches: [{ pageNumber: 2 }] });
    await expect(service.invokeTool("zotero_list_annotations")).resolves.toMatchObject({
      annotations: [{ key: "ANN-A" }, { key: "ANN-B" }],
    });
  });

  it("searches full text with page-aware, case-insensitive snippets", async () => {
    const { adapter } = makeAdapter();
    const service = new ReaderContextService(adapter, host);
    const result = await service.searchCurrentPdf("THEOREM", 5);

    expect(result.source).toBe("indexed-fulltext");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      pageIndex: 1,
      pageNumber: 2,
      matchLength: 7,
    });
    expect(result.matches[0]!.snippet).toContain("theorem");
  });

  it("reads a bounded page range and reuses Zotero indexed text before PDFWorker", async () => {
    const pdfJs = vi.fn(async (_reader: MockReader, pageIndex: number) =>
      pageIndex === 1 ? null : `live ${pageIndex + 1}`,
    );
    const worker = vi.fn(async (_item: MockItem, pages: readonly number[] | null) => ({
      text: (pages ?? []).map((page) => `fallback ${page + 1}`).join("\f"),
      extractedPages: pages?.length,
      totalPages: 3,
    }));
    const { adapter } = makeAdapter({
      extractPdfJsPage: pdfJs,
      readPdfWorkerText: worker,
    });
    const service = new ReaderContextService(adapter, host, { maxReadPages: 4 });

    const result = await service.readPdfPages(1, 3);
    expect(result.pages.map((page) => [page.pageNumber, page.text, page.source])).toEqual([
      [1, "live 1", "pdfjs"],
      [2, "second theorem page", "indexed-fulltext"],
      [3, "live 3", "pdfjs"],
    ]);
    // Both the initial visible-page capture and the range tool reuse the
    // existing index, avoiding automatic PDFWorker prefix extraction.
    expect(worker).not.toHaveBeenCalled();
    await expect(service.readPdfPages(1, 4)).rejects.toThrow("PDF has 3 pages");
    await expect(service.readPdfPages(3, 2)).rejects.toThrow("end_page");
  });

  it("searches configured library filenames/paths only and rejects hidden, DB, and escaped entries", async () => {
    host.entries = [
      {
        name: "Useful Quantum Paper.pdf",
        path: "/configured/library/quantum/Useful Quantum Paper.pdf",
      },
      {
        name: "Secret Quantum Paper.pdf",
        path: "/configured/library/.private/Secret Quantum Paper.pdf",
      },
      {
        name: "quantum.sqlite",
        path: "/configured/library/quantum.sqlite",
      },
      {
        name: "Escaped Quantum Paper.pdf",
        path: "/configured/library-elsewhere/Escaped Quantum Paper.pdf",
      },
      {
        name: "Traversal Quantum Paper.pdf",
        path: "/configured/library/../private/Traversal Quantum Paper.pdf",
      },
      {
        name: "Classical.pdf",
        path: "/configured/library/Classical.pdf",
      },
    ];
    const { adapter } = makeAdapter();
    const service = new ReaderContextService(adapter, host, {
      libraryRoot: "/configured/library",
      maxLibraryScanDepth: 7,
      maxLibraryScanFiles: 321,
    });

    const result = await service.searchLibrary("quantum");
    expect(result.matches).toEqual([
      expect.objectContaining({
        name: "Useful Quantum Paper.pdf",
        relativePath: "quantum/Useful Quantum Paper.pdf",
        extension: ".pdf",
      }),
    ]);
    expect(host.scanCalls).toEqual([
      { root: "/configured/library", maxDepth: 7, maxFiles: 321 },
    ]);
  });

  it("reads another matched library PDF from cache and fills only missing pages with PDFWorker", async () => {
    host.entries = [{
      name: "Other Paper.pdf",
      path: "/configured/library/topic/Other Paper.pdf",
      relativePath: "topic/Other Paper.pdf",
    }];
    const worker = vi.fn(async (_item: MockItem, pages: readonly number[] | null) => ({
      text: (pages ?? []).map((page) => `worker page ${page + 1}`).join("\f"),
      extractedPages: pages?.length,
      totalPages: 3,
    }));
    const { adapter, attachment } = makeAdapter({
      readIndexedFullText: vi.fn(async () => ({
        text: "cached page 1\f\f",
        extractedPages: 1,
        totalPages: 3,
      })),
      readPdfWorkerText: worker,
    });
    const service = new ReaderContextService(adapter, host, {
      libraryRoot: "/configured/library",
      maxReadPages: 3,
    });

    await expect(service.readLibraryPdfPages("topic/Other Paper.pdf", 1, 3)).resolves.toMatchObject({
      status: "ok",
      relativePath: "topic/Other Paper.pdf",
      attachment: { key: "ATTACH01" },
      pages: [
        { pageNumber: 1, text: "cached page 1", source: "indexed-fulltext" },
        { pageNumber: 2, text: "worker page 2", source: "pdf-worker" },
        { pageNumber: 3, text: "worker page 3", source: "pdf-worker" },
      ],
    });
    expect(adapter.findLoadedAttachmentByPath).toHaveBeenCalledWith(
      "/configured/library/topic/Other Paper.pdf",
    );
    expect(worker).toHaveBeenCalledWith(attachment, [1, 2]);
  });

  it("bounds cross-library PDF search pages, matches, and returned text", async () => {
    host.entries = [{
      name: "Other Paper.pdf",
      path: "/configured/library/topic/Other Paper.pdf",
      relativePath: "topic/Other Paper.pdf",
    }];
    const worker = vi.fn(async (_item: MockItem, pages: readonly number[] | null) => ({
      text: "needle in the first long page\fneedle in the second long page",
      extractedPages: pages?.length,
      totalPages: 5,
    }));
    const { adapter } = makeAdapter({
      readIndexedFullText: vi.fn(async () => null),
      readPdfWorkerText: worker,
    });
    const service = new ReaderContextService(adapter, host, {
      libraryRoot: "/configured/library",
      maxLibrarySearchPages: 2,
      maxSearchResults: 2,
      maxToolTextCharacters: 24,
    });

    const result = await service.searchLibraryPdf(
      "topic/Other Paper.pdf",
      "needle",
      2,
    ) as {
      status: string;
      pagesSearched: number;
      pageLimitReached: boolean;
      matches: Array<{ snippet: string; truncated: boolean }>;
      output: { characters: number; limit: number; truncated: boolean };
    };
    expect(result).toMatchObject({
      status: "ok",
      pagesSearched: 2,
      pageLimitReached: true,
      output: { characters: 24, limit: 24, truncated: true },
    });
    expect(result.matches).toHaveLength(2);
    expect(result.matches.reduce((sum, match) => sum + match.snippet.length, 0)).toBeLessThanOrEqual(24);
    expect(worker).toHaveBeenCalledWith(expect.anything(), [0, 1]);
  });

  it("returns explicit not-associated, ambiguous, and unindexed states without raw-file fallback", async () => {
    host.entries = [{
      name: "Other Paper.pdf",
      path: "/configured/library/topic/Other Paper.pdf",
      relativePath: "topic/Other Paper.pdf",
    }];
    const indexed = vi.fn(async () => null);
    const worker = vi.fn(async () => null);
    const { adapter } = makeAdapter({
      findLoadedAttachmentByPath: vi.fn(async () => ({
        status: "not-associated" as const,
        attachment: null,
        candidateCount: 0,
      })),
      readIndexedFullText: indexed,
      readPdfWorkerText: worker,
    });
    const service = new ReaderContextService(adapter, host, {
      libraryRoot: "/configured/library",
    });

    await expect(
      service.searchLibraryPdf("topic/Other Paper.pdf", "needle"),
    ).resolves.toMatchObject({
      status: "not-associated",
      candidateCount: 0,
      message: expect.stringContaining("does not read the file directly"),
    });
    expect(indexed).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();

    vi.mocked(adapter.findLoadedAttachmentByPath).mockResolvedValueOnce({
      status: "ambiguous",
      attachment: null,
      candidateCount: 2,
    });
    await expect(
      service.readLibraryPdfPages("topic/Other Paper.pdf", 1, 1),
    ).resolves.toMatchObject({ status: "ambiguous", candidateCount: 2 });

    vi.mocked(adapter.findLoadedAttachmentByPath).mockResolvedValueOnce({
      status: "matched",
      attachment: makeAdapter().attachment,
      candidateCount: 1,
    });
    await expect(
      service.readLibraryPdfPages("topic/Other Paper.pdf", 1, 1),
    ).resolves.toMatchObject({ status: "unindexed" });
  });

  it("rejects absolute, traversing, hidden, and non-PDF library content paths before matching", async () => {
    const { adapter } = makeAdapter();
    const resolver = vi.spyOn(host, "resolveLibraryPdfPath");
    const service = new ReaderContextService(adapter, host, {
      libraryRoot: "/configured/library",
    });
    for (const path of [
      "/tmp/paper.pdf",
      "../paper.pdf",
      "topic/.hidden/paper.pdf",
      "topic/notes.txt",
      "topic//paper.pdf",
    ]) {
      await expect(
        service.invokeTool("zotero_search_library_pdf", { path, query: "needle" }),
      ).rejects.toThrow(/path/i);
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(adapter.findLoadedAttachmentByPath).not.toHaveBeenCalled();
  });

  it("never accepts a caller-selected library root", async () => {
    const { adapter } = makeAdapter();
    const service = new ReaderContextService(adapter, host);
    await expect(
      service.invokeTool("zotero_search_library", {
        query: "paper",
        root: "/unapproved/location",
      }),
    ).rejects.toThrow("No external PDF library root is configured");
    expect(host.scanCalls).toHaveLength(0);
  });

  it("lists read-only annotations in page order and supports a page filter", async () => {
    const { adapter } = makeAdapter();
    const service = new ReaderContextService(adapter, host);

    await expect(service.listAnnotations()).resolves.toEqual({
      attachmentKey: "ATTACH01",
      annotations: [
        expect.objectContaining({ key: "ANN-A", pageNumber: 1 }),
        expect.objectContaining({ key: "ANN-B", pageNumber: 2 }),
      ],
    });
    await expect(service.listAnnotations(2)).resolves.toEqual({
      attachmentKey: "ATTACH01",
      annotations: [expect.objectContaining({ key: "ANN-B", pageNumber: 2 })],
    });
  });

  it("validates dynamic tool arguments and range limits", async () => {
    const { adapter } = makeAdapter();
    const service = new ReaderContextService(adapter, host, { maxReadPages: 2 });
    await expect(
      service.invokeTool("zotero_search_current_pdf", { query: "  " }),
    ).rejects.toThrow("query");
    await expect(
      service.invokeTool("zotero_read_pdf_pages", { start_page: 1, end_page: 3 }),
    ).rejects.toThrow("maximum of 2 pages");
  });

  it("rejects a slow stale Reader capture instead of returning it to the UI", async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const oldReader: MockReader = { id: "old" };
    const newReader: MockReader = { id: "new" };
    const oldAttachment: MockItem = { id: 17, key: "OLDKEY", kind: "attachment" };
    const newAttachment: MockItem = { id: 18, key: "NEWKEY", kind: "attachment" };
    const { adapter: base } = makeAdapter();
    const adapter: ZoteroReadAdapter<MockReader, MockItem> = {
      ...base,
      resolveAttachment: vi.fn(async (reader) => {
        if (reader.id === "old") {
          await oldGate;
          return oldAttachment;
        }
        return newAttachment;
      }),
      describeAttachment: vi.fn(async (item) => ({
        ...makeMetadata().attachment,
        id: item.id,
        key: item.key,
      })),
    };
    const service = new ReaderContextService(adapter, host);

    const oldCapture = service.acceptReaderHook({ reader: oldReader, item: oldAttachment });
    const staleResult = expect(oldCapture).rejects.toBeInstanceOf(StaleReaderCaptureError);
    const newCapture = service.acceptReaderHook({ reader: newReader, item: newAttachment });
    await newCapture;
    releaseOld();
    await staleResult;

    expect(service.getCachedContext()?.attachment.key).toBe("NEWKEY");
    expect(host.replaceCalls).toHaveLength(5);
    expect([...host.files.keys()].every((path) => path.includes("NEWKEY"))).toBe(true);
  });
});

describe("pure helpers", () => {
  it("returns all page-local literal matches without regex interpretation", () => {
    expect(searchPageText("a+b a+b\fnone", "a+b", 10)).toMatchObject([
      { pageNumber: 1, matchStart: 0 },
      { pageNumber: 1, matchStart: 4 },
    ]);
  });

  it("renders explicit read-only agent policy", () => {
    const metadata = makeMetadata();
    const instructions = renderAgentInstructions({
      schemaVersion: 1,
      capturedAt: "2026-07-22T10:00:00.000Z",
      attachment: metadata.attachment,
      parent: metadata.parent,
      pdfPath: "/papers/paper.pdf",
      page: {
        pageIndex: 0,
        pageNumber: 1,
        text: "page",
        source: "pdfjs",
        warnings: [],
      },
      selection: null,
      fullText: { source: "indexed-fulltext", characters: 4 },
      warnings: [],
    });
    expect(instructions).toContain("Do not alter the original PDF");
    expect(instructions).toContain("filename search never reads file contents");
    expect(instructions).toContain("public read-only item APIs");
    expect(instructions).toContain("do not use shell or direct file reads");
    expect(instructions).toContain("zotero_search_library");
  });

  it("bounds JSONL snapshots and never exposes the internal top-level marker in item values", () => {
    const rendered = renderZotkitLibrarySnapshot({
      schemaVersion: 1,
      libraryID: 1,
      generatedAt: "2026-07-22T10:00:00.000Z",
      complete: true,
      collections: [],
      tags: [],
      items: [{
        _topLevel: false,
        key: "ATTACH01",
        itemType: "attachment",
        title: "Attachment",
        creators: [],
        date: "",
        publicationTitle: "",
        DOI: "",
        url: "",
        abstractNote: "A".repeat(10_000),
        language: "",
        tags: [],
        collections: [],
        collectionKeys: [],
        version: 1,
        parentItem: "PARENT01",
        filename: "paper.pdf",
        contentType: "application/pdf",
      }],
    });
    const itemRecord = JSON.parse(rendered.text.trim().split("\n")[1]!);
    expect(itemRecord.topLevel).toBe(false);
    expect(itemRecord.value._topLevel).toBeUndefined();
    expect(itemRecord.value.parentItem).toBe("PARENT01");
    expect(itemRecord.value.abstractNote.length).toBeLessThanOrEqual(4_096);
  });

  it("bounds CJK-heavy snapshot records and totals by UTF-8 bytes", () => {
    const cjk = "量".repeat(2_000);
    const oversizedItem = {
      _topLevel: true,
      key: "PARENT01",
      itemType: "journalArticle",
      title: cjk,
      creators: Array.from({ length: 100 }, () => ({
        firstName: cjk,
        lastName: cjk,
        name: cjk,
        creatorType: cjk,
      })),
      date: cjk,
      publicationTitle: cjk,
      DOI: cjk,
      url: cjk,
      abstractNote: cjk,
      language: cjk,
      tags: Array.from({ length: 300 }, () => cjk),
      collections: Array.from({ length: 200 }, () => cjk),
      collectionKeys: Array.from({ length: 200 }, () => cjk),
      version: 1,
    };
    const rendered = renderZotkitLibrarySnapshot({
      schemaVersion: 1,
      libraryID: 1,
      generatedAt: "2026-07-22T10:00:00.000Z",
      complete: true,
      collections: [],
      tags: [],
      items: Array.from({ length: 6 }, () => oversizedItem),
    }, 1_000_000);
    const encoded = new TextEncoder();
    const lines = rendered.text.trim().split("\n");

    expect(encoded.encode(rendered.text).byteLength).toBeLessThanOrEqual(1_000_000);
    expect(Math.max(...lines.map((line) => encoded.encode(line).byteLength)))
      .toBeLessThan(900_000);
    expect(rendered.complete).toBe(false);
    const item = JSON.parse(lines[1]!).value;
    expect(item.creators).toHaveLength(32);
    expect(item.tags).toHaveLength(128);
    expect(item.collections).toHaveLength(64);
    expect(item.collectionKeys).toHaveLength(64);
  });
});

describe("createZotero9ReadAdapter", () => {
  it("maps the supported Zotero 9 read APIs without a real library", async () => {
    const parent = {
      id: 10,
      key: "PARENT01",
      libraryID: 1,
      itemType: "journalArticle",
      getField: vi.fn((field: string) => ({
        title: "Mock Parent",
        date: "2024",
        DOI: "10.1000/mock",
      })[field as "title"] ?? ""),
      getCreators: vi.fn(() => [{ firstName: "Grace", lastName: "Hopper" }]),
      getTags: vi.fn(() => [{ tag: "compiler" }]),
    };
    const annotation = {
      key: "ANN1",
      annotationType: "highlight",
      annotationText: "important",
      annotationPosition: JSON.stringify({ pageIndex: 1, rects: [] }),
    };
    const attachment = {
      id: 17,
      key: "ATTACH01",
      libraryID: 1,
      parentItemID: 10,
      itemType: "attachment",
      attachmentFilename: "paper.pdf",
      attachmentContentType: "application/pdf",
      attachmentPath: "/papers/paper.pdf",
      isAttachment: () => true,
      getField: (field: string) => (field === "title" ? "PDF" : ""),
      getCreators: () => [],
      getTags: () => [],
      getFilePathAsync: vi.fn(async () => "/papers/paper.pdf"),
      getAnnotations: vi.fn(() => [annotation]),
    };
    const getTextContent = vi.fn(async () => ({
      items: [
        { str: "First", hasEOL: false },
        { str: "line", hasEOL: true },
        { str: "Second", hasEOL: false },
      ],
    }));
    const pdfDocument = {
      numPages: 3,
      getPage: vi.fn(async () => ({ getTextContent })),
    };
    const reader = {
      itemID: 17,
      _internalReader: {
        _primaryView: {
          _iframeWindow: {
            PDFViewerApplication: {
              pdfDocument,
              pdfViewer: { currentPageNumber: 2, pagesCount: 3, currentPageLabel: "ii" },
            },
            getSelection: () => ({ toString: () => "DOM selection" }),
          },
        },
      },
    };
    const worker = vi.fn(async (_id, maxPages: number | null) => ({
      text: ["one", "two", "three"].slice(0, maxPages ?? 3).join("\f"),
      extractedPages: maxPages ?? 3,
      totalPages: 3,
    }));
    const loadedItems: unknown[] = [attachment, parent];
    const runtime = {
      getMainWindow: () => ({ Zotero_Tabs: { selectedID: "tab-1" } }),
      Reader: { getByTabID: () => reader },
      Items: {
        getAsync: vi.fn(async (id: unknown) => (id === 17 ? attachment : parent)),
        getLoaded: vi.fn(() => loadedItems),
      },
      Attachments: {
        BASE_PATH_PLACEHOLDER: "attachments:",
        resolveRelativePath: vi.fn((path: string) =>
          `/configured/library/${path.slice("attachments:".length)}`),
      },
      Fulltext: {
        getItemCacheFile: () => ({ path: "/cache/.zotero-ft-cache" }),
      },
      PDFWorker: { getFullText: worker },
    };
    const adapter = createZotero9ReadAdapter(runtime, {
      fileExists: vi.fn(async () => true),
      readUtf8: vi.fn(async () => "cached one\fcached two\fcached three"),
      now: () => new Date("2026-07-22T10:00:00.000Z"),
    });

    const hook = await adapter.getActiveReaderHook();
    expect(hook?.reader).toBe(reader);
    const resolved = await adapter.resolveAttachment(reader, attachment);
    expect(resolved).toBe(attachment);
    await expect(adapter.resolveParent(attachment)).resolves.toBe(parent);
    await expect(adapter.describeAttachment(attachment)).resolves.toMatchObject({
      key: "ATTACH01",
      parentID: 10,
      filename: "paper.pdf",
      contentType: "application/pdf",
    });
    await expect(adapter.describeItem(parent)).resolves.toMatchObject({
      title: "Mock Parent",
      year: "2024",
      creators: [{ firstName: "Grace", lastName: "Hopper" }],
      tags: ["compiler"],
    });
    await expect(adapter.getPdfPath(attachment)).resolves.toBe("/papers/paper.pdf");
    await expect(adapter.findLoadedAttachmentByPath("/papers/paper.pdf")).resolves.toEqual({
      status: "matched",
      attachment,
      candidateCount: 1,
    });
    expect(attachment.getFilePathAsync).toHaveBeenCalledTimes(1);
    loadedItems.push({ ...attachment, id: 18, key: "ATTACH02" });
    await expect(adapter.findLoadedAttachmentByPath("/papers/paper.pdf")).resolves.toMatchObject({
      status: "ambiguous",
      attachment: null,
      candidateCount: 2,
    });
    const relativeAttachment = {
      ...attachment,
      id: 19,
      key: "ATTACH03",
      attachmentPath: "attachments:topic/Relative.pdf",
      getFilePathAsync: vi.fn(async () => "/configured/library/topic/Relative.pdf"),
    };
    loadedItems.splice(0, loadedItems.length, relativeAttachment);
    await expect(
      adapter.findLoadedAttachmentByPath("/configured/library/topic/Relative.pdf"),
    ).resolves.toEqual({
      status: "matched",
      attachment: relativeAttachment,
      candidateCount: 1,
    });
    expect(relativeAttachment.getFilePathAsync).not.toHaveBeenCalled();
    await expect(adapter.getPageStats(reader)).resolves.toEqual({
      pageIndex: 1,
      pageNumber: 2,
      pageCount: 3,
      pageLabel: "ii",
    });
    await expect(adapter.extractPdfJsPage(reader, 1)).resolves.toBe("First line\nSecond");
    await expect(adapter.getSelection(reader, {
      text: "hook selection",
      position: { pageIndex: 1, rects: [] },
    })).resolves.toMatchObject({
      text: "hook selection",
      pageNumber: 2,
    });
    await expect(adapter.readIndexedFullText(attachment)).resolves.toMatchObject({
      text: "cached one\fcached two\fcached three",
      extractedPages: 3,
    });
    await expect(adapter.readPdfWorkerText(attachment, [1])).resolves.toMatchObject({
      text: "two",
    });
    expect(worker).toHaveBeenCalledWith(17, 2);
    await expect(adapter.readPdfWorkerText(attachment, [0, 2])).resolves.toMatchObject({
      text: "one\fthree",
      extractedPages: 2,
    });
    expect(worker).toHaveBeenLastCalledWith(17, 3);
    await expect(adapter.listAnnotations(attachment)).resolves.toEqual([
      expect.objectContaining({ key: "ANN1", pageNumber: 2, text: "important" }),
    ]);
  });

  it("finds an unloaded attachment through Zotero's public read-only library API", async () => {
    const unloadedAttachment = {
      id: 73,
      key: "UNLOADED",
      libraryID: 4,
      itemType: "attachment",
      attachmentPath: "/configured/library/topic/unloaded.pdf",
      attachmentFilename: "unloaded.pdf",
      attachmentContentType: "application/pdf",
      isAttachment: () => true,
      isPDFAttachment: () => true,
    };
    const getAll = vi.fn(async (libraryID: number | string) =>
      Number(libraryID) === 4 ? [unloadedAttachment] : []
    );
    const adapter = createZotero9ReadAdapter({
      Items: { getLoaded: () => [], getAll },
      Libraries: {
        userLibraryID: 1,
        getAll: async () => [{ libraryID: 4 }],
      },
    });

    await expect(
      adapter.findLoadedAttachmentByPath("/configured/library/topic/unloaded.pdf"),
    ).resolves.toEqual({
      status: "matched",
      attachment: unloadedAttachment,
      candidateCount: 1,
    });
    expect(getAll).toHaveBeenCalledWith(1, false, false, false);
    expect(getAll).toHaveBeenCalledWith(4, false, false, false);
  });

  it("snapshots one local library through public item and collection read APIs", async () => {
    const parentCollection = {
      id: 4,
      key: "COLL0001",
      name: "Physics",
      parentKey: null,
      parentID: null,
      version: 2,
    };
    const childCollection = {
      id: 5,
      key: "COLL0002",
      name: "Quantum",
      parentKey: "COLL0001",
      parentID: 4,
      version: 3,
    };
    const parent = {
      id: 10,
      key: "PARENT01",
      libraryID: 1,
      itemType: "journalArticle",
      version: 7,
      isTopLevelItem: () => true,
      getCollections: () => [5],
      getField: (field: string) => ({
        title: "Quantum Control",
        DOI: "10.1000/quantum",
        language: "en",
      })[field as "title"] ?? "",
      getCreators: () => [{ firstName: "Ada", lastName: "Lovelace", creatorType: "author" }],
      getTags: () => [{ tag: "topic:quantum" }, { tag: "topic:quantum" }],
    };
    const attachment = {
      id: 11,
      key: "ATTACH01",
      libraryID: 1,
      itemType: "attachment",
      version: 4,
      parentKey: "PARENT01",
      attachmentFilename: "paper.pdf",
      attachmentContentType: "application/pdf",
      isTopLevelItem: () => false,
      getCollections: () => [],
      getField: (field: string) => (field === "title" ? "Paper PDF" : ""),
      getCreators: () => [],
      getTags: () => [{ tag: "attachment-only" }],
    };
    const getAll = vi.fn(async () => [parent, attachment]);
    const loadDataTypes = vi.fn(async () => undefined);
    const getByLibrary = vi.fn(async () => [parentCollection, childCollection]);
    const adapter = createZotero9ReadAdapter({
      Items: { getAll, loadDataTypes },
      Collections: { getByLibrary },
    }, { now: () => new Date("2026-07-22T10:00:00.000Z") });

    const snapshot = await adapter.buildZotkitLibrarySnapshot!(1, {
      maxItems: 100,
      maxCollections: 100,
    });

    expect(getAll).toHaveBeenCalledWith(1, false, false, false);
    expect(loadDataTypes).toHaveBeenCalledWith(
      [parent, attachment],
      ["creators", "tags", "annotation", "itemData", "collections"],
    );
    expect(getByLibrary).toHaveBeenCalledWith(1, true, false);
    expect(snapshot.collections).toEqual([
      expect.objectContaining({ key: "COLL0001", path: "Physics" }),
      expect.objectContaining({ key: "COLL0002", path: "Physics :: Quantum" }),
    ]);
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        _topLevel: true,
        key: "PARENT01",
        DOI: "10.1000/quantum",
        collections: ["Quantum"],
        collectionKeys: ["COLL0002"],
      }),
      expect.objectContaining({
        _topLevel: false,
        key: "ATTACH01",
        parentItem: "PARENT01",
        filename: "paper.pdf",
      }),
    ]);
    expect(snapshot.tags).toEqual([{ tag: "topic:quantum", count: 1 }]);
  });

  it("rejects a library snapshot instead of silently emitting unloaded item metadata", async () => {
    const getField = vi.fn(() => "should not be read");
    const item = {
      id: 10,
      key: "PARENT01",
      libraryID: 1,
      itemType: "journalArticle",
      isTopLevelItem: () => true,
      getField,
      getCreators: () => [],
      getTags: () => [],
      getCollections: () => [],
    };
    const loadDataTypes = vi.fn(async () => {
      throw new Error("Zotero lazy data load failed");
    });
    const adapter = createZotero9ReadAdapter({
      Items: {
        getAll: vi.fn(async () => [item]),
        loadDataTypes,
      },
      Collections: { getByLibrary: vi.fn(() => []) },
    });

    await expect(adapter.buildZotkitLibrarySnapshot!(1, {
      maxItems: 100,
      maxCollections: 100,
    })).rejects.toThrow("Zotero lazy data load failed");
    expect(loadDataTypes).toHaveBeenCalledOnce();
    expect(getField).not.toHaveBeenCalled();
  });
});

describe("createGeckoProfileAdapter", () => {
  it("writes private profile files and scans only canonical, non-hidden PDFs", async () => {
    const children = new Map<string, string[]>([
      ["/library", ["/library/.hidden", "/library/zotero.sqlite", "/library/topic"]],
      ["/library/topic", [
        "/library/topic/escape-link",
        "/library/topic/note.txt",
        "/library/topic/off-root.pdf",
        "/library/topic/paper.pdf",
        "/library/topic/nested",
      ]],
      ["/library/topic/nested", ["/library/topic/nested/second.PDF"]],
    ]);
    const nodes = new Map<string, {
      type: string;
      canonical?: string;
      symlink?: boolean;
      size?: number;
    }>([
      ["/profile", { type: "directory" }],
      ["/library", { type: "directory" }],
      ["/library/topic", { type: "directory" }],
      ["/library/topic/escape-link", {
        type: "directory",
        canonical: "/outside",
        symlink: true,
      }],
      ["/library/topic/note.txt", { type: "regular", size: 10 }],
      ["/library/topic/off-root.pdf", { type: "regular", canonical: "/outside/off-root.pdf" }],
      ["/library/topic/paper.pdf", { type: "regular", size: 100 }],
      ["/library/topic/nested", { type: "directory" }],
      ["/library/topic/nested/second.PDF", { type: "regular", size: 200 }],
    ]);
    const makeDirectory = vi.fn(async (
      path: string,
      _options?: {
        createAncestors?: boolean;
        ignoreExisting?: boolean;
        permissions?: number;
      },
    ) => {
      if (nodes.has(path)) throw new Error("already exists");
      nodes.set(path, { type: "directory" });
    });
    const writeUTF8 = vi.fn(async (path: string) => {
      nodes.set(path, { type: "regular" });
    });
    const setPermissions = vi.fn(async (
      _path: string,
      _permissions: number,
      _honorUmask?: boolean,
    ) => undefined);
    const getChildren = vi.fn(async (path: string) => children.get(path) ?? []);
    const stat = vi.fn(async (path: string) => {
      const value = nodes.get(path);
      if (!value) throw new Error("missing");
      return value;
    });
    const host = createGeckoProfileAdapter({
      IOUtils: { makeDirectory, writeUTF8, getChildren, stat, setPermissions },
      PathUtils: {
        profileDir: "/profile",
        join: (...parts: string[]) => parts.join("/").replace(/\/{2,}/g, "/"),
        filename: (path: string) => path.split("/").pop()!,
      },
      PathSecurity: {
        isSymlink: async (path) => Boolean(nodes.get(path)?.symlink),
        canonicalPath: async (path) => nodes.get(path)?.canonical ?? path,
      },
    });

    const root = await host.getProfileWorkspaceRoot();
    expect(root).toBe("/profile/zoterochat/reader-context");
    await host.ensureProfileDirectory(`${root}/papers/KEY`);
    await host.replaceProfileText(`${root}/papers/KEY/context.json`, "{}");
    for (const call of makeDirectory.mock.calls) {
      expect(call[1]).toEqual({
        createAncestors: false,
        ignoreExisting: false,
        permissions: 0o700,
      });
    }
    expect(writeUTF8).toHaveBeenCalledWith(
      `${root}/papers/KEY/context.json`,
      "{}",
      { tmpPath: `${root}/papers/KEY/context.json.tmp` },
    );
    expect(setPermissions).toHaveBeenCalledWith(
      `${root}/papers/KEY/context.json`,
      0o600,
      false,
    );
    expect(setPermissions.mock.calls.filter((call) => call[1] === 0o700).length).toBeGreaterThan(0);
    await expect(host.replaceProfileText("/profile/elsewhere/file", "x")).rejects.toThrow(
      "outside",
    );

    const entries = await host.scanLibraryFileNames("/library", {
      maxDepth: 5,
      maxFiles: 10,
    });
    expect(entries.map((entry) => entry.relativePath)).toEqual([
      "topic/paper.pdf",
      "topic/nested/second.PDF",
    ]);
    expect(getChildren).toHaveBeenCalledTimes(3);
    expect(stat).not.toHaveBeenCalledWith("/library/.hidden");
    expect(stat).not.toHaveBeenCalledWith("/library/zotero.sqlite");
    expect(getChildren).not.toHaveBeenCalledWith("/library/topic/escape-link");

    await expect(
      host.resolveLibraryPdfPath("/library", "topic/paper.pdf"),
    ).resolves.toEqual({
      name: "paper.pdf",
      path: "/library/topic/paper.pdf",
      relativePath: "topic/paper.pdf",
    });
    await expect(
      host.resolveLibraryPdfPath("/library", "topic/escape-link/paper.pdf"),
    ).rejects.toThrow("symbolic link");
    await expect(
      host.resolveLibraryPdfPath("/library", "topic/off-root.pdf"),
    ).rejects.toThrow("canonical configured root");
    await expect(
      host.resolveLibraryPdfPath("/library", "topic/.hidden/paper.pdf"),
    ).rejects.toThrow("hidden");
    await expect(
      host.resolveLibraryPdfPath("/library", "topic/note.txt"),
    ).rejects.toThrow("PDF");
  });

  it("prunes stale managed caches but preserves the active workspace and unknown files", async () => {
    const profileRoot = "/profile/zoterochat/reader-context";
    const cacheRoot = `${profileRoot}/papers`;
    const current = `${cacheRoot}/1-CURRENT`;
    const stale = `${cacheRoot}/1-STALE`;
    const recent = `${cacheRoot}/1-RECENT`;
    const protectedWorkspace = `${cacheRoot}/1-PROTECTED`;
    const old = Date.parse("2026-06-01T00:00:00.000Z");
    const recentTime = Date.parse("2026-07-21T00:00:00.000Z");
    const nodes = new Map<string, { type: string; lastModified?: number }>([
      ["/profile", { type: "directory" }],
      ["/profile/zoterochat", { type: "directory" }],
      [profileRoot, { type: "directory" }],
      [cacheRoot, { type: "directory" }],
      [current, { type: "directory", lastModified: old }],
      [`${current}/context.json`, { type: "regular", lastModified: old }],
      [`${current}/paper-fulltext.txt`, { type: "regular", lastModified: old }],
      [stale, { type: "directory", lastModified: old }],
      [`${stale}/context.json`, { type: "regular", lastModified: old }],
      [`${stale}/paper-fulltext.txt`, { type: "regular", lastModified: old }],
      [recent, { type: "directory", lastModified: recentTime }],
      [`${recent}/context.json`, { type: "regular", lastModified: recentTime }],
      [protectedWorkspace, { type: "directory", lastModified: old }],
      [`${protectedWorkspace}/context.json`, { type: "regular", lastModified: old }],
      [`${protectedWorkspace}/user-notes.md`, { type: "regular", lastModified: old }],
    ]);
    const children = new Map<string, string[]>([
      [cacheRoot, [current, stale, recent, protectedWorkspace]],
      [current, [`${current}/context.json`, `${current}/paper-fulltext.txt`]],
      [stale, [`${stale}/context.json`, `${stale}/paper-fulltext.txt`]],
      [recent, [`${recent}/context.json`]],
      [protectedWorkspace, [
        `${protectedWorkspace}/context.json`,
        `${protectedWorkspace}/user-notes.md`,
      ]],
    ]);
    const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
    const remove = vi.fn(async (path: string) => {
      const node = nodes.get(path);
      if (!node) return;
      if (node.type === "directory" && (children.get(path)?.length ?? 0) > 0) {
        throw new Error("directory not empty");
      }
      nodes.delete(path);
      children.delete(path);
      const parent = parentOf(path);
      children.set(parent, (children.get(parent) ?? []).filter((child) => child !== path));
    });
    const host = createGeckoProfileAdapter({
      IOUtils: {
        makeDirectory: vi.fn(async () => undefined),
        writeUTF8: vi.fn(async () => undefined),
        getChildren: vi.fn(async (path: string) => children.get(path) ?? []),
        stat: vi.fn(async (path: string) => {
          const value = nodes.get(path);
          if (!value) throw new Error("missing");
          return value;
        }),
        remove,
      },
      PathUtils: {
        profileDir: "/profile",
        join: (...parts: string[]) => parts.join("/").replace(/\/{2,}/g, "/"),
      },
      PathSecurity: {
        isSymlink: async () => false,
        canonicalPath: async (path) => path,
      },
    });

    const result = await host.pruneProfileWorkspaceCache(cacheRoot, {
      keepDirectory: current,
      maxEntries: 2,
      maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
      nowMs: Date.parse("2026-07-22T10:00:00.000Z"),
    });

    expect(result.removed).toEqual([stale]);
    expect(result.removedFiles).toEqual([
      `${current}/paper-fulltext.txt`,
      `${stale}/paper-fulltext.txt`,
    ]);
    expect(result.skipped).toContain(protectedWorkspace);
    expect(nodes.has(stale)).toBe(false);
    expect(nodes.has(`${stale}/paper-fulltext.txt`)).toBe(false);
    expect(nodes.has(current)).toBe(true);
    expect(nodes.has(`${current}/paper-fulltext.txt`)).toBe(false);
    expect(nodes.has(recent)).toBe(true);
    expect(nodes.has(`${protectedWorkspace}/user-notes.md`)).toBe(true);
    expect(remove.mock.calls.every(([path]) => String(path).startsWith(`${cacheRoot}/`))).toBe(true);
  });

  it("rejects pre-existing profile and library symlinks", async () => {
    const nodes = new Map<string, { type: string; canonical?: string; symlink?: boolean }>([
      ["/profile", { type: "directory" }],
      ["/profile/zoterochat", { type: "directory", canonical: "/outside", symlink: true }],
      ["/library", { type: "directory", canonical: "/outside-library", symlink: true }],
    ]);
    const host = createGeckoProfileAdapter({
      IOUtils: {
        makeDirectory: vi.fn(async () => undefined),
        writeUTF8: vi.fn(async () => undefined),
        getChildren: vi.fn(async () => []),
        stat: vi.fn(async (path: string) => {
          const value = nodes.get(path);
          if (!value) throw new Error("missing");
          return value;
        }),
      },
      PathUtils: {
        profileDir: "/profile",
        join: (...parts: string[]) => parts.join("/").replace(/\/{2,}/g, "/"),
      },
      PathSecurity: {
        isSymlink: async (path) => Boolean(nodes.get(path)?.symlink),
        canonicalPath: async (path) => nodes.get(path)?.canonical ?? path,
      },
    });
    const root = await host.getProfileWorkspaceRoot();
    await expect(host.ensureProfileDirectory(`${root}/papers/KEY`)).rejects.toThrow(
      "symbolic link",
    );
    await expect(host.scanLibraryFileNames("/library", {
      maxDepth: 5,
      maxFiles: 10,
    })).rejects.toThrow("symbolic link");
    await expect(
      host.resolveLibraryPdfPath("/library", "paper.pdf"),
    ).rejects.toThrow("symbolic link");
  });

  it("rejects pre-existing output and temporary-file symlinks before writing", async () => {
    const root = "/profile/zoterochat/reader-context";
    const paperDirectory = `${root}/papers/KEY`;
    const target = `${paperDirectory}/context.json`;
    const temporary = `${target}.tmp`;
    const nodes = new Map<string, { type: string; canonical?: string }>([
      ["/profile", { type: "directory" }],
      ["/profile/zoterochat", { type: "directory" }],
      [root, { type: "directory" }],
      [`${root}/papers`, { type: "directory" }],
      [paperDirectory, { type: "directory" }],
    ]);
    const symlinks = new Set([target]);
    const writeUTF8 = vi.fn(async () => undefined);
    const host = createGeckoProfileAdapter({
      IOUtils: {
        makeDirectory: vi.fn(async () => undefined),
        writeUTF8,
        getChildren: vi.fn(async () => []),
        stat: vi.fn(async (path: string) => {
          const value = nodes.get(path);
          if (!value) throw new Error("missing");
          return value;
        }),
      },
      PathUtils: {
        profileDir: "/profile",
        join: (...parts: string[]) => parts.join("/").replace(/\/{2,}/g, "/"),
      },
      PathSecurity: {
        isSymlink: async (path) => symlinks.has(path),
        canonicalPath: async (path) => nodes.get(path)?.canonical ?? path,
      },
    });

    await expect(host.replaceProfileText(target, "unsafe")).rejects.toThrow("symbolic link");
    symlinks.delete(target);
    symlinks.add(temporary);
    await expect(host.replaceProfileText(target, "unsafe")).rejects.toThrow("symbolic link");
    expect(writeUTF8).not.toHaveBeenCalled();
  });
});
