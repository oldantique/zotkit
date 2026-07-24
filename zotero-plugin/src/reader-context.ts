/**
 * Read-only Zotero Reader context and tool layer.
 *
 * The service deliberately depends on small injected adapters instead of the
 * Zotero global.  That keeps the data boundary auditable and lets the complete
 * implementation run under Node with in-memory mocks.  The only mutation this
 * module can request is replacement of files below the plugin's own profile
 * workspace; Zotero items, collections, attachment links, and databases are
 * never mutation targets.
 */

export type MaybePromise<T> = T | Promise<T>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ReaderHook<TReader = unknown, TItem = unknown> {
  /** The reader instance received from a Zotero Reader event. */
  reader: TReader;
  /** Optional item from the same event. It is re-resolved by the adapter. */
  item?: TItem | null;
  /** `params.annotation` from renderTextSelectionPopup, when available. */
  selectionAnnotation?: unknown;
  /** The untouched Reader event params may be supplied instead. */
  params?: { annotation?: unknown };
  capturedAt?: string;
}

export interface CreatorMetadata {
  firstName?: string;
  lastName?: string;
  name?: string;
  creatorType?: string;
}

export interface ZoteroItemMetadata {
  id: number | string;
  key: string;
  libraryID?: number | string;
  itemType?: string;
  title?: string;
  creators: CreatorMetadata[];
  date?: string;
  year?: string;
  doi?: string;
  url?: string;
  publicationTitle?: string;
  abstractNote?: string;
  tags: string[];
}

export interface AttachmentMetadata extends ZoteroItemMetadata {
  parentID?: number | string;
  filename?: string;
  contentType?: string;
}

export interface ReaderPageStats {
  /** Zero-based page index used by PDF.js and Zotero annotations. */
  pageIndex: number;
  /** One-based, user-facing PDF page number. */
  pageNumber: number;
  pageCount?: number;
  pageLabel?: string;
}

export interface ReaderSelection {
  text: string;
  pageIndex?: number;
  pageNumber?: number;
  annotationKey?: string;
  annotationType?: string;
  color?: string;
  comment?: string;
  position?: JsonValue;
  capturedAt: string;
}

export interface ReaderAnnotation {
  key: string;
  type?: string;
  text?: string;
  comment?: string;
  color?: string;
  pageIndex?: number;
  pageNumber?: number;
  pageLabel?: string;
  position?: JsonValue;
  dateAdded?: string;
  dateModified?: string;
}

export type TextSource = "pdfjs" | "indexed-fulltext" | "pdf-worker" | "none";

export interface PageTextResult extends ReaderPageStats {
  text: string;
  source: TextSource;
  warnings: string[];
}

export interface FullTextResult {
  text: string;
  source: Exclude<TextSource, "pdfjs">;
  extractedPages?: number;
  totalPages?: number;
}

/**
 * A plugin-authored reference consumed by the bundled terminal MCP helper.
 * Zotero's own index is referenced in place; PDFWorker text is mirrored only
 * as a bounded fallback below the plugin's private profile workspace.
 */
export interface PdfTextReference {
  schemaVersion: 1;
  path: string;
  source: "indexed-fulltext" | "pdf-worker";
  characters?: number;
  extractedPages?: number;
  totalPages?: number;
  truncated: boolean;
}

export interface WorkspaceFiles {
  root: string;
  context: string;
  currentPage: string;
  currentSelection: string;
  pdfText: string;
  agents: string;
  claude: string;
}

export interface ReaderContext {
  schemaVersion: 1;
  capturedAt: string;
  attachment: AttachmentMetadata;
  parent: ZoteroItemMetadata | null;
  pdfPath: string | null;
  page: PageTextResult;
  selection: ReaderSelection | null;
  fullText: {
    /** Full text is loaded lazily only when a search tool needs it. */
    source: FullTextResult["source"] | "deferred";
    characters: number;
    extractedPages?: number;
    totalPages?: number;
  };
  /** Read-only text source for the terminal MCP's page/search tools. */
  pdfText?: PdfTextReference | null;
  workspace?: WorkspaceFiles;
  warnings: string[];
}

export interface PdfWorkerTextResult {
  text: string;
  extractedPages?: number;
  totalPages?: number;
}

export interface AttachmentPathResolution<TItem> {
  status: "matched" | "not-associated" | "ambiguous";
  attachment: TItem | null;
  candidateCount: number;
}

export interface ZotkitLibraryItem {
  /** Snapshot-internal flag; native query output never exposes this field. */
  _topLevel: boolean;
  key: string;
  itemType: string;
  title: string;
  creators: CreatorMetadata[];
  date: string;
  publicationTitle: string;
  DOI: string;
  url: string;
  abstractNote: string;
  language: string;
  tags: string[];
  collections: string[];
  collectionKeys: string[];
  version: number | null;
  parentItem?: string;
  filename?: string;
  contentType?: string;
}

export interface ZotkitLibraryCollection {
  key: string;
  name: string;
  parentKey: string | null;
  path: string;
  version: number | null;
}

export interface ZotkitLibraryTag {
  tag: string;
  count: number;
}

export interface ZotkitLibrarySnapshot {
  schemaVersion: 1;
  libraryID: number | string;
  generatedAt: string;
  complete: boolean;
  items: ZotkitLibraryItem[];
  collections: ZotkitLibraryCollection[];
  tags: ZotkitLibraryTag[];
}

export interface ZotkitLibrarySnapshotReference {
  schemaVersion: 1;
  path: string;
  libraryID: number | string;
  generatedAt: string;
  itemCount: number;
  collectionCount: number;
  tagCount: number;
  complete: boolean;
}

/**
 * The complete Zotero-facing surface used by ReaderContextService.
 *
 * Every method is observational.  In particular, implementations must not
 * trigger indexing, annotation import, item persistence, attachment relinking,
 * or collection changes.  PDF worker extraction must use the worker's
 * full-text return value only.
 */
export interface ZoteroReadAdapter<TReader = unknown, TItem = unknown> {
  getActiveReaderHook(): Promise<ReaderHook<TReader, TItem> | null>;
  resolveAttachment(reader: TReader, hookItem?: TItem | null): Promise<TItem | null>;
  resolveParent(attachment: TItem): Promise<TItem | null>;
  describeAttachment(attachment: TItem): Promise<AttachmentMetadata>;
  describeItem(item: TItem): Promise<ZoteroItemMetadata>;
  getPdfPath(attachment: TItem): Promise<string | null>;
  getPageStats(reader: TReader): Promise<ReaderPageStats>;
  getSelection(reader: TReader, eventAnnotation?: unknown): Promise<ReaderSelection | null>;
  /** Extract one zero-based page through the already-open PDF.js document. */
  extractPdfJsPage(reader: TReader, pageIndex: number): Promise<string | null>;
  /** Read Zotero's existing full-text cache without initiating or changing indexing. */
  readIndexedFullText(attachment: TItem): Promise<PdfWorkerTextResult | null>;
  /** Resolve Zotero's existing full-text cache path without reading or changing it. */
  getIndexedFullTextReference?(
    attachment: TItem,
  ): Promise<PdfTextReference | null>;
  /**
   * Zotero's own authoritative record of how many pages were indexed versus
   * how many the document actually has (`Zotero.Fulltext.getPages`). Optional
   * because older/alternate runtimes may not expose it; callers must not
   * assume completeness when it is unavailable.
   */
  getFullTextPageCounts?(
    attachment: TItem,
  ): Promise<{ indexedPages?: number; totalPages?: number } | null>;
  /** Read PDF text in memory. `pageIndexes` are zero-based; null means all pages. */
  readPdfWorkerText(
    attachment: TItem,
    pageIndexes: readonly number[] | null,
  ): Promise<PdfWorkerTextResult | null>;
  /**
   * Match a canonical path against existing Zotero attachments through public,
   * read-only item APIs. The implementation must never save items or use SQL.
   */
  findLoadedAttachmentByPath(pdfPath: string): Promise<AttachmentPathResolution<TItem>>;
  listAnnotations(attachment: TItem): Promise<ReaderAnnotation[]>;
  /**
   * Build a bounded metadata-only view of one local Zotero library. This is
   * optional so Reader context remains usable on runtimes without enumeration
   * APIs. Implementations must use public read APIs and never save objects.
   */
  buildZotkitLibrarySnapshot?(
    libraryID: number | string,
    options: { maxItems: number; maxCollections: number },
  ): Promise<ZotkitLibrarySnapshot>;
}

export interface LibraryFileEntry {
  name: string;
  path: string;
  relativePath?: string;
}

/** Host I/O is constrained to plugin-profile output and metadata-only scans. */
export interface ReaderContextHostAdapter {
  getProfileWorkspaceRoot(): Promise<string>;
  joinPath(...parts: string[]): string;
  ensureProfileDirectory(path: string): Promise<void>;
  replaceProfileText(path: string, text: string): Promise<void>;
  /** Verify a plugin-owned profile text file without reading its contents. */
  profileTextExists(path: string): Promise<boolean>;
  /**
   * Remove stale, plugin-managed paper cache directories only. The host must
   * fail closed on symlinks or unknown files and must never traverse outside
   * `cacheRoot`.
   */
  pruneProfileWorkspaceCache(
    cacheRoot: string,
    options: {
      keepDirectory: string;
      maxEntries: number;
      maxAgeMs: number;
      nowMs: number;
    },
  ): Promise<{ removed: string[]; removedFiles: string[]; skipped: string[] }>;
  /** Return metadata only. Implementations must not read file contents. */
  scanLibraryFileNames(
    configuredRoot: string,
    options: { maxDepth: number; maxFiles: number },
  ): Promise<LibraryFileEntry[]>;
  /** Resolve and verify one caller-supplied relative PDF path without reading it. */
  resolveLibraryPdfPath(
    configuredRoot: string,
    relativePath: string,
  ): Promise<LibraryFileEntry | null>;
}

export interface ReaderContextOptions {
  /** Optional external PDF folder used only by read-only library tools. */
  libraryRoot?: string | null;
  workspaceFolderName?: string;
  maxLibraryScanDepth?: number;
  maxLibraryScanFiles?: number;
  maxSearchResults?: number;
  maxReadPages?: number;
  maxLibrarySearchPages?: number;
  maxToolTextCharacters?: number;
  /** Maximum paper workspaces retained in the plugin-owned cache. */
  maxWorkspaceCacheEntries?: number;
  /** Maximum idle age of a paper workspace before it can be reclaimed. */
  workspaceCacheMaxAgeMs?: number;
  /** Avoid scanning the cache on every page or selection update. */
  workspaceCachePruneIntervalMs?: number;
  /** Maximum page/selection characters mirrored into each small workspace file. */
  maxWorkspaceTextCharacters?: number;
  /** Full PDF text is memory-only and retained for only this many recent papers. */
  maxFullTextCacheEntries?: number;
  /** Maximum size of the private PDFWorker fallback mirrored for terminal MCP. */
  maxPdfTextSnapshotCharacters?: number;
  /** Metadata snapshots are rebuilt only on an explicit terminal refresh after this TTL. */
  librarySnapshotTtlMs?: number;
  maxLibrarySnapshotItems?: number;
  maxLibrarySnapshotCollections?: number;
  maxLibrarySnapshotCharacters?: number;
  now?: () => Date;
}

export interface ToolDefinition {
  name: ReaderToolName;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, JsonValue>;
    required?: string[];
    additionalProperties: false;
  };
}

export const READER_TOOL_NAMES = [
  "zotero_get_reader_context",
  "zotero_get_current_page",
  "zotero_get_current_selection",
  "zotero_search_current_pdf",
  "zotero_read_pdf_pages",
  "zotero_search_library",
  "zotero_read_library_pdf_pages",
  "zotero_search_library_pdf",
  "zotero_list_annotations",
  "zotkit_find_items",
  "zotkit_get_item",
  "zotkit_list_collections",
  "zotkit_list_tags",
] as const;

export type ReaderToolName = (typeof READER_TOOL_NAMES)[number];

