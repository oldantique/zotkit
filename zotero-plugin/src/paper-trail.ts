import { sha256File } from "./hashing";
import { randomID } from "./platform";
import type { ReaderContext, JsonValue } from "./reader-context";
import type { ChatEntry } from "./sidebar";

export const ANCHOR_TAG = "zotkit-chat";
export const ANCHOR_OPEN_TAG = "zotkit-open";
export const ANCHOR_RESOLVED_TAG = "zotkit-resolved";
export const ANCHOR_COLOR = "#a28ae5";

export interface AnchorRecord {
  anchorId: string;
  libraryID: number | string;
  itemKey: string | null;        // 父条目 key;解析失败时 null
  attachmentKey: string;
  pdfSha256: string | null;      // 创建时的 PDF hash;取不到文件时 null
  annotationKey?: string;        // 高亮写入成功后回填
  pageNumber?: number;
  position?: JsonValue;          // ReaderSelection.position 原样
  selectedText: string;
  question: string;
  answerSummary?: string;
  threadId: string;
  turnRange: [number, number];   // store 内 turn 下标闭区间;追问扩展末端
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt?: string;
}

export function buildAnchorComment(question: string, summary: string): string {
  const q = question.trim().slice(0, 600);
  const s = summary.trim().slice(0, 900);
  return s ? `Q: ${q}\n\n${s}` : `Q: ${q}`;
}

/** 首段纯文本降级摘要:去掉常见 Markdown 记号,≤300 字。 */
export function summaryFallback(answerMarkdown: string): string {
  const firstParagraph = answerMarkdown.split(/\n\s*\n/, 1)[0] ?? "";
  return firstParagraph
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]|\[|\]\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * Zotero annotationSortIndex 近似值。第三段本应是"距页顶距离"(需页高),
 * 这里用 9999 - rect 顶边近似 —— 只影响批注侧栏排序,不影响定位。
 */
export function computeSortIndex(position: unknown): string {
  const record = (position && typeof position === "object" ? position : {}) as Record<string, unknown>;
  const pageIndexRaw = record.pageIndex;
  const pageIndex = typeof pageIndexRaw === "number" && Number.isFinite(pageIndexRaw)
    ? Math.max(0, Math.floor(pageIndexRaw))
    : 0;
  const rects = Array.isArray(record.rects) ? record.rects : [];
  const first = Array.isArray(rects[0]) ? (rects[0] as unknown[]) : null;
  const rectTop = first && typeof first[3] === "number" && Number.isFinite(first[3]) ? (first[3] as number) : null;
  const top = rectTop === null ? 0 : Math.min(99999, Math.max(0, Math.round(9999 - rectTop)));
  const pad = (value: number, width: number) => String(value).padStart(width, "0").slice(-width);
  return `${pad(pageIndex, 5)}|${pad(0, 6)}|${pad(top, 5)}`;
}

/**
 * The only surface through which PaperTrailService touches real Zotero
 * items. Every method is narrow and independently fakeable, which is what
 * lets the service's queueing/consent/undo logic be unit-tested without a
 * Zotero runtime.
 */
export interface AnchorHost {
  createHighlight(target: {
    libraryID: number | string;
    attachmentKey: string;
    selectedText: string;
    comment: string;
    color: string;
    pageLabel: string;
    position: JsonValue;
    sortIndex: string;
    tags: readonly string[];
  }): Promise<string>; // returns the new annotation's key
  swapAnnotationTags(
    libraryID: number | string,
    annotationKey: string,
    add: readonly string[],
    remove: readonly string[],
  ): Promise<void>;
  deleteAnnotation(libraryID: number | string, annotationKey: string): Promise<void>;
  annotationExists(libraryID: number | string, annotationKey: string): Promise<boolean>;
  resolveParentItemKey(libraryID: number | string, attachmentKey: string): Promise<string | null>;
  attachmentFile(libraryID: number | string, attachmentKey: string): Promise<{ path: string; size: number } | null>;
}