export const READER_CONTEXT_TOOLS: readonly ToolDefinition[] = [
  {
    name: "zotero_get_reader_context",
    description:
      "Return metadata, PDF path, current page, and current Reader selection for the active Zotero PDF. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "zotero_get_current_page",
    description:
      "Return text for the current PDF page, with the PDF page number and extraction source. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "zotero_get_current_selection",
    description:
      "Return the most recent text selection annotation from the active Zotero Reader. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "zotero_search_current_pdf",
    description:
      "Search the active PDF's existing indexed text (or an in-memory PDF worker result) and return page-aware snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_read_pdf_pages",
    description:
      "Read an inclusive one-based page range from the active PDF without changing the PDF or Zotero index.",
    inputSchema: {
      type: "object",
      properties: {
        start_page: { type: "integer", minimum: 1 },
        end_page: { type: "integer", minimum: 1 },
      },
      required: ["start_page", "end_page"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_search_library",
    description:
      "Search filenames and paths below the configured external PDF library root. File contents, hidden paths, and databases are excluded.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_read_library_pdf_pages",
    description:
      "Read a bounded page range from another PDF below the configured library root, but only after its relative path uniquely matches an existing Zotero attachment. Never reads an arbitrary file or changes Zotero.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 1024 },
        start_page: { type: "integer", minimum: 1 },
        end_page: { type: "integer", minimum: 1 },
      },
      required: ["path", "start_page", "end_page"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_search_library_pdf",
    description:
      "Search bounded full text for another PDF below the configured library root, but only after its relative path uniquely matches an existing Zotero attachment. Uses Zotero's existing cache or read-only PDFWorker extraction.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 1024 },
        query: { type: "string", minLength: 1, maxLength: 512 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["path", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "zotero_list_annotations",
    description:
      "List annotations belonging to the active PDF, optionally restricted to a one-based page number. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "zotkit_find_items",
    description:
      "Search the active Zotero library's bounded, read-only metadata snapshot by title, creator, DOI, tag, collection, or filename. Returns item and collection keys for follow-up tools.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 512 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "zotkit_get_item",
    description:
      "Return one Zotero item's read-only metadata by its exact key in the active library, including collection keys and resolved collection paths.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", minLength: 1, maxLength: 128 } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "zotkit_list_collections",
    description:
      "List collection keys, names, paths, and parent keys from the active Zotero library's bounded read-only metadata snapshot. Use these keys when proposing reviewed collection membership changes.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 512 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "zotkit_list_tags",
    description:
      "List tags and usage counts from the active Zotero library's bounded read-only metadata snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 512 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
  },
] as const;

export interface SearchMatch {
  pageNumber?: number;
  pageIndex?: number;
  snippet: string;
  matchStart: number;
  matchLength: number;
}

export interface LibrarySearchMatch extends LibraryFileEntry {
  relativePath: string;
  extension: string;
}

export interface LibraryAttachmentSummary {
  id: number | string;
  key: string;
  libraryID?: number | string;
  title?: string;
  filename?: string;
  contentType?: string;
}

interface Snapshot<TReader, TItem> {
  hook: ReaderHook<TReader, TItem>;
  attachmentHandle: TItem;
  context: ReaderContext;
  /** Populated only after a full-PDF search explicitly requests it. */
  fullText: FullTextResult | null;
}

interface CachedFullText {
  result: FullTextResult;
  warnings: string[];
}

interface CachedLibrarySnapshot {
  reference: ZotkitLibrarySnapshotReference;
  snapshot: ZotkitLibrarySnapshot;
  expiresAt: number;
}

/**
 * Raised when a newer Reader observation supersedes an in-flight capture.
 * Callers should silently discard this result rather than applying it to UI.
 */
export class StaleReaderCaptureError extends Error {
  constructor() {
    super("Reader context capture was superseded by a newer active Reader");
    this.name = "StaleReaderCaptureError";
  }
}

export function isStaleReaderCaptureError(error: unknown): error is StaleReaderCaptureError {
  return error instanceof StaleReaderCaptureError
    || (error instanceof Error && error.name === "StaleReaderCaptureError");
}

const DEFAULT_OPTIONS: Required<
  Omit<ReaderContextOptions, "libraryRoot" | "now">
> = {
  workspaceFolderName: "papers",
  maxLibraryScanDepth: 12,
  maxLibraryScanFiles: 20_000,
  maxSearchResults: 20,
  maxReadPages: 50,
  maxLibrarySearchPages: 200,
  maxToolTextCharacters: 120_000,
  maxWorkspaceCacheEntries: 24,
  workspaceCacheMaxAgeMs: 14 * 24 * 60 * 60 * 1_000,
  workspaceCachePruneIntervalMs: 60 * 60 * 1_000,
  maxWorkspaceTextCharacters: 64_000,
  maxFullTextCacheEntries: 3,
  maxPdfTextSnapshotCharacters: 8_000_000,
  // Library metadata changes far less often than page/selection context. A
  // once-per-day in-memory refresh avoids re-enumerating large Zotero libraries
  // whenever the user collapses and reopens the terminal.
  librarySnapshotTtlMs: 24 * 60 * 60 * 1_000,
  maxLibrarySnapshotItems: 20_000,
  maxLibrarySnapshotCollections: 5_000,
  maxLibrarySnapshotCharacters: 16_000_000,
};

const DATABASE_SUFFIXES = [
  ".db",
  ".db-journal",
  ".db-shm",
  ".db-wal",
  ".sqlite",
  ".sqlite-journal",
  ".sqlite-shm",
  ".sqlite-wal",
  ".sqlite3",
] as const;

const ZOTKIT_SNAPSHOT_WARNING_PREFIX = "Built-in Zotkit library snapshot unavailable:";
const PDF_TEXT_WARNING_PREFIX = "Terminal PDF text unavailable:";

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  // Errors thrown by Zotero chrome objects can originate in another JS realm,
  // where `instanceof Error` is false even though the object has the standard
  // Error shape. Preserve that diagnostic instead of reporting "unknown error".
  if (typeof error === "object" && error !== null) {
    try {
      const record = error as { message?: unknown; name?: unknown };
      const message = cleanText(record.message);
      if (message) return message;
      const name = cleanText(record.name);
      if (name) return name;
    }
    catch {
      // A cross-realm property getter can itself throw; use the fallback below.
    }
  }
  return "unknown error";
}

function boundedErrorMessage(error: unknown): string {
  return truncateMiddle(errorMessage(error), 1_000);
}

function positiveInteger(value: unknown, fallback?: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (fallback !== undefined) return fallback;
  throw new TypeError("Expected a positive integer");
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function safeSegment(value: unknown): string {
  const segment = String(value ?? "paper")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 96);
  return segment || "paper";
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function trimTrailingSlash(path: string): string {
  const normalized = normalizeSlashes(path);
  if (normalized === "/") return normalized;
  return normalized.replace(/\/+$/g, "");
}

function hasTraversalSegment(path: string): boolean {
  return normalizeSlashes(path)
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function isPathInside(root: string, candidate: string): boolean {
  if (hasTraversalSegment(root) || hasTraversalSegment(candidate)) return false;
  const normalizedRoot = trimTrailingSlash(root);
  const normalizedCandidate = normalizeSlashes(candidate);
  if (!normalizedRoot) return false;
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function relativeToRoot(root: string, candidate: string): string | null {
  if (!isPathInside(root, candidate)) return null;
  const normalizedRoot = trimTrailingSlash(root);
  return normalizeSlashes(candidate).slice(normalizedRoot.length).replace(/^\/+/, "");
}

function hasHiddenSegment(relativePath: string): boolean {
  return normalizeSlashes(relativePath)
    .split("/")
    .some((part) => part.startsWith(".") || part === "__MACOSX");
}

function isDatabasePath(path: string): boolean {
  const lower = path.toLocaleLowerCase();
  return DATABASE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index).toLocaleLowerCase() : "";
}

function normalizeLibraryRelativePdfPath(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("path must be a relative PDF path");
  const raw = value.replace(/\\/g, "/").trim();
  if (!raw || raw.length > 1024 || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new TypeError("path must be a relative PDF path below the configured library root");
  }
  const parts = raw.split("/");
  if (
    parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))
    || hasHiddenSegment(raw)
  ) {
    throw new TypeError("path contains an unsafe or hidden component");
  }
  const normalized = parts.join("/");
  if (extensionOf(normalized) !== ".pdf" || isDatabasePath(normalized)) {
    throw new TypeError("path must identify a PDF file");
  }
  return normalized;
}

function truncateTextEnd(value: string, maximum: number): { text: string; truncated: boolean } {
  if (value.length <= maximum) return { text: value, truncated: false };
  if (maximum <= 0) return { text: "", truncated: true };
  if (maximum === 1) return { text: "…", truncated: true };
  return { text: `${value.slice(0, maximum - 1)}…`, truncated: true };
}

function normalizePageStats(stats: ReaderPageStats): ReaderPageStats {
  const pageCount =
    typeof stats.pageCount === "number" && Number.isInteger(stats.pageCount) && stats.pageCount > 0
      ? stats.pageCount
      : undefined;
  let pageIndex = Number.isInteger(stats.pageIndex)
    ? stats.pageIndex
    : Number.isInteger(stats.pageNumber)
      ? stats.pageNumber - 1
      : 0;
  pageIndex = Math.max(0, pageIndex);
  if (pageCount !== undefined) pageIndex = Math.min(pageIndex, pageCount - 1);
  return {
    pageIndex,
    pageNumber: pageIndex + 1,
    pageCount,
    pageLabel: cleanText(stats.pageLabel) || undefined,
  };
}

function splitPdfPages(text: string): string[] {
  if (!text) return [];
  return text
    .replace(/\r\n?/g, "\n")
    .split("\f")
    .map((page) => page.trim());
}

function pageTextFromWorkerResult(
  result: PdfWorkerTextResult | null,
  requestedPageIndexes: readonly number[] | null,
  targetPageIndex: number,
): string | null {
  if (!result?.text) return null;
  const pages = splitPdfPages(result.text);
  if (!pages.length) return null;
  if (requestedPageIndexes) {
    const position = requestedPageIndexes.indexOf(targetPageIndex);
    return position >= 0 ? cleanText(pages[position]) || null : null;
  }
  return cleanText(pages[targetPageIndex]) || null;
}

function formatMarkdownValue(value: string | undefined | null): string {
  return cleanText(value).replace(/\n+/g, " ") || "Unknown";
}

function truncateMiddle(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const left = Math.ceil((maximum - 1) / 2);
  const right = Math.floor((maximum - 1) / 2);
  return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

function summarizeLibraryAttachment(metadata: AttachmentMetadata): LibraryAttachmentSummary {
  return {
    id: metadata.id,
    key: truncateMiddle(metadata.key, 128),
    libraryID: metadata.libraryID,
    title: metadata.title ? truncateMiddle(metadata.title, 512) : undefined,
    filename: metadata.filename ? truncateMiddle(metadata.filename, 512) : undefined,
    contentType: metadata.contentType ? truncateMiddle(metadata.contentType, 128) : undefined,
  };
}

function attachmentCacheKey(
  metadata: Pick<AttachmentMetadata, "libraryID" | "key">,
): string {
  return `${metadata.libraryID ?? "0"}-${metadata.key}`;
}

/**
 * Captures the active Reader and exposes a fixed, read-only tool set.
 */
export class ReaderContextService<TReader = unknown, TItem = unknown> {
  readonly tools = READER_CONTEXT_TOOLS;

  private readonly zotero: ZoteroReadAdapter<TReader, TItem>;
  private readonly host: ReaderContextHostAdapter;
  private readonly options: Required<Omit<ReaderContextOptions, "libraryRoot" | "now">> & {
    libraryRoot: string | null;
    now: () => Date;
  };
  private latestHook: ReaderHook<TReader, TItem> | null = null;
  private snapshot: Snapshot<TReader, TItem> | null = null;
  private captureSequence = 0;
  private profileSyncTail: Promise<void> = Promise.resolve();
  private readonly fullTextCache = new Map<string, Promise<CachedFullText>>();
  private readonly pdfTextReferences = new Map<string, PdfTextReference>();
  private readonly materializedStaticWorkspaces = new Set<string>();
  private readonly librarySnapshots = new Map<string, CachedLibrarySnapshot>();
  private readonly librarySnapshotBuilds = new Map<
    string,
    Promise<ZotkitLibrarySnapshotReference | null>
  >();
  private lastWorkspacePruneAt: number | null = null;

  constructor(
    zotero: ZoteroReadAdapter<TReader, TItem>,
    host: ReaderContextHostAdapter,
    options: ReaderContextOptions = {},
  ) {
    this.zotero = zotero;
    this.host = host;
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      libraryRoot: cleanText(options.libraryRoot) || null,
      maxLibraryScanDepth: Math.min(
        positiveInteger(options.maxLibraryScanDepth, DEFAULT_OPTIONS.maxLibraryScanDepth),
        32,
      ),
      maxLibraryScanFiles: Math.min(
        positiveInteger(options.maxLibraryScanFiles, DEFAULT_OPTIONS.maxLibraryScanFiles),
        50_000,
      ),
      maxSearchResults: Math.min(
        positiveInteger(options.maxSearchResults, DEFAULT_OPTIONS.maxSearchResults),
        100,
      ),
      maxReadPages: Math.min(
        positiveInteger(options.maxReadPages, DEFAULT_OPTIONS.maxReadPages),
        100,
      ),
      maxLibrarySearchPages: Math.min(
        positiveInteger(options.maxLibrarySearchPages, DEFAULT_OPTIONS.maxLibrarySearchPages),
        500,
      ),
      maxToolTextCharacters: Math.min(
        positiveInteger(options.maxToolTextCharacters, DEFAULT_OPTIONS.maxToolTextCharacters),
        250_000,
      ),
      maxWorkspaceCacheEntries: Math.min(
        positiveInteger(
          options.maxWorkspaceCacheEntries,
          DEFAULT_OPTIONS.maxWorkspaceCacheEntries,
        ),
        200,
      ),
      workspaceCacheMaxAgeMs: Math.min(
        positiveInteger(
          options.workspaceCacheMaxAgeMs,
          DEFAULT_OPTIONS.workspaceCacheMaxAgeMs,
        ),
        365 * 24 * 60 * 60 * 1_000,
      ),
      workspaceCachePruneIntervalMs: Math.min(
        positiveInteger(
          options.workspaceCachePruneIntervalMs,
          DEFAULT_OPTIONS.workspaceCachePruneIntervalMs,
        ),
        24 * 60 * 60 * 1_000,
      ),
      maxWorkspaceTextCharacters: Math.min(
        positiveInteger(
          options.maxWorkspaceTextCharacters,
          DEFAULT_OPTIONS.maxWorkspaceTextCharacters,
        ),
        250_000,
      ),
      maxFullTextCacheEntries: Math.min(
        positiveInteger(
          options.maxFullTextCacheEntries,
          DEFAULT_OPTIONS.maxFullTextCacheEntries,
        ),
        16,
      ),
      maxPdfTextSnapshotCharacters: clamp(
        positiveInteger(
          options.maxPdfTextSnapshotCharacters,
          DEFAULT_OPTIONS.maxPdfTextSnapshotCharacters,
        ),
        250_000,
        32_000_000,
      ),
      librarySnapshotTtlMs: Math.min(
        positiveInteger(
          options.librarySnapshotTtlMs,
          DEFAULT_OPTIONS.librarySnapshotTtlMs,
        ),
        24 * 60 * 60 * 1_000,
      ),
      maxLibrarySnapshotItems: Math.min(
        positiveInteger(
          options.maxLibrarySnapshotItems,
          DEFAULT_OPTIONS.maxLibrarySnapshotItems,
        ),
        50_000,
      ),
      maxLibrarySnapshotCollections: Math.min(
        positiveInteger(
          options.maxLibrarySnapshotCollections,
          DEFAULT_OPTIONS.maxLibrarySnapshotCollections,
        ),
        20_000,
      ),
      maxLibrarySnapshotCharacters: clamp(
        positiveInteger(
          options.maxLibrarySnapshotCharacters,
          DEFAULT_OPTIONS.maxLibrarySnapshotCharacters,
        ),
        1_000_000,
        32_000_000,
      ),
      now: options.now ?? (() => new Date()),
    };
  }

  /**
   * Materialize the built-in Zotkit discovery snapshot on the deliberate
   * terminal-open/refresh path. Normal page and selection refreshes only reuse
   * the last reference and never enumerate the library.
   */
  async ensureZotkitLibrarySnapshot(force = false): Promise<ZotkitLibrarySnapshotReference | null> {
    const snapshot = await this.ensureSnapshot();
    const libraryID = snapshot.context.attachment.libraryID;
    if (libraryID === undefined || libraryID === null || libraryID === "") return null;
    const reference = await this.buildLibrarySnapshot(libraryID, force);
    // Snapshot construction may take long enough for the user to turn a page or
    // switch papers. Always attach the completed library reference to the newest
    // context, and let enqueueWorkspaceSync reject it if another capture starts.
    const active = this.snapshot;
    const sequence = this.captureSequence;
    if (
      active?.context.workspace
      && snapshotLibraryKey(active.context.attachment.libraryID)
        === snapshotLibraryKey(libraryID)
    ) {
      // A failed build records a bounded warning on the active context. Sync
      // even when there is no cached reference so that warning is visible to
      // the terminal agent and survives in context.json.
      await this.enqueueWorkspaceSync(sequence, active.context, active.context.workspace);
    }
    return reference;
  }

  /**
   * Prepare the terminal MCP's whole-document read source. Zotero's existing
   * index is referenced in place. Only when no safe index reference exists do
   * we mirror a bounded PDFWorker result into the plugin's private workspace.
   */
  async ensureCurrentPdfTextReference(): Promise<PdfTextReference | null> {
    const snapshot = await this.ensureSnapshot();
    const files = snapshot.context.workspace;
    if (!files) return null;
    const existing = snapshot.context.pdfText;
    // A truncated in-place index reference must never be handed to the
    // terminal as-is: Zotero only indexed a prefix of the document. Fall
    // through to the ensureFullText mirror path below so the terminal gets
    // the uncapped PDFWorker extraction instead.
    if (existing && existing.path !== files.pdfText && !existing.truncated) return existing;
    if (existing && existing.path === files.pdfText) {
      if (await this.host.profileTextExists(files.pdfText)) {
        this.rememberPdfTextReference(snapshot.context.attachment, existing);
        return existing;
      }
      // Workspace cleanup may have reclaimed the fallback while this service
      // still has a live paper/session object. Drop the stale reference before
      // rebuilding it from the bounded in-memory/Zotero text source.
      snapshot.context.pdfText = null;
      this.pdfTextReferences.delete(attachmentCacheKey(snapshot.context.attachment));
    }

    const fullText = await this.ensureFullText(snapshot);
    if (this.snapshot !== snapshot) return this.ensureCurrentPdfTextReference();
    if (!cleanText(fullText.text)) {
      const warning = `${PDF_TEXT_WARNING_PREFIX} Zotero has no indexed or extractable text for this PDF`;
      if (!snapshot.context.warnings.includes(warning)) snapshot.context.warnings.push(warning);
      await this.enqueueWorkspaceSync(this.captureSequence, snapshot.context, files);
      return null;
    }

    const bounded = truncateTextEnd(
      fullText.text.replace(/\r\n?/g, "\n"),
      this.options.maxPdfTextSnapshotCharacters,
    );
    await this.host.replaceProfileText(files.pdfText, bounded.text);
    if (this.snapshot !== snapshot) return this.ensureCurrentPdfTextReference();
    const reference: PdfTextReference = {
      schemaVersion: 1,
      path: files.pdfText,
      source: fullText.source === "indexed-fulltext" ? "indexed-fulltext" : "pdf-worker",
      characters: bounded.text.length,
      extractedPages: splitPdfPages(bounded.text).length,
      totalPages: fullText.totalPages ?? snapshot.context.page.pageCount,
      truncated: bounded.truncated,
    };
    snapshot.context.pdfText = reference;
    snapshot.context.warnings = snapshot.context.warnings.filter(
      (warning) => !warning.startsWith(PDF_TEXT_WARNING_PREFIX),
    );
    this.rememberPdfTextReference(snapshot.context.attachment, reference);
    await this.enqueueWorkspaceSync(this.captureSequence, snapshot.context, files);
    return reference;
  }

  private rememberPdfTextReference(
    attachment: AttachmentMetadata,
    reference: PdfTextReference,
  ): void {
    const key = attachmentCacheKey(attachment);
    this.pdfTextReferences.delete(key);
    this.pdfTextReferences.set(key, reference);
    while (this.pdfTextReferences.size > this.options.maxFullTextCacheEntries) {
      const oldest = this.pdfTextReferences.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.pdfTextReferences.delete(oldest);
    }
  }

  private async restorePdfTextReference(
    attachment: AttachmentMetadata,
    files: WorkspaceFiles,
  ): Promise<PdfTextReference | null> {
    const key = attachmentCacheKey(attachment);
    const cached = this.pdfTextReferences.get(key);
    if (!cached) return null;
    if (cached.path !== files.pdfText || !(await this.host.profileTextExists(files.pdfText))) {
      this.pdfTextReferences.delete(key);
      return null;
    }
    this.rememberPdfTextReference(attachment, cached);
    return cached;
  }

  getCachedZotkitLibrarySnapshotReference(): ZotkitLibrarySnapshotReference | null {
    const libraryID = this.snapshot?.context.attachment.libraryID;
    const key = snapshotLibraryKey(libraryID);
    return key ? this.librarySnapshots.get(key)?.reference ?? null : null;
  }

  /**
   * Drop every plugin-owned text/reference cache for an attachment after its
   * link target or PDF bytes change. The caller reloads Zotero's Reader before
   * capturing again, so neither PDF.js nor the MCP tools can reuse old text.
   */
  async invalidateAttachmentCaches(
    attachment: Pick<AttachmentMetadata, "key" | "libraryID">,
  ): Promise<void> {
    const key = attachmentCacheKey(attachment);
    this.fullTextCache.delete(key);
    this.pdfTextReferences.delete(key);
    const active = this.snapshot;
    if (!active || attachmentCacheKey(active.context.attachment) !== key) return;

    // Cancel any slower capture that began before the approved mutation. Its
    // promise may still settle, but it can no longer become the active snapshot.
    this.captureSequence += 1;
    this.snapshot = null;
    const files = active.context.workspace;
    if (files && await this.host.profileTextExists(files.pdfText)) {
      // A previous capture may have created this fallback and a later capture
      // may have switched to Zotero's external index. Empty it regardless of
      // the currently selected source so Codex cannot read stale PDF text
      // directly from the private workspace during the reload window.
      await this.host.replaceProfileText(files.pdfText, "");
    }
  }

  /**
   * Consume a Zotero Reader hook.  The item is observed and normalized by the
   * adapter, then a paper-scoped profile workspace is refreshed.
   */
  async acceptReaderHook(hook: ReaderHook<TReader, TItem>): Promise<ReaderContext> {
    this.latestHook = hook;
    return this.capture(hook, true);
  }

  /** Refresh from the active reader when no explicit event hook is supplied. */
  async refresh(hook?: ReaderHook<TReader, TItem>): Promise<ReaderContext> {
    const activeHook = hook ?? (await this.zotero.getActiveReaderHook());
    let resolvedHook = activeHook ?? this.latestHook;
    if (!resolvedHook) throw new Error("No active Zotero PDF Reader");

    // Active tab state is authoritative. Preserve the latest popup selection
    // only when it belongs to that exact Reader instance.
    if (
      activeHook
      && this.latestHook?.reader === activeHook.reader
      && activeHook.selectionAnnotation === undefined
      && activeHook.params?.annotation === undefined
    ) {
      const latestSelection = this.latestHook.selectionAnnotation
        ?? this.latestHook.params?.annotation;
      if (latestSelection !== undefined) {
        resolvedHook = { ...activeHook, selectionAnnotation: latestSelection };
      }
    }
    this.latestHook = resolvedHook;
    return this.capture(resolvedHook, true);
  }

  /**
   * Refresh in response to Zotero's noisy page-change notifier. The notifier
   * may fire several times for one visual page transition, so first compare
   * the inexpensive live page state with the committed snapshot. Explicit
   * refreshes and Reader hooks still use `refresh`/`acceptReaderHook` and are
   * never deduplicated, preserving selection and tab-switch accuracy.
   */
  async refreshForPageChange(): Promise<ReaderContext | null> {
    const activeHook = await this.zotero.getActiveReaderHook();
    if (!activeHook) {
      return this.snapshot ? null : this.refresh();
    }
    if (this.snapshot?.hook.reader === activeHook.reader) {
      const livePage = normalizePageStats(
        await this.zotero.getPageStats(activeHook.reader),
      );
      if (samePageStats(livePage, this.snapshot.context.page)) return null;
    }
    return this.refresh(activeHook);
  }

  getCachedContext(): ReaderContext | null {
    return this.snapshot?.context ?? null;
  }

  async invokeTool(name: ReaderToolName, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!(READER_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new Error(`Unknown Reader tool: ${name}`);
    }
    switch (name) {
      case "zotero_get_reader_context":
        return this.getReaderContext();
      case "zotero_get_current_page":
        return this.getCurrentPage();
      case "zotero_get_current_selection":
        return this.getCurrentSelection();
      case "zotero_search_current_pdf":
        return this.searchCurrentPdf(
          this.requireQuery(args.query),
          this.parseLimit(args.limit),
        );
      case "zotero_read_pdf_pages":
        return this.readPdfPages(
          positiveInteger(args.start_page),
          positiveInteger(args.end_page),
        );
      case "zotero_search_library":
        return this.searchLibrary(
          this.requireQuery(args.query),
          this.parseLimit(args.limit),
        );
      case "zotero_read_library_pdf_pages":
        return this.readLibraryPdfPages(
          normalizeLibraryRelativePdfPath(args.path),
          positiveInteger(args.start_page),
          positiveInteger(args.end_page),
        );
      case "zotero_search_library_pdf":
        return this.searchLibraryPdf(
          normalizeLibraryRelativePdfPath(args.path),
          this.requireQuery(args.query),
          this.parseLimit(args.limit),
        );
      case "zotero_list_annotations":
        return this.listAnnotations(
          args.page === undefined ? undefined : positiveInteger(args.page),
        );
      case "zotkit_find_items":
        return this.findZotkitItems(
          this.requireQuery(args.query),
          this.parseListLimit(args.limit, 100, this.options.maxSearchResults),
        );
      case "zotkit_get_item":
        return this.getZotkitItem(cleanText(args.key));
      case "zotkit_list_collections":
        return this.listZotkitCollections(
          cleanText(args.query),
          this.parseListLimit(args.limit, 500, 100),
        );
      case "zotkit_list_tags":
        return this.listZotkitTags(
          cleanText(args.query),
          this.parseListLimit(args.limit, 500, 100),
        );
    }
  }

  async getReaderContext(): Promise<ReaderContext> {
    return (await this.ensureSnapshot()).context;
  }

  async getCurrentPage(): Promise<PageTextResult> {
    return (await this.ensureSnapshot()).context.page;
  }

  async getCurrentSelection(): Promise<ReaderSelection | null> {
    return (await this.ensureSnapshot()).context.selection;
  }

  async searchCurrentPdf(query: string, limit = this.options.maxSearchResults): Promise<{
    query: string;
    source: FullTextResult["source"];
    matches: SearchMatch[];
  }> {
    const snapshot = await this.ensureSnapshot();
    const fullText = await this.ensureFullText(snapshot);
    const matches = searchPageText(fullText.text, query, limit);
    return { query, source: fullText.source, matches };
  }

  async readPdfPages(startPage: number, endPage: number): Promise<{
    startPage: number;
    endPage: number;
    pages: PageTextResult[];
  }> {
    if (endPage < startPage) {
      throw new RangeError("end_page must be greater than or equal to start_page");
    }
    if (endPage - startPage + 1 > this.options.maxReadPages) {
      throw new RangeError(`A maximum of ${this.options.maxReadPages} pages can be read at once`);
    }

    const snapshot = await this.ensureSnapshot();
    let pageCount = snapshot.context.page.pageCount;
    if (pageCount !== undefined && endPage > pageCount) {
      throw new RangeError(`Requested page ${endPage}, but the PDF has ${pageCount} pages`);
    }

    const pageIndexes = Array.from(
      { length: endPage - startPage + 1 },
      (_, index) => startPage - 1 + index,
    );
    const pdfJs = await Promise.all(
      pageIndexes.map(async (pageIndex) => {
        try {
          return cleanText(await this.zotero.extractPdfJsPage(snapshot.hook.reader, pageIndex)) || null;
        } catch {
          return null;
        }
      }),
    );

    const missingPdfJsIndexes = pageIndexes.filter((_, position) => !pdfJs[position]);
    const indexed = missingPdfJsIndexes.length
      ? await this.zotero.readIndexedFullText(snapshot.attachmentHandle).catch(() => null)
      : null;
    const indexedPages = splitPdfPages(indexed?.text ?? "");
    pageCount = indexed?.totalPages ?? pageCount;
    if (pageCount !== undefined && endPage > pageCount) {
      throw new RangeError(`Requested page ${endPage}, but the PDF has ${pageCount} pages`);
    }
    const workerPageIndexes = missingPdfJsIndexes.filter(
      (pageIndex) => !cleanText(indexedPages[pageIndex]),
    );
    const worker = workerPageIndexes.length
      ? await this.safePdfWorker(snapshot.attachmentHandle, workerPageIndexes, [])
      : null;
    pageCount = worker?.totalPages ?? pageCount;
    if (pageCount !== undefined && endPage > pageCount) {
      throw new RangeError(`Requested page ${endPage}, but the PDF has ${pageCount} pages`);
    }
    const pages = pageIndexes.map((pageIndex, position): PageTextResult => {
      const fromPdfJs = pdfJs[position];
      const fromIndexed = cleanText(indexedPages[pageIndex]) || null;
      const fromWorker = pageTextFromWorkerResult(worker, workerPageIndexes, pageIndex);
      const text = fromPdfJs ?? fromIndexed ?? fromWorker ?? "";
      const source: TextSource = fromPdfJs
        ? "pdfjs"
        : fromIndexed
          ? "indexed-fulltext"
          : fromWorker
            ? "pdf-worker"
            : "none";
      return {
        pageIndex,
        pageNumber: pageIndex + 1,
        pageCount,
        text,
        source,
        warnings: text ? [] : [`No text could be extracted for PDF page ${pageIndex + 1}`],
      };
    });
    return { startPage, endPage, pages };
  }

  async searchLibrary(query: string, limit = this.options.maxSearchResults): Promise<{
    query: string;
    root: string;
    matches: LibrarySearchMatch[];
  }> {
    const root = this.options.libraryRoot;
    if (!root) throw new Error("No external PDF library root is configured");
    const entries = await this.host.scanLibraryFileNames(root, {
      maxDepth: this.options.maxLibraryScanDepth,
      maxFiles: this.options.maxLibraryScanFiles,
    });
    const needle = query.toLocaleLowerCase();
    const matches: LibrarySearchMatch[] = [];
    for (const entry of entries) {
      if (matches.length >= limit) break;
      const relativePath = relativeToRoot(root, entry.path) ?? entry.relativePath ?? "";
      if (!relativePath || hasHiddenSegment(relativePath) || isDatabasePath(relativePath)) continue;
      if (extensionOf(relativePath) !== ".pdf") continue;
      // A relative path supplied by the host is still rejected if the absolute
      // path escaped the configured root.
      if (!isPathInside(root, entry.path)) continue;
      if (!normalizeSlashes(relativePath).toLocaleLowerCase().includes(needle)) continue;
      matches.push({
        ...entry,
        name: entry.name || relativePath.split("/").pop() || relativePath,
        relativePath: normalizeSlashes(relativePath),
        extension: extensionOf(entry.name || relativePath),
      });
    }
    return { query, root, matches };
  }

  async readLibraryPdfPages(relativePath: string, startPage: number, endPage: number): Promise<unknown> {
    const normalizedPath = normalizeLibraryRelativePdfPath(relativePath);
    if (endPage < startPage) {
      throw new RangeError("end_page must be greater than or equal to start_page");
    }
    if (endPage - startPage + 1 > this.options.maxReadPages) {
      throw new RangeError(`A maximum of ${this.options.maxReadPages} pages can be read at once`);
    }
    const lookup = await this.resolveLibraryPdfAttachment(normalizedPath);
    if (lookup.status !== "matched") return lookup;

    const warnings: string[] = [];
    const indexed = await this.zotero.readIndexedFullText(lookup.attachment).catch((error) => {
      warnings.push(`Indexed full text unavailable: ${boundedErrorMessage(error)}`);
      return null;
    });
    const indexedPages = splitPdfPages(indexed?.text ?? "");
    let pageCount = indexed?.totalPages;
    if (pageCount !== undefined && endPage > pageCount) {
      throw new RangeError(`Requested page ${endPage}, but the PDF has ${pageCount} pages`);
    }

    const pageIndexes = Array.from(
      { length: endPage - startPage + 1 },
      (_, index) => startPage - 1 + index,
    );
    const missingPageIndexes = pageIndexes.filter((pageIndex) => !cleanText(indexedPages[pageIndex]));
    if (missingPageIndexes.length) await this.revalidateLibraryPdfPath(normalizedPath);
    const worker = missingPageIndexes.length
      ? await this.safePdfWorker(lookup.attachment, missingPageIndexes, warnings)
      : null;
    pageCount = worker?.totalPages ?? pageCount;
    if (pageCount !== undefined && endPage > pageCount) {
      throw new RangeError(`Requested page ${endPage}, but the PDF has ${pageCount} pages`);
    }

    const unboundedPages = pageIndexes.map((pageIndex) => {
      const indexedText = cleanText(indexedPages[pageIndex]);
      const workerText = pageTextFromWorkerResult(worker, missingPageIndexes, pageIndex) ?? "";
      const text = indexedText || workerText;
      const source: TextSource = indexedText
        ? "indexed-fulltext"
        : workerText
          ? "pdf-worker"
          : "none";
      return {
        pageIndex,
        pageNumber: pageIndex + 1,
        pageCount,
        text,
        source,
        warnings: text ? [] : [`No text could be extracted for PDF page ${pageIndex + 1}`],
      };
    });
    const availableCharacters = unboundedPages.reduce((sum, page) => sum + page.text.length, 0);
    if (!availableCharacters) {
      return {
        status: "unindexed",
        relativePath: normalizedPath,
        attachment: lookup.summary,
        message:
          "A Zotero attachment matched this PDF, but neither its existing full-text cache nor read-only PDFWorker extraction returned text.",
        warnings,
      };
    }

    let remaining = this.options.maxToolTextCharacters;
    let outputTruncated = false;
    const pages = unboundedPages.map((page) => {
      const bounded = truncateTextEnd(page.text, remaining);
      remaining -= bounded.text.length;
      outputTruncated ||= bounded.truncated;
      return {
        ...page,
        text: bounded.text,
        availableCharacters: page.text.length,
        truncated: bounded.truncated,
      };
    });
    return {
      status: pages.some((page) => !page.text && !page.truncated) ? "partial" : "ok",
      relativePath: normalizedPath,
      attachment: lookup.summary,
      startPage,
      endPage,
      pages,
      output: {
        characters: this.options.maxToolTextCharacters - remaining,
        availableCharacters,
        limit: this.options.maxToolTextCharacters,
        truncated: outputTruncated,
      },
      warnings,
    };
  }

  async searchLibraryPdf(
    relativePath: string,
    query: string,
    limit = this.options.maxSearchResults,
  ): Promise<unknown> {
    const normalizedPath = normalizeLibraryRelativePdfPath(relativePath);
    const normalizedQuery = this.requireQuery(query);
    const lookup = await this.resolveLibraryPdfAttachment(normalizedPath);
    if (lookup.status !== "matched") return { ...lookup, query: normalizedQuery };

    const warnings: string[] = [];
    let fullText = await this.zotero.readIndexedFullText(lookup.attachment).catch((error) => {
      warnings.push(`Indexed full text unavailable: ${boundedErrorMessage(error)}`);
      return null;
    });
    let source: FullTextResult["source"] = "indexed-fulltext";
    if (!cleanText(fullText?.text)) {
      const pageIndexes = Array.from(
        { length: this.options.maxLibrarySearchPages },
        (_, pageIndex) => pageIndex,
      );
      await this.revalidateLibraryPdfPath(normalizedPath);
      fullText = await this.safePdfWorker(lookup.attachment, pageIndexes, warnings);
      source = "pdf-worker";
    }
    const allPages = splitPdfPages(fullText?.text ?? "");
    const totalPages = fullText?.totalPages ?? allPages.length;
    const searchablePageCount = Math.min(
      this.options.maxLibrarySearchPages,
      totalPages || allPages.length,
    );
    const searchablePages = allPages.slice(0, searchablePageCount);
    if (!searchablePages.some((page) => Boolean(cleanText(page)))) {
      return {
        status: "unindexed",
        relativePath: normalizedPath,
        query: normalizedQuery,
        attachment: lookup.summary,
        message:
          "A Zotero attachment matched this PDF, but neither its existing full-text cache nor bounded read-only PDFWorker extraction returned searchable text.",
        warnings,
      };
    }

    const unboundedMatches = searchPageText(
      searchablePages.join("\f"),
      normalizedQuery,
      Math.min(limit, 100),
    );
    let remaining = this.options.maxToolTextCharacters;
    let outputTruncated = false;
    const matches = unboundedMatches.map((match) => {
      const bounded = truncateTextEnd(match.snippet, remaining);
      remaining -= bounded.text.length;
      outputTruncated ||= bounded.truncated;
      return { ...match, snippet: bounded.text, truncated: bounded.truncated };
    });
    return {
      status: "ok",
      relativePath: normalizedPath,
      query: normalizedQuery,
      attachment: lookup.summary,
      source,
      pagesSearched: searchablePages.length,
      totalPages,
      pageLimit: this.options.maxLibrarySearchPages,
      pageLimitReached: totalPages > searchablePages.length,
      matches,
      output: {
        characters: this.options.maxToolTextCharacters - remaining,
        limit: this.options.maxToolTextCharacters,
        truncated: outputTruncated,
      },
      warnings,
    };
  }

  async listAnnotations(page?: number): Promise<{
    attachmentKey: string;
    annotations: ReaderAnnotation[];
  }> {
    const snapshot = await this.ensureSnapshot();
    const annotations = await this.zotero.listAnnotations(snapshot.attachmentHandle);
    const normalized = annotations
      .map(normalizeAnnotation)
      .filter((annotation) => page === undefined || annotation.pageNumber === page)
      .sort((left, right) => {
        const pageDifference = (left.pageIndex ?? Number.MAX_SAFE_INTEGER)
          - (right.pageIndex ?? Number.MAX_SAFE_INTEGER);
        return pageDifference || left.key.localeCompare(right.key);
      });
    return { attachmentKey: snapshot.context.attachment.key, annotations: normalized };
  }

  async findZotkitItems(query: string, limit: number): Promise<{
    query: string;
    libraryID: number | string;
    complete: boolean;
    matches: Array<Record<string, JsonValue>>;
  }> {
    const snapshot = await this.ensureZotkitLibraryData();
    const needle = query.toLocaleLowerCase();
    const collections = new Map(snapshot.collections.map((collection) => [collection.key, collection]));
    const matches: Array<Record<string, JsonValue>> = [];
    for (const item of snapshot.items) {
      if (matches.length >= limit) break;
      const creators = item.creators
        .map((creator) => creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(" "))
        .filter(Boolean);
      const collectionPaths = item.collectionKeys
        .map((key) => collections.get(key)?.path || "")
        .filter(Boolean);
      const haystack = [
        item.key,
        item.title,
        item.DOI,
        item.publicationTitle,
        item.abstractNote,
        item.filename || "",
        ...creators,
        ...item.tags,
        ...item.collections,
        ...collectionPaths,
      ].join("\n").toLocaleLowerCase();
      if (!haystack.includes(needle)) continue;
      matches.push({
        key: item.key,
        itemType: item.itemType,
        title: truncateMiddle(item.title, 1_000),
        creators: creators.slice(0, 20),
        date: truncateMiddle(item.date, 128),
        DOI: truncateMiddle(item.DOI, 256),
        tags: item.tags.slice(0, 50),
        collectionKeys: item.collectionKeys.slice(0, 100),
        collectionPaths: collectionPaths.slice(0, 100),
        parentItem: item.parentItem || null,
        filename: item.filename ? truncateMiddle(item.filename, 1_000) : null,
      });
    }
    return {
      query,
      libraryID: snapshot.libraryID,
      complete: snapshot.complete,
      matches,
    };
  }

  async getZotkitItem(key: string): Promise<Record<string, JsonValue>> {
    if (!key || key.length > 128) throw new TypeError("key must be a non-empty Zotero item key");
    const snapshot = await this.ensureZotkitLibraryData();
    const normalized = key.toUpperCase();
    const item = snapshot.items.find((candidate) => candidate.key.toUpperCase() === normalized);
    if (!item) throw new Error(`No Zotero item with key ${key} exists in the active library snapshot`);
    const collections = new Map(snapshot.collections.map((collection) => [collection.key, collection]));
    return {
      key: item.key,
      itemType: item.itemType,
      title: item.title,
      creators: item.creators.map((creator) => ({ ...creator })) as unknown as JsonValue,
      date: item.date,
      publicationTitle: item.publicationTitle,
      DOI: item.DOI,
      url: item.url,
      abstractNote: item.abstractNote,
      language: item.language,
      tags: [...item.tags],
      collectionKeys: [...item.collectionKeys],
      collections: item.collectionKeys.map((collectionKey) => {
        const collection = collections.get(collectionKey);
        return collection ? {
          key: collection.key,
          name: collection.name,
          path: collection.path,
          parentKey: collection.parentKey,
        } : { key: collectionKey, name: "", path: "", parentKey: null };
      }),
      version: item.version,
      parentItem: item.parentItem ?? null,
      filename: item.filename ?? null,
      contentType: item.contentType ?? null,
    };
  }

  async listZotkitCollections(query: string, limit: number): Promise<{
    libraryID: number | string;
    complete: boolean;
    collections: ZotkitLibraryCollection[];
  }> {
    if (query.length > 512) throw new TypeError("query must not exceed 512 characters");
    const snapshot = await this.ensureZotkitLibraryData();
    const needle = query.toLocaleLowerCase();
    const collections = snapshot.collections
      .filter((collection) => !needle || [collection.key, collection.name, collection.path]
        .join("\n").toLocaleLowerCase().includes(needle))
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, limit)
      .map((collection) => ({ ...collection }));
    return { libraryID: snapshot.libraryID, complete: snapshot.complete, collections };
  }

  async listZotkitTags(query: string, limit: number): Promise<{
    libraryID: number | string;
    complete: boolean;
    tags: ZotkitLibraryTag[];
  }> {
    if (query.length > 512) throw new TypeError("query must not exceed 512 characters");
    const snapshot = await this.ensureZotkitLibraryData();
    const needle = query.toLocaleLowerCase();
    const tags = snapshot.tags
      .filter((tag) => !needle || tag.tag.toLocaleLowerCase().includes(needle))
      .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag))
      .slice(0, limit)
      .map((tag) => ({ ...tag }));
    return { libraryID: snapshot.libraryID, complete: snapshot.complete, tags };
  }

  private async resolveLibraryPdfAttachment(relativePath: string): Promise<
    | {
      status: "matched";
      relativePath: string;
      attachment: TItem;
      metadata: AttachmentMetadata;
      summary: LibraryAttachmentSummary;
    }
    | {
      status: "not-associated" | "ambiguous";
      relativePath: string;
      message: string;
      candidateCount: number;
    }
  > {
    const root = this.options.libraryRoot;
    if (!root) throw new Error("No external PDF library root is configured");
    const entry = await this.host.resolveLibraryPdfPath(root, relativePath);
    if (!entry) {
      throw new Error(`No safe, non-hidden PDF exists at library path: ${relativePath}`);
    }
    const resolution = await this.zotero.findLoadedAttachmentByPath(entry.path);
    if (resolution.status !== "matched" || !resolution.attachment) {
      const ambiguous = resolution.status === "ambiguous";
      return {
        status: ambiguous ? "ambiguous" : "not-associated",
        relativePath,
        candidateCount: resolution.candidateCount,
        message: ambiguous
          ? "More than one Zotero PDF attachment matched this path, so no content was read."
          : "No uniquely matching Zotero PDF attachment exists. The plugin does not read the file directly.",
      };
    }
    const metadata = await this.zotero.describeAttachment(resolution.attachment);
    if (
      metadata.contentType !== "application/pdf"
      && extensionOf(metadata.filename ?? "") !== ".pdf"
    ) {
      return {
        status: "not-associated",
        relativePath,
        candidateCount: 0,
        message: "The matching Zotero item is not a PDF attachment, so no content was read.",
      };
    }
    return {
      status: "matched",
      relativePath,
      attachment: resolution.attachment,
      metadata,
      summary: summarizeLibraryAttachment(metadata),
    };
  }

  private async revalidateLibraryPdfPath(relativePath: string): Promise<void> {
    const root = this.options.libraryRoot;
    if (!root || !(await this.host.resolveLibraryPdfPath(root, relativePath))) {
      throw new Error(`Library PDF path became unavailable or unsafe: ${relativePath}`);
    }
  }

  private async ensureSnapshot(): Promise<Snapshot<TReader, TItem>> {
    const activeHook = await this.zotero.getActiveReaderHook().catch(() => null);
    if (this.snapshot && activeHook) {
      if (activeHook.reader !== this.snapshot.hook.reader) {
        this.latestHook = activeHook;
        await this.capture(activeHook, true);
      } else {
        const activePage = await this.zotero.getPageStats(activeHook.reader)
          .then(normalizePageStats)
          .catch(() => null);
        const cachedPage = this.snapshot.context.page;
        if (
          activePage
          && (activePage.pageIndex !== cachedPage.pageIndex
            || activePage.pageCount !== cachedPage.pageCount
            || activePage.pageLabel !== cachedPage.pageLabel)
        ) {
          // The public Reader event API does not emit a page-change event, so
          // live tool calls perform this inexpensive observation themselves.
          const hook: ReaderHook<TReader, TItem> = {
            ...activeHook,
            selectionAnnotation:
              this.latestHook?.reader === activeHook.reader
                ? this.latestHook.selectionAnnotation ?? this.latestHook.params?.annotation
                : undefined,
          };
          this.latestHook = hook;
          await this.capture(hook, true);
        }
      }
      if (this.snapshot) return this.snapshot;
    }
    if (this.snapshot) return this.snapshot;
    const hook = activeHook ?? this.latestHook;
    if (!hook) throw new Error("No active Zotero PDF Reader");
    this.latestHook = hook;
    await this.capture(hook, true);
    if (!this.snapshot) throw new Error("Reader context capture did not complete");
    return this.snapshot;
  }

  private async capture(
    hook: ReaderHook<TReader, TItem>,
    materializeWorkspace: boolean,
  ): Promise<ReaderContext> {
    const sequence = ++this.captureSequence;
    const warnings: string[] = [];
    const attachment = await this.zotero.resolveAttachment(hook.reader, hook.item);
    this.assertCurrentCapture(sequence);
    if (!attachment) throw new Error("The active Zotero Reader has no PDF attachment");

    const attachmentMetadata = await this.zotero.describeAttachment(attachment);
    this.assertCurrentCapture(sequence);
    const [parentHandle, pdfPath, rawPageStats, selection, indexedPdfText] = await Promise.all([
      this.zotero.resolveParent(attachment).catch((error) => {
        warnings.push(`Parent metadata unavailable: ${errorMessage(error)}`);
        return null;
      }),
      this.zotero.getPdfPath(attachment).catch((error) => {
        warnings.push(`PDF path unavailable: ${errorMessage(error)}`);
        return null;
      }),
      this.zotero.getPageStats(hook.reader).catch((error) => {
        warnings.push(`Reader page state unavailable: ${errorMessage(error)}`);
        return { pageIndex: 0, pageNumber: 1 };
      }),
      this.zotero.getSelection(
        hook.reader,
        hook.selectionAnnotation ?? hook.params?.annotation,
      ).catch((error) => {
        warnings.push(`Reader selection unavailable: ${errorMessage(error)}`);
        return null;
      }),
      this.zotero.getIndexedFullTextReference?.(attachment).catch((error) => {
        warnings.push(`Indexed full-text reference unavailable: ${boundedErrorMessage(error)}`);
        return null;
      }) ?? Promise.resolve(null),
    ]);
    this.assertCurrentCapture(sequence);
    const pageStats = normalizePageStats(rawPageStats);
    const parent = parentHandle
      ? await this.zotero.describeItem(parentHandle).catch((error) => {
          warnings.push(`Parent metadata unavailable: ${errorMessage(error)}`);
          return null;
        })
      : null;
    this.assertCurrentCapture(sequence);

    const page = await this.captureCurrentPage(
      hook.reader,
      attachment,
      pageStats,
      warnings,
    );
    this.assertCurrentCapture(sequence);
    const capturedAt = hook.capturedAt ?? this.options.now().toISOString();
    const pdfText = indexedPdfText
      ? {
        ...indexedPdfText,
        totalPages: indexedPdfText.totalPages ?? pageStats.pageCount,
      }
      : null;
    let context: ReaderContext = {
      schemaVersion: 1,
      capturedAt,
      attachment: attachmentMetadata,
      parent,
      pdfPath,
      page,
      selection: selection ? normalizeSelection(selection, capturedAt) : null,
      fullText: {
        source: "deferred",
        characters: 0,
        totalPages: pageStats.pageCount,
      },
      pdfText,
      warnings,
    };

    if (materializeWorkspace) {
      try {
        const workspace = await this.resolveWorkspaceFiles(context);
        const restoredPdfText = context.pdfText
          ? null
          : await this.restorePdfTextReference(attachmentMetadata, workspace);
        const contextWithWorkspace = {
          ...context,
          pdfText: context.pdfText ?? restoredPdfText,
          workspace,
        };
        const synchronized = await this.enqueueWorkspaceSync(
          sequence,
          contextWithWorkspace,
          workspace,
        );
        if (synchronized) context = contextWithWorkspace;
      } catch (error) {
        context.warnings.push(`Profile workspace unavailable: ${errorMessage(error)}`);
      }
    }

    // A slower capture must never escape to a UI caller after a newer Reader
    // observation has started.
    this.assertCurrentCapture(sequence);
    this.snapshot = { hook, attachmentHandle: attachment, context, fullText: null };
    return context;
  }

  private assertCurrentCapture(sequence: number): void {
    if (sequence !== this.captureSequence) throw new StaleReaderCaptureError();
  }

  private getCachedFullText(
    attachment: TItem,
    metadata: AttachmentMetadata,
    pageStats: ReaderPageStats,
  ): Promise<CachedFullText> {
    const cacheKey = `${metadata.libraryID ?? "0"}-${metadata.key}`;
    const existing = this.fullTextCache.get(cacheKey);
    if (existing) {
      // Map insertion order doubles as a tiny LRU. Full PDFs can be large, so
      // retaining every opened paper for the Zotero process lifetime is not OK.
      this.fullTextCache.delete(cacheKey);
      this.fullTextCache.set(cacheKey, existing);
      return existing;
    }

    const loading = this.loadFullText(attachment, pageStats).catch((error) => {
      if (this.fullTextCache.get(cacheKey) === loading) this.fullTextCache.delete(cacheKey);
      throw error;
    });
    this.fullTextCache.set(cacheKey, loading);
    while (this.fullTextCache.size > this.options.maxFullTextCacheEntries) {
      const oldest = this.fullTextCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.fullTextCache.delete(oldest);
    }
    return loading;
  }

  private async ensureFullText(snapshot: Snapshot<TReader, TItem>): Promise<FullTextResult> {
    if (snapshot.fullText) return snapshot.fullText;
    const cached = await this.getCachedFullText(
      snapshot.attachmentHandle,
      snapshot.context.attachment,
      snapshot.context.page,
    );
    snapshot.fullText = cached.result;
    snapshot.context.fullText = {
      source: cached.result.source,
      characters: cached.result.text.length,
      extractedPages: cached.result.extractedPages,
      totalPages: cached.result.totalPages,
    };
    for (const warning of cached.warnings) {
      if (!snapshot.context.warnings.includes(warning)) snapshot.context.warnings.push(warning);
    }
    return cached.result;
  }

  private async loadFullText(
    attachment: TItem,
    pageStats: ReaderPageStats,
  ): Promise<CachedFullText> {
    const warnings: string[] = [];
    const indexedFullText = await this.zotero.readIndexedFullText(attachment).catch((error) => {
      warnings.push(`Indexed full text unavailable: ${errorMessage(error)}`);
      return null;
    });
    const indexedText = cleanText(indexedFullText?.text);
    // readIndexedFullText only ever reports the cache's own extracted page
    // count, which can never expose a truncated index by itself (Zotero caps
    // indexing at a preference-controlled page limit well below the document's
    // real length). Zotero.Fulltext.getPages() is the authoritative source for
    // both how many pages were indexed and how many the PDF actually has.
    const dbCounts = await this.zotero.getFullTextPageCounts?.(attachment).catch(() => null)
      ?? null;
    const indexedPageCount = indexedText
      ? (dbCounts?.indexedPages ?? indexedFullText?.extractedPages ?? splitPdfPages(indexedText).length)
      : 0;
    const knownPageCount = pageStats.pageCount ?? dbCounts?.totalPages ?? indexedFullText?.totalPages;
    const indexedLooksComplete =
      Boolean(indexedText)
      && (knownPageCount === undefined || indexedPageCount >= knownPageCount);

    if (indexedLooksComplete) {
      return {
        result: {
          text: indexedFullText!.text.replace(/\r\n?/g, "\n").trim(),
          source: "indexed-fulltext",
          extractedPages: indexedFullText?.extractedPages,
          totalPages: knownPageCount,
        },
        warnings,
      };
    }

    const workerFullText = await this.safePdfWorker(attachment, null, warnings);
    if (cleanText(workerFullText?.text)) {
      return {
        result: {
          text: workerFullText!.text.replace(/\r\n?/g, "\n").trim(),
          source: "pdf-worker",
          extractedPages: workerFullText?.extractedPages,
          totalPages: workerFullText?.totalPages ?? knownPageCount,
        },
        warnings,
      };
    }
    if (indexedText) {
      warnings.push(
        `Indexed full text contains ${indexedPageCount} of ${knownPageCount ?? "an unknown number of"} pages`,
      );
      return {
        result: {
          text: indexedFullText!.text.replace(/\r\n?/g, "\n").trim(),
          source: "indexed-fulltext",
          extractedPages: indexedPageCount,
          totalPages: knownPageCount,
        },
        warnings,
      };
    }
    return {
      result: {
        text: "",
        source: "none",
        totalPages: knownPageCount,
      },
      warnings,
    };
  }

  private async captureCurrentPage(
    reader: TReader,
    attachment: TItem,
    stats: ReaderPageStats,
    warnings: string[],
  ): Promise<PageTextResult> {
    let text = "";
    let source: TextSource = "none";
    try {
      text = cleanText(await this.zotero.extractPdfJsPage(reader, stats.pageIndex));
      if (text) source = "pdfjs";
    } catch (error) {
      warnings.push(`PDF.js page extraction failed: ${errorMessage(error)}`);
    }

    if (!text) {
      const indexed = await this.zotero.readIndexedFullText(attachment).catch((error) => {
        warnings.push(`Indexed full text unavailable: ${boundedErrorMessage(error)}`);
        return null;
      });
      const indexedPage = splitPdfPages(indexed?.text ?? "")[stats.pageIndex];
      if (cleanText(indexedPage)) {
        text = cleanText(indexedPage);
        source = "indexed-fulltext";
      }
    }

    const pageWarnings = text
      ? []
      : [`No text could be extracted for PDF page ${stats.pageNumber}`];
    return { ...stats, text, source, warnings: pageWarnings };
  }

  private async safePdfWorker(
    attachment: TItem,
    pageIndexes: readonly number[] | null,
    warnings: string[],
  ): Promise<PdfWorkerTextResult | null> {
    try {
      return await this.zotero.readPdfWorkerText(attachment, pageIndexes);
    } catch (error) {
      warnings.push(`PDF worker extraction failed: ${boundedErrorMessage(error)}`);
      return null;
    }
  }

  private async resolveWorkspaceFiles(context: ReaderContext): Promise<WorkspaceFiles> {
    const profileRoot = await this.host.getProfileWorkspaceRoot();
    const paperIdentity = [context.attachment.libraryID, context.attachment.key]
      .filter((value) => value !== undefined && value !== null && value !== "")
      .map(safeSegment)
      .join("-");
    const root = this.host.joinPath(
      profileRoot,
      safeSegment(this.options.workspaceFolderName),
      paperIdentity || safeSegment(context.attachment.key),
    );
    const files: WorkspaceFiles = {
      root,
      context: this.host.joinPath(root, "context.json"),
      currentPage: this.host.joinPath(root, "current-page.md"),
      currentSelection: this.host.joinPath(root, "current-selection.md"),
      pdfText: this.host.joinPath(root, "current-pdf-text.txt"),
      agents: this.host.joinPath(root, "AGENTS.md"),
      claude: this.host.joinPath(root, "CLAUDE.md"),
    };
    for (const path of Object.values(files)) {
      if (path !== root && !isPathInside(root, path)) {
        throw new Error("Profile workspace path escaped its paper directory");
      }
    }
    return files;
  }

  private enqueueWorkspaceSync(
    sequence: number,
    context: ReaderContext,
    files: WorkspaceFiles,
  ): Promise<boolean> {
    const synchronize = async (): Promise<boolean> => {
      // If a later Reader hook completed its observation first, its workspace
      // must remain authoritative and this stale capture is discarded.
      if (sequence !== this.captureSequence) return false;
      await this.materializeWorkspace(context, files);
      return true;
    };
    const queued = this.profileSyncTail.then(synchronize, synchronize);
    this.profileSyncTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private async materializeWorkspace(
    context: ReaderContext,
    files: WorkspaceFiles,
  ): Promise<void> {
    await this.host.ensureProfileDirectory(files.root);
    const libraryKey = snapshotLibraryKey(context.attachment.libraryID);
    const librarySnapshot = libraryKey
      ? this.librarySnapshots.get(libraryKey)?.reference ?? null
      : null;
    const pageMarkdown = renderCurrentPageMarkdown(
      context,
      this.options.maxWorkspaceTextCharacters,
    );
    const selectionMarkdown = renderSelectionMarkdown(
      context,
      this.options.maxWorkspaceTextCharacters,
    );
    const writes = [
      this.host.replaceProfileText(
        files.context,
        `${JSON.stringify(
          renderWorkspaceContext(context, this.options.libraryRoot, librarySnapshot),
          null,
          2,
        )}\n`,
      ),
      this.host.replaceProfileText(files.currentPage, pageMarkdown),
      this.host.replaceProfileText(files.currentSelection, selectionMarkdown),
    ];
    const needsStaticFiles = !this.materializedStaticWorkspaces.has(files.root);
    if (needsStaticFiles) {
      const agentInstructions = renderAgentInstructions(context);
      writes.push(
        this.host.replaceProfileText(files.agents, agentInstructions),
        this.host.replaceProfileText(files.claude, agentInstructions),
      );
    }
    await Promise.all(writes);
    if (needsStaticFiles) {
      this.materializedStaticWorkspaces.delete(files.root);
      this.materializedStaticWorkspaces.add(files.root);
      while (this.materializedStaticWorkspaces.size > this.options.maxWorkspaceCacheEntries) {
        const oldest = this.materializedStaticWorkspaces.values().next().value as string | undefined;
        if (oldest === undefined) break;
        this.materializedStaticWorkspaces.delete(oldest);
      }
    }
    await this.pruneWorkspaceCache(context, files);
  }

  private async buildLibrarySnapshot(
    libraryID: number | string,
    force: boolean,
  ): Promise<ZotkitLibrarySnapshotReference | null> {
    const build = this.zotero.buildZotkitLibrarySnapshot;
    if (!build) return null;
    const key = snapshotLibraryKey(libraryID)!;
    const nowMs = this.options.now().getTime();
    const cached = this.librarySnapshots.get(key);
    if (!force && cached && nowMs < cached.expiresAt) return cached.reference;
    const pending = this.librarySnapshotBuilds.get(key);
    if (pending) return pending;

    const promise = (async (): Promise<ZotkitLibrarySnapshotReference | null> => {
      try {
        const snapshot = await build.call(this.zotero, libraryID, {
          maxItems: this.options.maxLibrarySnapshotItems,
          maxCollections: this.options.maxLibrarySnapshotCollections,
        });
        const profileRoot = await this.host.getProfileWorkspaceRoot();
        const directory = this.host.joinPath(profileRoot, "library-snapshots");
        const path = this.host.joinPath(directory, `${safeSegment(key)}.jsonl`);
        await this.host.ensureProfileDirectory(directory);
        const rendered = renderZotkitLibrarySnapshot(
          snapshot,
          this.options.maxLibrarySnapshotCharacters,
        );
        await this.host.replaceProfileText(path, rendered.text);
        const reference: ZotkitLibrarySnapshotReference = {
          schemaVersion: 1,
          path,
          libraryID,
          generatedAt: snapshot.generatedAt,
          itemCount: rendered.itemCount,
          collectionCount: rendered.collectionCount,
          tagCount: rendered.tagCount,
          complete: rendered.complete,
        };
        this.librarySnapshots.set(key, {
          reference,
          snapshot,
          expiresAt: nowMs + this.options.librarySnapshotTtlMs,
        });
        const active = this.snapshot?.context;
        if (active && snapshotLibraryKey(active.attachment.libraryID) === key) {
          active.warnings = active.warnings.filter(
            (warning) => !warning.startsWith(ZOTKIT_SNAPSHOT_WARNING_PREFIX),
          );
        }
        return reference;
      }
      catch (error) {
        const active = this.snapshot?.context;
        if (active && snapshotLibraryKey(active.attachment.libraryID) === key) {
          const warning = `${ZOTKIT_SNAPSHOT_WARNING_PREFIX} ${boundedErrorMessage(error)}`;
          if (!active.warnings.includes(warning)) active.warnings.push(warning);
        }
        return cached?.reference ?? null;
      }
      finally {
        this.librarySnapshotBuilds.delete(key);
      }
    })();
    this.librarySnapshotBuilds.set(key, promise);
    return promise;
  }

  private async ensureZotkitLibraryData(force = false): Promise<ZotkitLibrarySnapshot> {
    const active = await this.ensureSnapshot();
    const libraryID = active.context.attachment.libraryID;
    const key = snapshotLibraryKey(libraryID);
    if (!key || libraryID === undefined) {
      throw new Error("The active Zotero attachment does not identify a library");
    }
    const reference = await this.buildLibrarySnapshot(libraryID, force);
    const cached = this.librarySnapshots.get(key);
    if (!reference || !cached) {
      throw new Error(
        "Built-in Zotkit library metadata is unavailable in this Zotero runtime",
      );
    }
    return cached.snapshot;
  }

  private async pruneWorkspaceCache(
    context: ReaderContext,
    files: WorkspaceFiles,
  ): Promise<void> {
    const nowMs = this.options.now().getTime();
    if (
      this.lastWorkspacePruneAt !== null
      && nowMs - this.lastWorkspacePruneAt < this.options.workspaceCachePruneIntervalMs
    ) {
      return;
    }
    this.lastWorkspacePruneAt = nowMs;
    try {
      const profileRoot = await this.host.getProfileWorkspaceRoot();
      const cacheRoot = this.host.joinPath(
        profileRoot,
        safeSegment(this.options.workspaceFolderName),
      );
      const result = await this.host.pruneProfileWorkspaceCache(cacheRoot, {
        keepDirectory: files.root,
        maxEntries: this.options.maxWorkspaceCacheEntries,
        maxAgeMs: this.options.workspaceCacheMaxAgeMs,
        nowMs,
      });
      for (const removed of result.removed) {
        this.materializedStaticWorkspaces.delete(removed);
        for (const [key, reference] of this.pdfTextReferences) {
          if (isPathInside(removed, reference.path)) this.pdfTextReferences.delete(key);
        }
      }
    } catch (error) {
      context.warnings.push(`Profile workspace cleanup unavailable: ${errorMessage(error)}`);
    }
  }

  private requireQuery(value: unknown): string {
    const query = cleanText(value);
    if (!query) throw new TypeError("query must be a non-empty string");
    if (query.length > 512) throw new TypeError("query must not exceed 512 characters");
    return query;
  }

  private parseLimit(value: unknown): number {
    if (value === undefined) return this.options.maxSearchResults;
    return clamp(positiveInteger(value), 1, 100);
  }

  private parseListLimit(value: unknown, maximum: number, fallback: number): number {
    if (value === undefined) return clamp(fallback, 1, maximum);
    return clamp(positiveInteger(value), 1, maximum);
  }
}

function samePageStats(left: ReaderPageStats, right: ReaderPageStats): boolean {
  return left.pageIndex === right.pageIndex
    && left.pageNumber === right.pageNumber
    && left.pageCount === right.pageCount
    && left.pageLabel === right.pageLabel;
}

export function searchPageText(text: string, query: string, limit = 20): SearchMatch[] {
  const needle = cleanText(query);
  if (!needle || !text || limit <= 0) return [];
  const pages = splitPdfPages(text);
  const lowerNeedle = needle.toLocaleLowerCase();
  const matches: SearchMatch[] = [];
  for (let pageIndex = 0; pageIndex < pages.length && matches.length < limit; pageIndex += 1) {
    const page = pages[pageIndex]!;
    const lowerPage = page.toLocaleLowerCase();
    let cursor = 0;
    while (matches.length < limit) {
      const index = lowerPage.indexOf(lowerNeedle, cursor);
      if (index < 0) break;
      const start = Math.max(0, index - 160);
      const end = Math.min(page.length, index + needle.length + 220);
      const prefix = start > 0 ? "…" : "";
      const suffix = end < page.length ? "…" : "";
      matches.push({
        pageIndex,
        pageNumber: pageIndex + 1,
        snippet: `${prefix}${page.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`,
        matchStart: index,
        matchLength: needle.length,
      });
      cursor = index + Math.max(needle.length, 1);
    }
  }
  return matches;
}