export function createZoteroAnchorHost(zotero: any): AnchorHost {
  const getByKey = async (libraryID: number | string, key: string): Promise<any> => {
    const item = await zotero.Items?.getByLibraryAndKeyAsync?.(libraryID, key)
      ?? zotero.Items?.getByLibraryAndKey?.(libraryID, key);
    if (!item) throw new Error(`Zotero item ${key} is unavailable`);
    return item;
  };
  return {
    async createHighlight(target) {
      const attachment = await getByKey(target.libraryID, target.attachmentKey);
      const annotation = new zotero.Item("annotation");
      annotation.libraryID = attachment.libraryID;
      annotation.parentID = attachment.id;
      annotation.annotationType = "highlight";
      annotation.annotationText = target.selectedText.slice(0, 5000);
      annotation.annotationComment = target.comment;
      annotation.annotationColor = target.color;
      annotation.annotationPageLabel = target.pageLabel;
      annotation.annotationSortIndex = target.sortIndex;
      annotation.annotationPosition = JSON.stringify(target.position);
      for (const tag of target.tags) annotation.addTag?.(tag);
      await annotation.saveTx();
      if (!annotation.key) throw new Error("Zotero 未返回批注 key");
      return annotation.key as string;
    },
    async swapAnnotationTags(libraryID, annotationKey, add, remove) {
      const annotation = await getByKey(libraryID, annotationKey);
      for (const tag of remove) annotation.removeTag?.(tag);
      for (const tag of add) annotation.addTag?.(tag);
      await annotation.saveTx({ skipDateModifiedUpdate: true });
    },
    async deleteAnnotation(libraryID, annotationKey) {
      try {
        const annotation = await getByKey(libraryID, annotationKey);
        await annotation.eraseTx?.();
      }
      catch { /* user already removed it by hand: undo stays idempotent */ }
    },
    async annotationExists(libraryID, annotationKey) {
      try { await getByKey(libraryID, annotationKey); return true; }
      catch { return false; }
    },
    async resolveParentItemKey(libraryID, attachmentKey) {
      try {
        const attachment = await getByKey(libraryID, attachmentKey);
        const parent = attachment.parentID ? zotero.Items?.get?.(attachment.parentID) : null;
        return parent?.key ?? null;
      }
      catch { return null; }
    },
    async attachmentFile(libraryID, attachmentKey) {
      try {
        const attachment = await getByKey(libraryID, attachmentKey);
        const path = await attachment.getFilePathAsync?.();
        if (typeof path !== "string" || !path) return null;
        const stat = await IOUtils.stat(path);
        const size = Number(stat?.size || 0);
        return size > 0 ? { path, size } : null;
      }
      catch { return null; }
    },
  };
}

export type PaperTrailConsent = "unset" | "on" | "off";

export interface PaperTrailCallbacks {
  onState(): void;
  /** Returns null on failure/timeout -- callers fall back to summaryFallback(answer). */
  summarize(question: string, answerMarkdown: string): Promise<string | null>;
  getAnchors(context: ReaderContext): AnchorRecord[];
  recordAnchor(context: ReaderContext, anchor: AnchorRecord): Promise<void>;
  updateAnchor(context: ReaderContext, anchorId: string, patch: Partial<AnchorRecord>): Promise<void>;
  removeAnchor(context: ReaderContext, anchorId: string): Promise<void>;
  consent(): PaperTrailConsent;
  setConsent(value: Exclude<PaperTrailConsent, "unset">): void;
}

/**
 * Snapshot taken when the user asks a question, before the answer exists.
 * completeTurn() consumes it once the turn finishes; it never survives past
 * that (success, error, or a thread mismatch that discards it implicitly on
 * the next begin()).
 */
interface PendingAnchor {
  libraryID: number | string;
  attachmentKey: string;
  itemKeyHint: string | null;
  selection: { text: string; pageNumber?: number; position?: JsonValue };
  question: string;
  threadId: string;
  createdAt: string;
  /** Set when an anchor already covers this thread + selection: extend it instead of creating a new one. */
  followUpOf?: string;
}

interface PendingConsentRequest {
  context: ReaderContext;
  record: AnchorRecord;
}

interface ConfirmationChip {
  anchorId: string;
  pageNumber?: number;
}

/**
 * randomID() reaches for the Zotero-only `Services` global, which is correct
 * in the plugin runtime but absent under Node/vitest. Try the real thing
 * first (production callers get proper UUIDs) and fall back to a
 * Math.random-based id so the service is constructible -- and completeTurn
 * runnable -- with no arguments in a plain test environment.
 */