function renderWorkspaceContext(
  context: ReaderContext,
  libraryRoot: string | null,
  zotkitLibrarySnapshot: ZotkitLibrarySnapshotReference | null = null,
): Record<string, unknown> {
  // Page and selection text live in their two bounded sibling files. Keeping
  // only metadata here avoids storing the same passage two or three times.
  const { text: _pageText, ...page } = context.page;
  const selection = context.selection
    ? {
      ...context.selection,
      text: undefined,
      comment: undefined,
      position: undefined,
      textCharacters: context.selection.text.length,
      hasComment: Boolean(cleanText(context.selection.comment)),
    }
    : null;
  const attachment = boundedWorkspaceItem(context.attachment, true);
  const parent = context.parent ? boundedWorkspaceItem(context.parent, false) : null;
  return {
    schemaVersion: context.schemaVersion,
    capturedAt: context.capturedAt,
    attachment,
    parent,
    pdfPath: context.pdfPath,
    page,
    selection,
    fullText: context.fullText,
    pdfText: context.pdfText,
    workspace: context.workspace,
    libraryRoot,
    zotkitLibrarySnapshot,
    warnings: context.warnings.slice(0, 20).map((warning) => truncateMiddle(warning, 1_000)),
  };
}

function boundedWorkspaceItem(
  item: ZoteroItemMetadata | AttachmentMetadata,
  attachment: boolean,
): Record<string, unknown> {
  const boundedID = (value: number | string | undefined): number | string | undefined =>
    typeof value === "number" ? value : boundedSnapshotString(value, 64) || undefined;
  const result: Record<string, unknown> = {
    id: boundedID(item.id),
    key: boundedSnapshotString(item.key, 64),
    libraryID: boundedID(item.libraryID),
    itemType: boundedSnapshotString(item.itemType, 128) || undefined,
    title: boundedSnapshotString(item.title, 2_048) || undefined,
    creators: item.creators.slice(0, 16).map((creator) => ({
      firstName: boundedSnapshotString(creator.firstName, 128) || undefined,
      lastName: boundedSnapshotString(creator.lastName, 128) || undefined,
      name: boundedSnapshotString(creator.name, 256) || undefined,
      creatorType: boundedSnapshotString(creator.creatorType, 64) || undefined,
    })),
    date: boundedSnapshotString(item.date, 256) || undefined,
    year: boundedSnapshotString(item.year, 64) || undefined,
    doi: boundedSnapshotString(item.doi, 1_024) || undefined,
    url: boundedSnapshotString(item.url, 4_096) || undefined,
    publicationTitle: boundedSnapshotString(item.publicationTitle, 2_048) || undefined,
    abstractNote: boundedSnapshotString(item.abstractNote, 4_096) || undefined,
    tags: item.tags.slice(0, 64)
      .map((tag) => boundedSnapshotString(tag, 128))
      .filter(Boolean),
  };
  if (attachment) {
    const value = item as AttachmentMetadata;
    result.parentID = boundedID(value.parentID);
    result.filename = boundedSnapshotString(value.filename, 2_048) || undefined;
    result.contentType = boundedSnapshotString(value.contentType, 256) || undefined;
  }
  return result;
}

function snapshotLibraryKey(libraryID: number | string | undefined): string | null {
  if (typeof libraryID === "number" && Number.isFinite(libraryID)) return String(libraryID);
  const value = cleanText(libraryID);
  return value || null;
}

function boundedSnapshotString(value: unknown, maximum: number): string {
  return truncateTextEnd(cleanText(value), maximum).text;
}

function normalizedSnapshotItem(item: ZotkitLibraryItem): ZotkitLibraryItem {
  return {
    _topLevel: item._topLevel,
    key: boundedSnapshotString(item.key, 64),
    itemType: boundedSnapshotString(item.itemType, 128),
    title: boundedSnapshotString(item.title, 2_048),
    creators: item.creators.slice(0, 32).map((creator) => ({
      firstName: boundedSnapshotString(creator.firstName, 256) || undefined,
      lastName: boundedSnapshotString(creator.lastName, 256) || undefined,
      name: boundedSnapshotString(creator.name, 512) || undefined,
      creatorType: boundedSnapshotString(creator.creatorType, 64) || undefined,
    })),
    date: boundedSnapshotString(item.date, 256),
    publicationTitle: boundedSnapshotString(item.publicationTitle, 2_048),
    DOI: boundedSnapshotString(item.DOI, 1_024),
    url: boundedSnapshotString(item.url, 4_096),
    abstractNote: boundedSnapshotString(item.abstractNote, 4_096),
    language: boundedSnapshotString(item.language, 256),
    tags: item.tags.slice(0, 128).map((tag) => boundedSnapshotString(tag, 256)).filter(Boolean),
    collections: item.collections
      .slice(0, 64)
      .map((name) => boundedSnapshotString(name, 512))
      .filter(Boolean),
    collectionKeys: item.collectionKeys
      .slice(0, 64)
      .map((key) => boundedSnapshotString(key, 64))
      .filter(Boolean),
    version: typeof item.version === "number" && Number.isFinite(item.version)
      ? item.version
      : null,
    parentItem: boundedSnapshotString(item.parentItem, 64) || undefined,
    filename: boundedSnapshotString(item.filename, 2_048) || undefined,
    contentType: boundedSnapshotString(item.contentType, 256) || undefined,
  };
}

function snapshotItemNeedsTruncation(item: ZotkitLibraryItem): boolean {
  return item.creators.length > 32
    || item.creators.some((creator) =>
      cleanText(creator.firstName).length > 256
      || cleanText(creator.lastName).length > 256
      || cleanText(creator.name).length > 512
      || cleanText(creator.creatorType).length > 64)
    || cleanText(item.key).length > 64
    || cleanText(item.itemType).length > 128
    || cleanText(item.title).length > 2_048
    || cleanText(item.date).length > 256
    || cleanText(item.publicationTitle).length > 2_048
    || cleanText(item.DOI).length > 1_024
    || cleanText(item.url).length > 4_096
    || cleanText(item.abstractNote).length > 4_096
    || cleanText(item.language).length > 256
    || item.tags.length > 128
    || item.tags.some((tag) => cleanText(tag).length > 256)
    || item.collections.length > 64
    || item.collections.some((name) => cleanText(name).length > 512)
    || item.collectionKeys.length > 64
    || item.collectionKeys.some((key) => cleanText(key).length > 64)
    || cleanText(item.parentItem).length > 64
    || cleanText(item.filename).length > 2_048
    || cleanText(item.contentType).length > 256;
}

export function renderZotkitLibrarySnapshot(
  snapshot: ZotkitLibrarySnapshot,
  maximumBytes = 16_000_000,
): {
  text: string;
  itemCount: number;
  collectionCount: number;
  tagCount: number;
  complete: boolean;
} {
  const encoder = new TextEncoder();
  const maximumRecordBytes = 900_000;
  const headerReserveBytes = 4_096;
  const recordsBudgetBytes = Math.max(0, maximumBytes - headerReserveBytes);
  const records: string[] = [];
  let bytes = 0;
  let complete = snapshot.complete;
  const append = (record: unknown): boolean => {
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = encoder.encode(line).byteLength;
    if (lineBytes > maximumRecordBytes || bytes + lineBytes > recordsBudgetBytes) {
      complete = false;
      return false;
    }
    records.push(line);
    bytes += lineBytes;
    return true;
  };

  let collectionCount = 0;
  for (const collection of snapshot.collections) {
    if (
      cleanText(collection.key).length > 64
      || cleanText(collection.name).length > 1_024
      || cleanText(collection.parentKey).length > 64
      || cleanText(collection.path).length > 4_096
    ) complete = false;
    if (!append({
      kind: "collection",
      value: {
        key: boundedSnapshotString(collection.key, 64),
        name: boundedSnapshotString(collection.name, 1_024),
        parentKey: collection.parentKey
          ? boundedSnapshotString(collection.parentKey, 64)
          : null,
        path: boundedSnapshotString(collection.path, 4_096),
        version: typeof collection.version === "number" && Number.isFinite(collection.version)
          ? collection.version
          : null,
      },
    })) break;
    collectionCount += 1;
  }

  let tagCount = 0;
  for (const tag of snapshot.tags) {
    if (cleanText(tag.tag).length > 512) complete = false;
    if (!append({
      kind: "tag",
      value: {
        tag: boundedSnapshotString(tag.tag, 512),
        count: Math.max(0, Math.trunc(tag.count)),
      },
    })) break;
    tagCount += 1;
  }

  let itemCount = 0;
  for (const item of snapshot.items) {
    if (snapshotItemNeedsTruncation(item)) complete = false;
    const normalized = normalizedSnapshotItem(item);
    const { _topLevel, ...value } = normalized;
    if (!append({ kind: "item", topLevel: _topLevel, value })) break;
    itemCount += 1;
  }
  if (
    collectionCount < snapshot.collections.length
    || tagCount < snapshot.tags.length
    || itemCount < snapshot.items.length
  ) {
    complete = false;
  }

  const header = JSON.stringify({
    kind: "meta",
    schemaVersion: 1,
    generatedAt: snapshot.generatedAt,
    libraryID: snapshot.libraryID,
    complete,
    itemCount,
    collectionCount,
    tagCount,
  });
  return {
    text: `${header}\n${records.join("")}`,
    itemCount,
    collectionCount,
    tagCount,
    complete,
  };
}