function defaultAnchorId(prefix: string): string {
  try {
    return randomID(prefix);
  }
  catch {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Deterministic write layer between the chat store and Zotero highlights.
 *
 * Every mutation of Zotero state (create/tag-swap/delete) is threaded
 * through a single serialized queue (`this.queue`) so undo/resolve/annotation
 * writes for the same paper never interleave their host calls, mirroring the
 * pattern in zotero-mutations.ts's resolveReview/resolveQueue.
 */
export class PaperTrailService {
  private pendingAnchor: PendingAnchor | null = null;
  private pendingConsentRequest: PendingConsentRequest | null = null;
  private confirmation: ConfirmationChip | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly shaCache = new Map<string, string | null>();

  constructor(
    private readonly host: AnchorHost,
    private readonly callbacks: PaperTrailCallbacks,
    private readonly now: () => Date = () => new Date(),
    private readonly idFactory: (prefix: string) => string = defaultAnchorId,
  ) {}

  /**
   * Snapshot the active selection and question right after the user asks.
   * No-ops when there is no selected text -- nothing to anchor a highlight
   * to. When an anchor for the same thread + selection already exists, marks
   * this as a follow-up instead of a fresh anchor.
   */
  beginPendingAnchor(context: ReaderContext, question: string, threadId: string): void {
    const selectionText = context.selection?.text;
    if (!selectionText) return;
    const pageNumber = context.selection?.pageNumber;
    const position = context.selection?.position;
    const existing = this.callbacks.getAnchors(context).find(
      (anchor) => anchor.threadId === threadId
        && anchor.selectedText === selectionText
        && anchor.pageNumber === pageNumber,
    );
    this.pendingAnchor = {
      libraryID: context.attachment.libraryID ?? "0",
      attachmentKey: context.attachment.key,
      itemKeyHint: context.parent?.key ?? null,
      selection: { text: selectionText, pageNumber, position },
      question,
      threadId,
      createdAt: this.now().toISOString(),
      followUpOf: existing?.anchorId,
    };
  }

  /**
   * Called once the turn that beginPendingAnchor() opened has finished.
   * Persists the anchor record first, then branches on consent for the
   * (optional) annotation write. Returns the new/extended anchor, or null
   * when there was nothing to anchor (no matching pending snapshot, or the
   * turn ended in an error).
   */
  async completeTurn(
    context: ReaderContext,
    threadId: string,
    entries: ChatEntry[],
    turnIndex: number,
  ): Promise<AnchorRecord | null> {
    const pending = this.pendingAnchor;
    if (!pending || pending.threadId !== threadId) return null;

    const lastEntry = entries.at(-1);
    if (lastEntry?.kind === "error") {
      this.pendingAnchor = null;
      return null;
    }
    this.pendingAnchor = null;

    if (pending.followUpOf) {
      const existing = this.callbacks.getAnchors(context).find((anchor) => anchor.anchorId === pending.followUpOf);
      if (!existing) return null;
      const turnRange: [number, number] = [existing.turnRange[0], turnIndex];
      await this.callbacks.updateAnchor(context, existing.anchorId, { turnRange });
      return { ...existing, turnRange };
    }

    const answer = [...entries].reverse().find((entry) => entry.kind === "assistant")?.text ?? "";
    let summary: string | null = null;
    try {
      summary = await this.callbacks.summarize(pending.question, answer);
    }
    catch {
      summary = null;
    }
    const answerSummary = summary ?? summaryFallback(answer);

    let itemKey: string | null = null;
    try {
      itemKey = await this.host.resolveParentItemKey(pending.libraryID, pending.attachmentKey);
    }
    catch {
      itemKey = null;
    }
    if (!itemKey) itemKey = pending.itemKeyHint;

    const pdfSha256 = await this.pdfSha256For(pending.libraryID, pending.attachmentKey);

    let record: AnchorRecord = {
      anchorId: this.idFactory("anchor"),
      libraryID: pending.libraryID,
      itemKey,
      attachmentKey: pending.attachmentKey,
      pdfSha256,
      pageNumber: pending.selection.pageNumber,
      position: pending.selection.position,
      selectedText: pending.selection.text,
      question: pending.question,
      answerSummary,
      threadId: pending.threadId,
      turnRange: [turnIndex, turnIndex],
      status: "open",
      createdAt: this.now().toISOString(),
    };

    await this.callbacks.recordAnchor(context, record);

    const consent = this.callbacks.consent();
    if (consent === "on") {
      record = await this.enqueue(() => this.writeAnnotation(context, record));
    }
    else if (consent === "unset" && !this.pendingConsentRequest) {
      // Only the first parked request is kept; later unset turns while one
      // is pending just stay record-only (their record is already saved).
      this.pendingConsentRequest = { context, record };
      this.callbacks.onState();
    }

    return record;
  }

  /** Non-null when a consent card needs to be rendered. */
  consentRequest(): { question: string; pageNumber?: number } | null {
    if (!this.pendingConsentRequest) return null;
    const { record } = this.pendingConsentRequest;
    return { question: record.question, pageNumber: record.pageNumber };
  }

  async resolveConsent(context: ReaderContext, decision: "accept" | "decline"): Promise<void> {
    const pending = this.pendingConsentRequest;
    this.pendingConsentRequest = null;
    if (decision === "accept") {
      this.callbacks.setConsent("on");
      if (pending) {
        await this.enqueue(() => this.writeAnnotation(pending.context, pending.record));
      }
    }
    else {
      this.callbacks.setConsent("off");
    }
    this.callbacks.onState();
  }

  async undoAnchor(context: ReaderContext, anchorId: string): Promise<void> {
    return this.enqueue(async () => {
      const anchor = this.callbacks.getAnchors(context).find((entry) => entry.anchorId === anchorId);
      if (anchor?.annotationKey) {
        await this.host.deleteAnnotation(anchor.libraryID, anchor.annotationKey);
      }
      await this.callbacks.removeAnchor(context, anchorId);
      this.confirmation = null;
      this.callbacks.onState();
    });
  }

  /**
   * open -> resolved plus a tag swap on the underlying annotation. Idempotent
   * even under concurrent calls: the "already resolved" check re-reads
   * anchor state from inside the queued closure (like undoAnchor), not
   * before enqueuing, so a second call queued while the first is still
   * in flight sees the already-resolved status once it actually runs.
   */
  async resolveAnchor(context: ReaderContext, anchorId: string): Promise<void> {
    return this.enqueue(async () => {
      const anchor = this.callbacks.getAnchors(context).find((entry) => entry.anchorId === anchorId);
      if (!anchor || anchor.status === "resolved") return;
      if (anchor.annotationKey && await this.host.annotationExists(anchor.libraryID, anchor.annotationKey)) {
        await this.host.swapAnnotationTags(
          anchor.libraryID,
          anchor.annotationKey,
          [ANCHOR_RESOLVED_TAG],
          [ANCHOR_OPEN_TAG],
        );
      }
      await this.callbacks.updateAnchor(context, anchorId, {
        status: "resolved",
        resolvedAt: this.now().toISOString(),
      });
      this.callbacks.onState();
    });
  }

  /** Data for the floating confirmation chip shown right after a highlight is written. */
  lastConfirmation(): { anchorId: string; pageNumber?: number } | null {
    return this.confirmation ? { ...this.confirmation } : null;
  }

  clearConfirmation(): void {
    this.confirmation = null;
  }

  private async pdfSha256For(libraryID: number | string, attachmentKey: string): Promise<string | null> {
    const file = await this.host.attachmentFile(libraryID, attachmentKey);
    if (!file) return null;
    const cacheKey = `${file.path}|${file.size}`;
    const cached = this.shaCache.get(cacheKey);
    if (cached !== undefined) return cached;
    let hash: string | null;
    try {
      hash = sha256File(file.path, file.size);
    }
    catch {
      hash = null;
    }
    this.shaCache.set(cacheKey, hash);
    return hash;
  }

  /**
   * Writes (or silently skips, when the selection has no position to anchor
   * to) the Zotero highlight for a just-recorded anchor. Always runs inside
   * `enqueue()` so it never interleaves with another queued write for the
   * same paper.
   */
  private async writeAnnotation(context: ReaderContext, record: AnchorRecord): Promise<AnchorRecord> {
    if (record.position === undefined || record.position === null) return record;
    try {
      const annotationKey = await this.host.createHighlight({
        libraryID: record.libraryID,
        attachmentKey: record.attachmentKey,
        selectedText: record.selectedText,
        comment: buildAnchorComment(record.question, record.answerSummary ?? ""),
        color: ANCHOR_COLOR,
        pageLabel: record.pageNumber !== undefined ? String(record.pageNumber) : "",
        position: record.position,
        sortIndex: computeSortIndex(record.position),
        tags: [ANCHOR_TAG, ANCHOR_OPEN_TAG],
      });
      await this.callbacks.updateAnchor(context, record.anchorId, { annotationKey });
      this.confirmation = { anchorId: record.anchorId, pageNumber: record.pageNumber };
      this.callbacks.onState();
      return { ...record, annotationKey };
    }
    catch {
      // Record stays in place without an annotation; nothing else to roll back.
      this.callbacks.onState();
      return record;
    }
  }

  // Mirrors zotero-mutations.ts's resolveQueue chaining: the queue link
  // swallows errors purely to stay alive, while the promise returned to the
  // caller is `result` itself and still carries the real rejection.
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => {}).then(run);
    this.queue = result;
    return result;
  }
}