export function renderCurrentPageMarkdown(
  context: ReaderContext,
  maximumTextCharacters = Number.MAX_SAFE_INTEGER,
): string {
  const title = context.parent?.title ?? context.attachment.title ?? context.attachment.filename;
  const bounded = truncateTextEnd(context.page.text, maximumTextCharacters);
  return [
    "# Current Zotero PDF Page",
    "",
    `- Paper: ${formatMarkdownValue(title)}`,
    `- Attachment key: ${formatMarkdownValue(context.attachment.key)}`,
    `- PDF page: ${context.page.pageNumber}${context.page.pageCount ? ` of ${context.page.pageCount}` : ""}`,
    `- Page label: ${formatMarkdownValue(context.page.pageLabel)}`,
    `- Extraction source: ${context.page.source}`,
    `- Captured at: ${context.capturedAt}`,
    "",
    "## Text",
    "",
    bounded.text || "_No extractable text is available for this page._",
    ...(bounded.truncated
      ? ["", `_Workspace cache truncated this page to ${maximumTextCharacters} characters; use the live page tool for the current value._`]
      : []),
    "",
  ].join("\n");
}

export function renderSelectionMarkdown(
  context: ReaderContext,
  maximumTextCharacters = Number.MAX_SAFE_INTEGER,
): string {
  const selection = context.selection;
  if (!selection) {
    return [
      "# Current Zotero Selection",
      "",
      "_No text is currently selected in the Zotero Reader._",
      "",
    ].join("\n");
  }
  const bounded = truncateTextEnd(selection.text, maximumTextCharacters);
  const boundedComment = truncateTextEnd(selection.comment ?? "", Math.min(8_192, maximumTextCharacters));
  return [
    "# Current Zotero Selection",
    "",
    `- PDF page: ${selection.pageNumber ?? context.page.pageNumber}`,
    `- Annotation key: ${formatMarkdownValue(selection.annotationKey)}`,
    `- Captured at: ${selection.capturedAt}`,
    "",
    "## Selected text",
    "",
    bounded.text || "_The selection contains no extractable text._",
    ...(bounded.truncated
      ? ["", `_Workspace cache truncated this selection to ${maximumTextCharacters} characters; use the live selection tool for the current value._`]
      : []),
    ...(boundedComment.text
      ? ["", "## Annotation comment", "", boundedComment.text]
      : []),
    "",
  ].join("\n");
}

export function renderAgentInstructions(context: ReaderContext): string {
  const title = context.parent?.title ?? context.attachment.title ?? context.attachment.filename;
  return [
    "# Zotero Reader Workspace",
    "",
    `This workspace mirrors the read-only context for **${formatMarkdownValue(title)}**.`,
    "It is generated inside the Zotkit plugin profile and is not the Zotero data directory.",
    "",
    "## Context files",
    "",
    "- `context.json`: attachment, parent item, PDF path, page state, and selection metadata.",
    "- `current-page.md`: text from the page visible when the context was captured.",
    "- `current-selection.md`: the latest text-selection annotation received from the Reader.",
    "- The original PDF is referenced read-only by `pdfPath` in `context.json`; it is never copied or modified.",
    "- The terminal MCP references Zotero's existing full-text index in place. Only when no index reference exists may it keep one bounded fallback as `current-pdf-text.txt` in this private, automatically pruned workspace.",
    "",
    "## Live read-only tools",
    "",
    ...READER_TOOL_NAMES.map((name) => `- \`${name}\``),
    "- Terminal MCP aliases: `get_reader_context`, `search_current_pdf`, and `read_pdf_pages`.",
    "",
    "Before answering references such as “this”, “here”, or “the selected passage”, call the live context or selection tool.",
    "Cite the one-based PDF page number for claims about the paper.",
    "Do not alter the original PDF, Zotero items, collections, attachment paths, links, annotations, or full-text index.",
    "Do not create helper files beside the original PDF or anywhere in Zotero storage.",
    "The external library filename search never reads file contents.",
    "Library PDF content tools require a safe relative path and a unique match to an existing Zotero attachment through public read-only item APIs; they use only Zotero's existing full-text cache or bounded read-only PDFWorker extraction.",
    "If a library PDF is not uniquely associated with a Zotero attachment, report that state and do not use shell or direct file reads as a fallback.",
    "For the active PDF, use `search_current_pdf` and then `read_pdf_pages`; never run `textutil`, `pdftotext`, Python PDF libraries, OCR, or other shell commands as a fallback.",
    "Place any user-requested generated notes in a separate user-approved output location, never in the Zotero library.",
    "",
  ].join("\n");
}

function normalizeSelection(selection: ReaderSelection, fallbackCapturedAt: string): ReaderSelection {
  const pageIndex =
    typeof selection.pageIndex === "number" && Number.isInteger(selection.pageIndex)
      ? Math.max(0, selection.pageIndex)
      : typeof selection.pageNumber === "number" && Number.isInteger(selection.pageNumber)
        ? Math.max(0, selection.pageNumber - 1)
        : undefined;
  return {
    ...selection,
    text: cleanText(selection.text),
    pageIndex,
    pageNumber: pageIndex === undefined ? undefined : pageIndex + 1,
    capturedAt: selection.capturedAt || fallbackCapturedAt,
  };
}

function normalizeAnnotation(annotation: ReaderAnnotation): ReaderAnnotation {
  const pageIndex =
    typeof annotation.pageIndex === "number" && Number.isInteger(annotation.pageIndex)
      ? Math.max(0, annotation.pageIndex)
      : typeof annotation.pageNumber === "number" && Number.isInteger(annotation.pageNumber)
        ? Math.max(0, annotation.pageNumber - 1)
        : undefined;
  return {
    ...annotation,
    key: cleanText(annotation.key),
    text: cleanText(annotation.text) || undefined,
    comment: cleanText(annotation.comment) || undefined,
    pageIndex,
    pageNumber: pageIndex === undefined ? undefined : pageIndex + 1,
  };
}

/** Minimal dynamic shape of the Zotero 9 runtime used by the default adapter. */
export interface Zotero9Runtime {
  Reader?: {
    getByTabID?: (tabID: unknown) => unknown;
  };
  Items?: {
    get?: (id: unknown) => unknown;
    getAsync?: (id: unknown) => Promise<unknown>;
    /** Zotero.DataObjects#getLoaded; reads only the in-memory object cache. */
    getLoaded?: () => unknown[];
    /** Public read-only item enumeration; never saves or mutates an item. */
    getAll?: (
      libraryID: number | string,
      onlyTopLevel?: boolean,
      includeDeleted?: boolean,
      asIDs?: boolean,
    ) => Promise<unknown[]>;
    /**
     * Public bulk loader for lazily loaded item data. Items.getAll() only
     * guarantees primary data, while metadata getters require these types.
     */
    loadDataTypes?: (objects: unknown[], dataTypes?: string[]) => Promise<void>;
  };
  Libraries?: {
    userLibraryID?: number | string;
    getAll?: () => unknown[] | Promise<unknown[]>;
  };
  Collections?: {
    /** Public in-memory collection enumeration; no database writes. */
    getByLibrary?: (
      libraryID: number | string,
      recursive?: boolean,
      includeTrashed?: boolean,
    ) => unknown[] | Promise<unknown[]>;
  };
  Attachments?: {
    BASE_PATH_PLACEHOLDER?: string;
    resolveRelativePath?: (path: string) => string | false;
    getStorageDirectory?: (item: unknown) => unknown;
  };
  Fulltext?: {
    getItemCacheFile?: (item: unknown) => unknown;
    /** Authoritative indexed-vs-total page counts for one item; may be async. */
    getPages?: (itemID: unknown) => unknown;
  };
  FullText?: {
    getItemCacheFile?: (item: unknown) => unknown;
    getPages?: (itemID: unknown) => unknown;
  };
  File?: {
    getContentsAsync?: (path: string, encoding?: string) => Promise<string>;
  };
  PDFWorker?: {
    getFullText?: (
      itemID: number | string,
      maxPages: number | null,
    ) => Promise<PdfWorkerTextResult>;
  };
  getMainWindow?: () => unknown;
}

interface UnknownRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function method(object: unknown, name: string): ((...args: unknown[]) => unknown) | null {
  const candidate = asRecord(object)[name];
  return typeof candidate === "function" ? candidate.bind(object) : null;
}

function property(object: unknown, ...names: string[]): unknown {
  const record = asRecord(object);
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) return record[name];
  }
  return undefined;
}

function stringProperty(object: unknown, ...names: string[]): string | undefined {
  const value = property(object, ...names);
  return value === undefined ? undefined : cleanText(String(value)) || undefined;
}

function numberProperty(object: unknown, ...names: string[]): number | undefined {
  const value = Number(property(object, ...names));
  return Number.isFinite(value) ? value : undefined;
}

/** Coerce a raw (already-extracted) value to a finite number, or undefined. */
function toFiniteNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function safeProperty(object: unknown, ...names: string[]): unknown {
  try {
    return property(object, ...names);
  } catch {
    return undefined;
  }
}

function safeStringProperty(object: unknown, ...names: string[]): string | undefined {
  try {
    return stringProperty(object, ...names);
  } catch {
    return undefined;
  }
}

function safeNumberProperty(object: unknown, ...names: string[]): number | undefined {
  try {
    return numberProperty(object, ...names);
  } catch {
    return undefined;
  }
}

function itemField(item: unknown, field: string): string | undefined {
  try {
    const getter = method(item, "getField");
    const value = getter ? getter(field) : property(item, field);
    return value === undefined || value === null ? undefined : cleanText(String(value)) || undefined;
  } catch {
    return undefined;
  }
}

function parseYear(date: string | undefined): string | undefined {
  return date?.match(/(?:^|\D)(\d{4})(?:\D|$)/)?.[1];
}

function itemIdentity(item: unknown): { id: number | string; key: string } {
  const rawID = property(item, "id", "itemID");
  const rawKey = property(item, "key", "itemKey");
  if ((typeof rawID !== "number" && typeof rawID !== "string") || !rawKey) {
    throw new Error("Zotero item is missing its read-only id/key identity");
  }
  return { id: rawID, key: String(rawKey) };
}

function parseJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return JSON.parse(JSON.stringify(parsed)) as JsonValue;
  } catch {
    return undefined;
  }
}

async function describeZoteroItem(item: unknown): Promise<ZoteroItemMetadata> {
  const identity = itemIdentity(item);
  let creators: CreatorMetadata[] = [];
  try {
    const rawCreators = method(item, "getCreators")?.();
    if (Array.isArray(rawCreators)) {
      creators = rawCreators.map((creator) => ({
        firstName: stringProperty(creator, "firstName"),
        lastName: stringProperty(creator, "lastName"),
        name: stringProperty(creator, "name"),
        creatorType: stringProperty(creator, "creatorType"),
      }));
    }
  } catch {
    creators = [];
  }
  let tags: string[] = [];
  try {
    const rawTags = method(item, "getTags")?.();
    if (Array.isArray(rawTags)) {
      tags = rawTags
        .map((tag) => (typeof tag === "string" ? tag : stringProperty(tag, "tag")))
        .filter((tag): tag is string => Boolean(tag));
    }
  } catch {
    tags = [];
  }
  const date = itemField(item, "date");
  return {
    ...identity,
    libraryID: property(item, "libraryID") as number | string | undefined,
    itemType: stringProperty(item, "itemType") ?? itemField(item, "itemType"),
    title: itemField(item, "title"),
    creators,
    date,
    year: parseYear(date),
    doi: itemField(item, "DOI"),
    url: itemField(item, "url"),
    publicationTitle: itemField(item, "publicationTitle"),
    abstractNote: itemField(item, "abstractNote"),
    tags,
  };
}

function readerPdfWindow(reader: unknown): UnknownRecord {
  const readerRecord = asRecord(reader);
  const internal = asRecord(readerRecord._internalReader);
  const primaryView = asRecord(internal._primaryView);
  return asRecord(primaryView._iframeWindow);
}

function normalizePdfTextContent(content: unknown): string {
  const items = property(content, "items");
  if (!Array.isArray(items)) return "";
  const output: string[] = [];
  for (const raw of items) {
    const item = asRecord(raw);
    if (typeof item.str !== "string") continue;
    output.push(item.str);
    output.push(item.hasEOL ? "\n" : " ");
  }
  return output.join("").replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}

function rawAnnotationToSelection(value: unknown, now: () => Date): ReaderSelection | null {
  const annotation = asRecord(value);
  const text = cleanText(annotation.text ?? annotation.selectedText ?? annotation.value);
  if (!text && !annotation.comment) return null;
  const position = parseJsonValue(annotation.position);
  const pageIndex =
    numberProperty(annotation, "pageIndex")
    ?? numberProperty(asRecord(position), "pageIndex");
  return {
    text,
    pageIndex,
    pageNumber: pageIndex === undefined ? undefined : pageIndex + 1,
    annotationKey: stringProperty(annotation, "id", "key", "annotationKey"),
    annotationType: stringProperty(annotation, "type", "annotationType"),
    color: stringProperty(annotation, "color"),
    comment: stringProperty(annotation, "comment"),
    position,
    capturedAt: now().toISOString(),
  };
}

/**
 * Create the concrete Zotero 9 read adapter. All API access remains behind the
 * interface above, which is why tests can avoid loading Zotero entirely.
 */
export function createZotero9ReadAdapter(
  zotero: Zotero9Runtime,
  environment: {
    readUtf8?: (path: string) => Promise<string>;
    fileExists?: (path: string) => Promise<boolean>;
    now?: () => Date;
  } = {},
): ZoteroReadAdapter<unknown, unknown> {
  const now = environment.now ?? (() => new Date());
  const items = zotero.Items;
  const collections = zotero.Collections;

  const resolveItemByID = async (id: unknown): Promise<unknown | null> => {
    if (id === undefined || id === null) return null;
    if (items?.getAsync) return (await items.getAsync(id)) ?? null;
    return items?.get?.(id) ?? null;
  };

  const loadedAttachmentPath = (item: unknown): string | null => {
    const rawPath = stringProperty(item, "attachmentPath");
    if (!rawPath) return null;
    const basePlaceholder = zotero.Attachments?.BASE_PATH_PLACEHOLDER ?? "attachments:";
    if (rawPath.startsWith(basePlaceholder)) {
      const resolved = zotero.Attachments?.resolveRelativePath?.(rawPath);
      return typeof resolved === "string" && resolved ? resolved : null;
    }
    if (rawPath.startsWith("storage:")) {
      const directory = stringProperty(zotero.Attachments?.getStorageDirectory?.(item), "path");
      const filename = rawPath.slice("storage:".length);
      return directory && filename && !filename.includes("/") && !filename.includes("\\")
        ? `${trimTrailingSlash(directory)}/${filename}`
        : null;
    }
    return rawPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rawPath) ? rawPath : null;
  };

  // Session-memoized per attachment identity: this hot path runs inside
  // capture() on every page turn (800ms debounce) and on most tool calls, but
  // Zotero.Fulltext.getPages() is a DB read, so each attachment should pay
  // for it at most once per session. Trade-off: a full-text index rebuild
  // that happens mid-session (e.g. the user re-indexes the PDF) will not be
  // observed until the plugin/session restarts. That's acceptable here --
  // this is a completeness signal, not the indexed text itself, and a stale
  // "still truncated"/"was complete" read is far cheaper than a DB hit on
  // every debounce tick.
  const fullTextPageCountsMemo = new Map<
    string,
    Promise<{ indexedPages?: number; totalPages?: number } | null>
  >();

  /**
   * Zotero's authoritative indexed-vs-total page counts for one attachment,
   * straight from its full-text index database row. Shared by the public
   * `getFullTextPageCounts` adapter method and `getIndexedFullTextReference`'s
   * own truncation check below -- both consumers share the same memoized
   * promise, so the underlying DB read happens at most once.
   */
  const getFullTextPageCounts = async (
    attachment: unknown,
  ): Promise<{ indexedPages?: number; totalPages?: number } | null> => {
    const { id } = itemIdentity(attachment);
    const key = String(id);
    const cached = fullTextPageCountsMemo.get(key);
    if (cached) return cached;
    const pending = (async () => {
      const fulltext = zotero.Fulltext ?? zotero.FullText;
      const getPages = method(fulltext, "getPages");
      if (!getPages) return null;
      const record = asRecord(await getPages(id));
      const indexedPages = toFiniteNumber(record.indexedPages);
      const totalPages = toFiniteNumber(record.totalPages);
      if (indexedPages === undefined && totalPages === undefined) return null;
      return { indexedPages, totalPages };
    })();
    fullTextPageCountsMemo.set(key, pending);
    return pending;
  };

  return {
    async getActiveReaderHook() {
      const mainWindow = zotero.getMainWindow?.();
      const tabID = property(property(mainWindow, "Zotero_Tabs"), "selectedID");
      const reader = zotero.Reader?.getByTabID?.(tabID);
      return reader ? { reader } : null;
    },

    async resolveAttachment(reader, hookItem) {
      if (hookItem !== undefined && hookItem !== null) {
        if (typeof hookItem !== "object") {
          return resolveItemByID(hookItem);
        }
        const isAttachment = method(hookItem, "isAttachment");
        if (!isAttachment || isAttachment()) return hookItem;
      }
      return resolveItemByID(property(reader, "itemID"));
    },

    async resolveParent(attachment) {
      const directParent = property(attachment, "parentItem");
      if (directParent) return directParent;
      return resolveItemByID(property(attachment, "parentItemID", "parentID"));
    },

    async describeAttachment(attachment) {
      const metadata = await describeZoteroItem(attachment);
      let filename = stringProperty(attachment, "attachmentFilename");
      if (!filename) {
        try {
          const getFilename = method(attachment, "getFilename");
          if (getFilename) filename = cleanText(await getFilename()) || undefined;
        } catch {
          filename = undefined;
        }
      }
      return {
        ...metadata,
        parentID: property(attachment, "parentItemID", "parentID") as
          | number
          | string
          | undefined,
        filename,
        contentType: stringProperty(attachment, "attachmentContentType", "contentType"),
      };
    },

    describeItem: describeZoteroItem,

    async getPdfPath(attachment) {
      const getPath = method(attachment, "getFilePathAsync") ?? method(attachment, "getFilePath");
      if (!getPath) return null;
      const path = await getPath();
      return typeof path === "string" && path ? path : null;
    },

    async getPageStats(reader) {
      const win = readerPdfWindow(reader);
      const application = asRecord(win.PDFViewerApplication);
      const viewer = asRecord(application.pdfViewer);
      const document = asRecord(application.pdfDocument ?? viewer.pdfDocument);
      const internalState = asRecord(property(property(reader, "_internalReader"), "_state"));
      const viewStats = asRecord(internalState.primaryViewStats);
      const currentPageNumber =
        numberProperty(viewer, "currentPageNumber")
        ?? ((numberProperty(viewStats, "pageIndex") ?? 0) + 1);
      const pageCount =
        numberProperty(viewer, "pagesCount", "_pagesCount")
        ?? numberProperty(document, "numPages");
      return normalizePageStats({
        pageIndex: Math.max(0, currentPageNumber - 1),
        pageNumber: Math.max(1, currentPageNumber),
        pageCount,
        pageLabel: stringProperty(viewer, "currentPageLabel"),
      });
    },

    async getSelection(reader, eventAnnotation) {
      const fromEvent = rawAnnotationToSelection(eventAnnotation, now);
      if (fromEvent) return fromEvent;
      const outerWindow = asRecord(property(reader, "_iframeWindow"));
      const wrapped = asRecord(outerWindow.wrappedJSObject);
      const contextParams = asRecord(wrapped.contextMenuParams);
      const fromContextMenu = rawAnnotationToSelection(contextParams.annotation, now);
      if (fromContextMenu) return fromContextMenu;
      const win = readerPdfWindow(reader);
      const selection = method(win, "getSelection")?.();
      const text = cleanText(method(selection, "toString")?.());
      return text ? { text, capturedAt: now().toISOString() } : null;
    },

    async extractPdfJsPage(reader, pageIndex) {
      if (!Number.isInteger(pageIndex) || pageIndex < 0) return null;
      const win = readerPdfWindow(reader);
      const application = asRecord(win.PDFViewerApplication);
      const document = asRecord(application.pdfDocument ?? property(application.pdfViewer, "pdfDocument"));
      const getPage = method(document, "getPage");
      if (!getPage) return null;
      const page = await getPage(pageIndex + 1);
      const getTextContent = method(page, "getTextContent");
      if (!getTextContent) return null;
      return normalizePdfTextContent(await getTextContent({ includeMarkedContent: false }));
    },

    async getIndexedFullTextReference(attachment) {
      const fulltext = zotero.Fulltext ?? zotero.FullText;
      const cacheFile = fulltext?.getItemCacheFile?.(attachment);
      const path = stringProperty(cacheFile, "path")
        ?? (typeof cacheFile === "string" ? cacheFile : undefined);
      if (!path || !path.startsWith("/")) return null;
      if (environment.fileExists && !(await environment.fileExists(path))) return null;
      // A DB read failure here must not sink an otherwise-valid reference:
      // the cache path is confirmed to exist above, so on failure fall back
      // to the pre-page-counts semantics (no dbCounts => truncated stays
      // false) rather than losing the reference entirely.
      const dbCounts = await getFullTextPageCounts(attachment).catch(() => null);
      const truncated = Boolean(
        dbCounts
        && dbCounts.indexedPages !== undefined
        && dbCounts.totalPages !== undefined
        && dbCounts.indexedPages < dbCounts.totalPages,
      );
      return {
        schemaVersion: 1,
        path,
        source: "indexed-fulltext",
        totalPages: dbCounts?.totalPages,
        truncated,
      };
    },

    getFullTextPageCounts,

    async readIndexedFullText(attachment) {
      const fulltext = zotero.Fulltext ?? zotero.FullText;
      const cacheFile = fulltext?.getItemCacheFile?.(attachment);
      const path = stringProperty(cacheFile, "path") ?? (typeof cacheFile === "string" ? cacheFile : undefined);
      if (!path) return null;
      if (environment.fileExists && !(await environment.fileExists(path))) return null;
      let text: string;
      if (environment.readUtf8) {
        text = await environment.readUtf8(path);
      } else if (zotero.File?.getContentsAsync) {
        text = await zotero.File.getContentsAsync(path, "utf-8");
      } else {
        return null;
      }
      if (!cleanText(text)) return null;
      // Zotero's own cache file only ever holds whatever it indexed, so its
      // page count must never be reported as the document's total page count
      // (that fabricated equality is exactly what let a truncated index look
      // "complete" before). `getFullTextPageCounts` is the authoritative source
      // for `totalPages`; callers fall back to their own signals (live reader
      // page count, etc.) when that is unavailable.
      const pages = splitPdfPages(text);
      return { text, extractedPages: pages.length };
    },

    async readPdfWorkerText(attachment, pageIndexes) {
      const worker = zotero.PDFWorker?.getFullText;
      if (!worker) return null;
      const { id } = itemIdentity(attachment);
      const maxPages = pageIndexes?.length
        ? Math.max(...pageIndexes) + 1
        : null;
      const result = await worker(id, maxPages);
      if (!result?.text) return null;
      if (!pageIndexes) return result;
      const pages = splitPdfPages(result.text);
      const selectedPages = pageIndexes.map((pageIndex) => pages[pageIndex] ?? "");
      return {
        ...result,
        text: selectedPages.join("\f"),
        extractedPages: selectedPages.length,
      };
    },

    async findLoadedAttachmentByPath(pdfPath) {
      const normalizedTarget = trimTrailingSlash(pdfPath);
      if (!normalizedTarget || extensionOf(normalizedTarget) !== ".pdf") {
        return { status: "not-associated", attachment: null, candidateCount: 0 };
      }
      const loaded = items?.getLoaded?.();
      const pool = Array.isArray(loaded) ? [...loaded] : [];
      const seen = new Set(pool.map((item) => String(property(item, "id", "itemID") ?? "")));
      // Fast path above covers the active collection. For a true workspace-wide
      // lookup, fall back to Zotero's public read-only Items API across libraries.
      // This loads objects but never calls save(), Search, or Zotero.DB directly.
      if (items?.getAll) {
        let libraries: unknown[] = [];
        try {
          const available = await zotero.Libraries?.getAll?.();
          libraries = Array.isArray(available) ? available : [];
        }
        catch {
          // A disabled group library must not prevent matching the user library.
        }
        const libraryIDs = [
          zotero.Libraries?.userLibraryID,
          ...libraries.map((library) => property(library, "libraryID", "id")),
        ].filter((value, index, values): value is number | string =>
          (typeof value === "number" || typeof value === "string")
          && values.findIndex((candidate) => String(candidate) === String(value)) === index
        );
        for (const libraryID of libraryIDs) {
          let libraryItems: unknown[] = [];
          try {
            const available = await items.getAll(libraryID, false, false, false);
            libraryItems = Array.isArray(available) ? available : [];
          }
          catch {
            continue;
          }
          for (const item of libraryItems) {
            const id = String(property(item, "id", "itemID") ?? "");
            if (id && seen.has(id)) continue;
            if (id) seen.add(id);
            pool.push(item);
          }
        }
      }
      const candidates: unknown[] = [];
      for (const item of pool) {
        if (safeProperty(item, "deleted")) continue;
        const isAttachment = method(item, "isAttachment");
        if (isAttachment && !isAttachment()) continue;
        if (!isAttachment && stringProperty(item, "itemType") !== "attachment") continue;
        const isPdf = method(item, "isPDFAttachment");
        if (
          isPdf
            ? !isPdf()
            : stringProperty(item, "attachmentContentType", "contentType") !== "application/pdf"
              && extensionOf(stringProperty(item, "attachmentFilename") ?? "") !== ".pdf"
        ) {
          continue;
        }
        const candidatePath = loadedAttachmentPath(item);
        if (candidatePath && trimTrailingSlash(candidatePath) === normalizedTarget) {
          candidates.push(item);
        }
      }
      if (candidates.length === 1) {
        return { status: "matched", attachment: candidates[0]!, candidateCount: 1 };
      }
      return {
        status: candidates.length ? "ambiguous" : "not-associated",
        attachment: null,
        candidateCount: candidates.length,
      };
    },

    async listAnnotations(attachment) {
      const getter = method(attachment, "getAnnotations");
      const annotations = getter ? await getter() : [];
      if (!Array.isArray(annotations)) return [];
      return annotations.map((annotation): ReaderAnnotation => {
        const key = stringProperty(annotation, "key", "itemKey", "id") ?? "";
        const rawPosition = property(annotation, "annotationPosition", "position");
        const position = parseJsonValue(rawPosition);
        const positionRecord = asRecord(position);
        const pageIndex =
          numberProperty(annotation, "annotationPageIndex", "pageIndex")
          ?? numberProperty(positionRecord, "pageIndex");
        return {
          key,
          type: stringProperty(annotation, "annotationType", "type"),
          text: stringProperty(annotation, "annotationText", "text"),
          comment: stringProperty(annotation, "annotationComment", "comment"),
          color: stringProperty(annotation, "annotationColor", "color"),
          pageIndex,
          pageNumber: pageIndex === undefined ? undefined : pageIndex + 1,
          pageLabel: stringProperty(annotation, "annotationPageLabel", "pageLabel"),
          position,
          dateAdded: stringProperty(annotation, "dateAdded"),
          dateModified: stringProperty(annotation, "dateModified"),
        };
      });
    },

    async buildZotkitLibrarySnapshot(libraryID, limits) {
      if (!items?.getAll) throw new Error("Zotero Items.getAll is unavailable");
      if (!items.loadDataTypes) {
        throw new Error("Zotero Items.loadDataTypes is unavailable");
      }
      const rawCollections = collections?.getByLibrary
        ? await collections.getByLibrary(libraryID, true, false)
        : [];
      const collectionPool = Array.isArray(rawCollections) ? rawCollections : [];
      const completeCollections = collectionPool.length <= limits.maxCollections;
      let metadataComplete = true;
      const selectedCollections = collectionPool.slice(0, limits.maxCollections);
      const collectionByID = new Map<string, ZotkitLibraryCollection>();
      const collectionByKey = new Map<string, ZotkitLibraryCollection>();
      const parentIDs = new Map<string, string | null>();
      for (const collection of selectedCollections) {
        const sourceKey = stringProperty(collection, "key");
        const sourceName = stringProperty(collection, "name");
        const sourceParentKey = stringProperty(collection, "parentKey");
        if (
          cleanText(sourceKey).length > 64
          || cleanText(sourceName).length > 512
          || cleanText(sourceParentKey).length > 64
        ) metadataComplete = false;
        const rawKey = boundedSnapshotString(sourceKey, 64);
        if (!rawKey) continue;
        const rawID = property(collection, "id", "collectionID");
        const parentID = property(collection, "parentID", "parentCollectionID");
        const parentKey = sourceParentKey ?? null;
        const record: ZotkitLibraryCollection = {
          key: rawKey,
          name: boundedSnapshotString(stringProperty(collection, "name"), 512),
          parentKey: boundedSnapshotString(parentKey, 64) || null,
          path: "",
          version: numberProperty(collection, "version") ?? null,
        };
        if (rawID !== undefined && rawID !== null) {
          collectionByID.set(String(rawID), record);
          parentIDs.set(rawKey, parentID === undefined || parentID === null ? null : String(parentID));
        }
        collectionByKey.set(rawKey, record);
      }
      const collectionPath = (record: ZotkitLibraryCollection, seen = new Set<string>()): string => {
        if (seen.has(record.key)) return record.name || record.key;
        seen.add(record.key);
        const parentKey = record.parentKey
          ?? (parentIDs.get(record.key)
            ? collectionByID.get(parentIDs.get(record.key)!)?.key ?? null
            : null);
        record.parentKey = parentKey;
        const parent = parentKey ? collectionByKey.get(parentKey) : undefined;
        const prefix = parent ? collectionPath(parent, seen) : "";
        const rawPath = prefix ? `${prefix} :: ${record.name}` : record.name;
        if (cleanText(rawPath).length > 4_096) metadataComplete = false;
        return boundedSnapshotString(rawPath, 4_096);
      };
      const collectionRecords = [...collectionByKey.values()];
      for (const collection of collectionRecords) collection.path = collectionPath(collection);
      collectionRecords.sort((left, right) =>
        left.path.localeCompare(right.path, undefined, { sensitivity: "base" })
        || left.key.localeCompare(right.key)
      );

      const rawItems = await items.getAll(libraryID, false, false, false);
      const itemPool = Array.isArray(rawItems) ? rawItems : [];
      const completeItems = itemPool.length <= limits.maxItems;
      const selectedItems = itemPool.slice(0, limits.maxItems);
      const itemRecords: ZotkitLibraryItem[] = [];
      const tagCounts = new Map<string, number>();
      for (let itemIndex = 0; itemIndex < selectedItems.length; itemIndex += 1) {
        if (itemIndex % 250 === 0) {
          if (itemIndex > 0) {
            // Yield between bounded batches so first expansion does not monopolize
            // Zotero's UI thread for a large local library.
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
          // Zotero.Items.getAll() resolves through DataObjects#getAsync(), which
          // loads primaryData only. getField(), getCreators(), getTags(), and
          // getCollections() require these lazy data types and otherwise throw.
          // Load only the bounded batch that is about to be serialized.
          await items.loadDataTypes(
            selectedItems.slice(itemIndex, itemIndex + 250),
            ["creators", "tags", "annotation", "itemData", "collections"],
          );
        }
        const item = selectedItems[itemIndex]!;
        if (property(item, "deleted")) continue;
        let topLevel = false;
        try {
          const check = method(item, "isTopLevelItem");
          topLevel = check
            ? Boolean(check())
            : safeProperty(item, "parentItemID", "parentID") === undefined
              || safeProperty(item, "parentItemID", "parentID") === null;
        }
        catch {
          topLevel = false;
        }
        let metadata: ZoteroItemMetadata;
        try {
          metadata = await describeZoteroItem(item);
        }
        catch {
          continue;
        }
        let collectionIDs: unknown[] = [];
        try {
          const raw = method(item, "getCollections")?.(false);
          collectionIDs = Array.isArray(raw) ? raw : [];
        }
        catch {
          collectionIDs = [];
        }
        if (collectionIDs.length > 64) metadataComplete = false;
        const collectionKeys = collectionIDs
          .slice(0, 64)
          .map((id) => collectionByID.get(String(id))?.key)
          .filter((key): key is string => Boolean(key));
        const collectionNames = collectionKeys
          .map((key) => collectionByKey.get(key)?.name)
          .filter((name): name is string => Boolean(name));
        if (metadata.tags.length > 128) metadataComplete = false;
        const uniqueTags = [...new Set(
          metadata.tags
            .slice(0, 128)
            .map((tag) => boundedSnapshotString(tag, 256))
            .filter(Boolean),
        )];
        if (topLevel) {
          for (const tag of uniqueTags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
        const record: ZotkitLibraryItem = {
          _topLevel: topLevel,
          key: metadata.key,
          itemType: metadata.itemType ?? "",
          title: metadata.title ?? "",
          creators: metadata.creators,
          date: metadata.date ?? "",
          publicationTitle: metadata.publicationTitle ?? "",
          DOI: metadata.doi ?? "",
          url: metadata.url ?? "",
          abstractNote: metadata.abstractNote ?? "",
          language: itemField(item, "language") ?? "",
          tags: uniqueTags,
          collections: collectionNames,
          collectionKeys,
          version: safeNumberProperty(item, "version") ?? null,
          parentItem: safeStringProperty(item, "parentKey") ?? undefined,
          filename: safeStringProperty(item, "attachmentFilename") ?? undefined,
          contentType: safeStringProperty(item, "attachmentContentType", "contentType") ?? undefined,
        };
        if (snapshotItemNeedsTruncation(record)) metadataComplete = false;
        itemRecords.push(normalizedSnapshotItem(record));
      }
      const tags = [...tagCounts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((left, right) => right.count - left.count
          || left.tag.localeCompare(right.tag, undefined, { sensitivity: "base" }));
      return {
        schemaVersion: 1,
        libraryID,
        generatedAt: now().toISOString(),
        complete: completeCollections && completeItems && metadataComplete,
        items: itemRecords,
        collections: collectionRecords,
        tags,
      };
    },
  };
}

export interface GeckoIoRuntime {
  IOUtils: {
    makeDirectory(path: string, options?: {
      createAncestors?: boolean;
      ignoreExisting?: boolean;
      permissions?: number;
    }): Promise<void>;
    writeUTF8(path: string, text: string, options?: { tmpPath?: string }): Promise<void>;
    getChildren(path: string): Promise<string[]>;
    stat(path: string): Promise<{
      type: string;
      size?: number;
      lastModified?: number;
    }>;
    remove?(path: string, options?: {
      ignoreAbsent?: boolean;
      recursive?: boolean;
    }): Promise<void>;
    setPermissions?(path: string, permissions: number, honorUmask?: boolean): Promise<void>;
  };
  PathUtils: {
    profileDir: string;
    join(...parts: string[]): string;
    filename?(path: string): string;
  };
  /** Injectable in tests; Gecko production falls back to nsIFile. */
  PathSecurity?: {
    isSymlink(path: string): MaybePromise<boolean>;
    canonicalPath(path: string): MaybePromise<string>;
  };
}

/**
 * Profile I/O adapter for Zotero's Gecko runtime. Library traversal returns
 * names/stat metadata only and never opens a file.
 */
export function createGeckoProfileAdapter(
  runtime: GeckoIoRuntime,
  options: { pluginDirectoryName?: string } = {},
): ReaderContextHostAdapter {
  const pluginDirectoryName = safeSegment(options.pluginDirectoryName ?? "zoterochat");
  const profileRoot = runtime.PathUtils.join(
    runtime.PathUtils.profileDir,
    pluginDirectoryName,
    "reader-context",
  );

  const parentPath = (path: string): string => {
    const normalized = trimTrailingSlash(path);
    const separator = normalized.lastIndexOf("/");
    return separator <= 0 ? "/" : normalized.slice(0, separator);
  };

  const pathSecurity = runtime.PathSecurity ?? {
    isSymlink(path: string): boolean {
      const file = Components.classes["@mozilla.org/file/local;1"]
        .createInstance(Components.interfaces.nsIFile);
      file.initWithPath(path);
      return file.isSymlink();
    },
    canonicalPath(path: string): string {
      const file = Components.classes["@mozilla.org/file/local;1"]
        .createInstance(Components.interfaces.nsIFile);
      file.initWithPath(path);
      file.normalize();
      return file.path;
    },
  };

  const inspectExistingPath = async (path: string): Promise<{
    exists: boolean;
    type?: string;
    canonical?: string;
    lastModified?: number;
  }> => {
    let symlinkStatus: boolean | null = null;
    try {
      symlinkStatus = await pathSecurity.isSymlink(path);
    } catch {
      // A missing path is handled by stat below. If the path exists but its
      // link status cannot be verified, fail closed.
    }
    if (symlinkStatus) {
      throw new Error(`Refusing to follow symbolic link: ${path}`);
    }
    let stat: Awaited<ReturnType<GeckoIoRuntime["IOUtils"]["stat"]>>;
    try {
      stat = await runtime.IOUtils.stat(path);
    } catch {
      return { exists: false };
    }
    if (symlinkStatus === null) {
      throw new Error(`Unable to verify path safety: ${path}`);
    }
    const canonical = trimTrailingSlash(await pathSecurity.canonicalPath(path));
    return { exists: true, type: stat.type, canonical, lastModified: stat.lastModified };
  };

  let canonicalProfileDirectoryPromise: Promise<string> | null = null;
  const canonicalProfileDirectory = (): Promise<string> => {
    canonicalProfileDirectoryPromise ??= (async () => {
      const inspected = await inspectExistingPath(runtime.PathUtils.profileDir);
      if (!inspected.exists || inspected.type !== "directory" || !inspected.canonical) {
        throw new Error("The Zotero profile directory is unavailable or unsafe");
      }
      return inspected.canonical;
    })();
    return canonicalProfileDirectoryPromise;
  };

  const ensureSafeProfileDirectory = async (path: string): Promise<string> => {
    if (!isPathInside(runtime.PathUtils.profileDir, path)) {
      throw new Error("Refusing to create a directory outside the Zotero profile");
    }
    const profileCanonical = await canonicalProfileDirectory();
    const relative = relativeToRoot(runtime.PathUtils.profileDir, path);
    if (relative === null) throw new Error("Invalid Zotero profile path");
    let current = trimTrailingSlash(runtime.PathUtils.profileDir);
    for (const component of normalizeSlashes(relative).split("/").filter(Boolean)) {
      current = runtime.PathUtils.join(current, component);
      let inspected = await inspectExistingPath(current);
      if (!inspected.exists) {
        try {
          await runtime.IOUtils.makeDirectory(current, {
            createAncestors: false,
            ignoreExisting: false,
            permissions: 0o700,
          });
        } catch {
          // A concurrent creator is acceptable only if the resulting path is
          // still a real directory below the canonical profile directory.
        }
        inspected = await inspectExistingPath(current);
      }
      if (!inspected.exists || inspected.type !== "directory" || !inspected.canonical) {
        throw new Error(`Unsafe ZoteroChat profile directory: ${current}`);
      }
      if (!isPathInside(profileCanonical, inspected.canonical)) {
        throw new Error("ZoteroChat profile directory escaped the canonical Zotero profile");
      }
      if (runtime.IOUtils.setPermissions) {
        await runtime.IOUtils.setPermissions(current, 0o700, false);
      }
    }
    const final = await inspectExistingPath(path);
    if (!final.exists || final.type !== "directory" || !final.canonical) {
      throw new Error("ZoteroChat profile directory could not be verified");
    }
    return final.canonical;
  };

  const assertCanonicalInside = (root: string, candidate: string, message: string): void => {
    if (!isPathInside(root, candidate)) throw new Error(message);
  };

  const managedWorkspaceFileNames = new Set([
    "context.json",
    "current-page.md",
    "current-selection.md",
    "current-pdf-text.txt",
    "AGENTS.md",
    "CLAUDE.md",
    "zotkit-mcp.json",
    "zoterochat-mcp.json",
    // Legacy releases duplicated full PDF text here. Cleanup may reclaim it,
    // but new releases never create it.
    "paper-fulltext.txt",
    ".DS_Store",
  ]);
  const managedWorkspaceFileName = (name: string): boolean => {
    if (managedWorkspaceFileNames.has(name)) return true;
    return name.endsWith(".tmp")
      && managedWorkspaceFileNames.has(name.slice(0, -4));
  };

  return {
    async getProfileWorkspaceRoot() {
      return profileRoot;
    },

    joinPath(...parts) {
      return runtime.PathUtils.join(...parts);
    },

    async ensureProfileDirectory(path) {
      if (!isPathInside(profileRoot, path)) {
        throw new Error("Refusing to create a directory outside the ZoteroChat profile workspace");
      }
      const canonicalRoot = await ensureSafeProfileDirectory(profileRoot);
      const canonicalPath = await ensureSafeProfileDirectory(path);
      assertCanonicalInside(
        canonicalRoot,
        canonicalPath,
        "ZoteroChat profile directory escaped its canonical workspace",
      );
    },

    async replaceProfileText(path, text) {
      if (trimTrailingSlash(path) === trimTrailingSlash(profileRoot) || !isPathInside(profileRoot, path)) {
        throw new Error("Refusing to replace a file outside the ZoteroChat profile workspace");
      }
      const canonicalRoot = await ensureSafeProfileDirectory(profileRoot);
      const canonicalParent = await ensureSafeProfileDirectory(parentPath(path));
      assertCanonicalInside(
        canonicalRoot,
        canonicalParent,
        "ZoteroChat output parent escaped its canonical workspace",
      );
      const existingTarget = await inspectExistingPath(path);
      if (existingTarget.exists) {
        if (existingTarget.type !== "regular" && existingTarget.type !== "file") {
          throw new Error("Refusing to replace a non-regular ZoteroChat profile file");
        }
        assertCanonicalInside(
          canonicalRoot,
          existingTarget.canonical!,
          "ZoteroChat output file escaped its canonical workspace",
        );
      }
      const temporaryPath = `${path}.tmp`;
      const existingTemporary = await inspectExistingPath(temporaryPath);
      if (existingTemporary.exists) {
        if (existingTemporary.type !== "regular" && existingTemporary.type !== "file") {
          throw new Error("Refusing to use an unsafe ZoteroChat temporary file");
        }
        assertCanonicalInside(
          canonicalRoot,
          existingTemporary.canonical!,
          "ZoteroChat temporary file escaped its canonical workspace",
        );
      }
      await runtime.IOUtils.writeUTF8(path, text, { tmpPath: temporaryPath });
      const written = await inspectExistingPath(path);
      if (!written.exists || (written.type !== "regular" && written.type !== "file")) {
        throw new Error("ZoteroChat profile write did not produce a regular file");
      }
      assertCanonicalInside(
        canonicalRoot,
        written.canonical!,
        "ZoteroChat output file escaped its canonical workspace",
      );
      if (runtime.IOUtils.setPermissions) {
        await runtime.IOUtils.setPermissions(path, 0o600, false);
      }
    },

    async profileTextExists(path) {
      if (trimTrailingSlash(path) === trimTrailingSlash(profileRoot)
          || !isPathInside(profileRoot, path)) return false;
      try {
        const canonicalRoot = await canonicalProfileDirectory();
        const inspected = await inspectExistingPath(path);
        return Boolean(
          inspected.exists
          && (inspected.type === "regular" || inspected.type === "file")
          && inspected.canonical
          && isPathInside(canonicalRoot, inspected.canonical),
        );
      } catch {
        return false;
      }
    },

    async pruneProfileWorkspaceCache(cacheRoot, pruneOptions) {
      if (
        trimTrailingSlash(cacheRoot) === trimTrailingSlash(profileRoot)
        || !isPathInside(profileRoot, cacheRoot)
      ) {
        throw new Error("Refusing to prune outside a paper cache below the ZoteroChat profile");
      }
      if (!isPathInside(cacheRoot, pruneOptions.keepDirectory)) {
        throw new Error("The retained workspace is outside the requested paper cache");
      }
      const canonicalCacheRoot = await ensureSafeProfileDirectory(cacheRoot);
      const children = await runtime.IOUtils.getChildren(cacheRoot).catch(() => []);
      const skipped: string[] = [];
      const candidates: Array<{
        path: string;
        canonical: string;
        lastModified: number;
      }> = [];
      for (const path of children) {
        const relative = relativeToRoot(cacheRoot, path);
        if (!relative || relative.includes("/")) {
          skipped.push(path);
          continue;
        }
        let inspected: Awaited<ReturnType<typeof inspectExistingPath>>;
        try {
          inspected = await inspectExistingPath(path);
        } catch {
          skipped.push(path);
          continue;
        }
        if (
          !inspected.exists
          || inspected.type !== "directory"
          || !inspected.canonical
          || !isPathInside(canonicalCacheRoot, inspected.canonical)
        ) {
          skipped.push(path);
          continue;
        }
        // A valid context.json is the ownership marker. Directories without it
        // may contain user-created material and are never deleted.
        const markerPath = runtime.PathUtils.join(path, "context.json");
        let marker: Awaited<ReturnType<typeof inspectExistingPath>>;
        try {
          marker = await inspectExistingPath(markerPath);
        } catch {
          skipped.push(path);
          continue;
        }
        if (
          !marker.exists
          || (marker.type !== "regular" && marker.type !== "file")
          || !marker.canonical
          || !isPathInside(inspected.canonical, marker.canonical)
        ) {
          skipped.push(path);
          continue;
        }
        const modified = marker.lastModified ?? inspected.lastModified;
        candidates.push({
          path,
          canonical: inspected.canonical,
          lastModified:
            typeof modified === "number" && Number.isFinite(modified) && modified > 0
              ? modified
              : pruneOptions.nowMs,
        });
      }

      const keep = trimTrailingSlash(pruneOptions.keepDirectory);
      const removal = new Set<string>();
      for (const candidate of candidates) {
        if (
          trimTrailingSlash(candidate.path) !== keep
          && pruneOptions.nowMs - candidate.lastModified > pruneOptions.maxAgeMs
        ) {
          removal.add(candidate.path);
        }
      }
      const survivors = candidates
        .filter((candidate) => !removal.has(candidate.path))
        .sort((left, right) => left.lastModified - right.lastModified);
      let excess = Math.max(0, survivors.length - Math.max(1, pruneOptions.maxEntries));
      for (const candidate of survivors) {
        if (!excess) break;
        if (trimTrailingSlash(candidate.path) === keep) continue;
        removal.add(candidate.path);
        excess -= 1;
      }

      const removed: string[] = [];
      const removedFiles: string[] = [];
      if (runtime.IOUtils.remove) {
        for (const candidate of candidates) {
          const legacyPath = runtime.PathUtils.join(candidate.path, "paper-fulltext.txt");
          try {
            const legacy = await inspectExistingPath(legacyPath);
            if (
              legacy.exists
              && (legacy.type === "regular" || legacy.type === "file")
              && legacy.canonical
              && isPathInside(candidate.canonical, legacy.canonical)
            ) {
              await runtime.IOUtils.remove(legacyPath, { ignoreAbsent: true });
              removedFiles.push(legacyPath);
            }
          } catch {
            // A symlink or unverifiable legacy path is preserved and causes no
            // broader cleanup action.
            skipped.push(legacyPath);
          }
        }
      }
      for (const candidate of candidates) {
        if (!removal.has(candidate.path)) continue;
        if (!runtime.IOUtils.remove) {
          skipped.push(candidate.path);
          continue;
        }
        try {
          // Revalidate immediately before deletion and only remove the fixed
          // set of files generated by ZoteroChat. Unknown content preserves
          // the whole directory instead of risking user data.
          const live = await inspectExistingPath(candidate.path);
          if (
            !live.exists
            || live.type !== "directory"
            || live.canonical !== candidate.canonical
            || !isPathInside(canonicalCacheRoot, live.canonical)
          ) {
            skipped.push(candidate.path);
            continue;
          }
          const files = await runtime.IOUtils.getChildren(candidate.path);
          const verifiedFiles: string[] = [];
          let safe = true;
          for (const filePath of files) {
            const name = relativeToRoot(candidate.path, filePath);
            if (!name || name.includes("/") || !managedWorkspaceFileName(name)) {
              safe = false;
              break;
            }
            const file = await inspectExistingPath(filePath);
            if (
              !file.exists
              || (file.type !== "regular" && file.type !== "file")
              || !file.canonical
              || !isPathInside(candidate.canonical, file.canonical)
            ) {
              safe = false;
              break;
            }
            verifiedFiles.push(filePath);
          }
          if (!safe) {
            skipped.push(candidate.path);
            continue;
          }
          for (const filePath of verifiedFiles) {
            await runtime.IOUtils.remove(filePath, { ignoreAbsent: true });
          }
          // Non-recursive removal can succeed only when no raced/unknown file
          // appeared after verification.
          await runtime.IOUtils.remove(candidate.path, { ignoreAbsent: true });
          const remains = await inspectExistingPath(candidate.path);
          if (remains.exists) {
            skipped.push(candidate.path);
          } else {
            removed.push(candidate.path);
          }
        } catch {
          skipped.push(candidate.path);
        }
      }
      return { removed, removedFiles, skipped };
    },

    async resolveLibraryPdfPath(configuredRoot, relativePath) {
      const normalizedRelativePath = normalizeLibraryRelativePdfPath(relativePath);
      const root = trimTrailingSlash(configuredRoot);
      if (!root) throw new Error("The configured library root is empty");
      const inspectedRoot = await inspectExistingPath(root);
      if (!inspectedRoot.exists || inspectedRoot.type !== "directory" || !inspectedRoot.canonical) {
        throw new Error("The configured library root is unavailable or unsafe");
      }
      const canonicalRoot = inspectedRoot.canonical;
      let current = root;
      const components = normalizedRelativePath.split("/");
      for (let index = 0; index < components.length; index += 1) {
        current = runtime.PathUtils.join(current, components[index]!);
        const inspected = await inspectExistingPath(current);
        if (!inspected.exists || !inspected.canonical) return null;
        if (!isPathInside(canonicalRoot, inspected.canonical)) {
          throw new Error("Library PDF path escaped the canonical configured root");
        }
        const final = index === components.length - 1;
        if (!final && inspected.type !== "directory") return null;
        if (
          final
          && inspected.type !== "regular"
          && inspected.type !== "file"
        ) {
          return null;
        }
        if (final) {
          const name = runtime.PathUtils.filename?.(inspected.canonical)
            ?? normalizeSlashes(inspected.canonical).split("/").pop()
            ?? components[index]!;
          return {
            name,
            path: inspected.canonical,
            relativePath: normalizedRelativePath,
          };
        }
      }
      return null;
    },

    async scanLibraryFileNames(configuredRoot, scanOptions) {
      const root = trimTrailingSlash(configuredRoot);
      if (!root) throw new Error("The configured library root is empty");
      const inspectedRoot = await inspectExistingPath(root);
      if (!inspectedRoot.exists || inspectedRoot.type !== "directory" || !inspectedRoot.canonical) {
        throw new Error("The configured library root is unavailable or unsafe");
      }
      const canonicalRoot = inspectedRoot.canonical;
      const files: LibraryFileEntry[] = [];
      const queue: Array<{ path: string; canonical: string; depth: number }> = [
        { path: root, canonical: canonicalRoot, depth: 0 },
      ];
      while (queue.length && files.length < scanOptions.maxFiles) {
        const current = queue.shift()!;
        if (current.depth > scanOptions.maxDepth) continue;
        if (!isPathInside(canonicalRoot, current.canonical)) continue;
        let children: string[];
        try {
          children = await runtime.IOUtils.getChildren(current.path);
        } catch {
          continue;
        }
        children.sort((left, right) => left.localeCompare(right));
        for (const path of children) {
          if (files.length >= scanOptions.maxFiles) break;
          if (!isPathInside(root, path)) continue;
          const relativePath = relativeToRoot(root, path);
          if (!relativePath || hasHiddenSegment(relativePath) || isDatabasePath(relativePath)) continue;
          let inspected: Awaited<ReturnType<typeof inspectExistingPath>>;
          try {
            inspected = await inspectExistingPath(path);
          } catch {
            continue;
          }
          if (!inspected.exists || !inspected.canonical) continue;
          if (!isPathInside(canonicalRoot, inspected.canonical)) continue;
          if (inspected.type === "directory") {
            if (current.depth < scanOptions.maxDepth) {
              queue.push({ path, canonical: inspected.canonical, depth: current.depth + 1 });
            }
            continue;
          }
          if (inspected.type !== "regular" && inspected.type !== "file") continue;
          const name = runtime.PathUtils.filename?.(path) ?? normalizeSlashes(path).split("/").pop() ?? path;
          if (extensionOf(name) !== ".pdf") continue;
          files.push({
            name,
            path,
            relativePath,
          });
        }
      }
      return files;
    },
  };
}
