import { buildQaFromEntries } from "./exchanges";
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

/** 一条锚点对应的对话轮次(question + answer 原文,均未截断)。 */
export interface TranscriptExchange {
  question: string;
  answer: string;
}

const TRANSCRIPT_CHAR_CAP = 50_000;
const TRANSCRIPT_TRUNCATED_MARKER = "\n\n（对话过长，已截断，完整记录见对话面板）";

/**
 * Full-transcript annotation comment (spec amendment 2026-07-26, replacing
 * the old "Q + 要点" `buildAnchorComment`): every `Q:`/`A:` round verbatim,
 * joined with a blank line, capped at TRANSCRIPT_CHAR_CAP total characters.
 * Individual answers are never pre-truncated -- only the joined total is,
 * with a marker appended pointing back at the live conversation panel.
 */
export function buildAnchorTranscriptComment(exchanges: TranscriptExchange[]): string {
  const full = exchanges.map((exchange) => `Q: ${exchange.question}\n\nA: ${exchange.answer}`).join("\n\n");
  if (full.length <= TRANSCRIPT_CHAR_CAP) return full;
  return `${full.slice(0, TRANSCRIPT_CHAR_CAP)}${TRANSCRIPT_TRUNCATED_MARKER}`;
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
  /** Rewrites an existing annotation's comment (full transcript, rewritten each turn an anchor extends). */
  updateAnnotationComment(libraryID: number | string, annotationKey: string, comment: string): Promise<void>;
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
    async updateAnnotationComment(libraryID, annotationKey, comment) {
      // getByKey() throws when the annotation is gone (deleted by hand);
      // the caller (rewriteTranscript) catches that and skips silently.
      const annotation = await getByKey(libraryID, annotationKey);
      annotation.annotationComment = comment;
      // Unlike the tag swap above, a comment rewrite is real content --
      // dateModified should reflect it, so this is a plain saveTx().
      await annotation.saveTx();
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
  /**
   * Per-turn transcript for a thread (same pipeline Noting's buildNotingSnapshot
   * uses -- CodexService.readThreadTurns). Used to build/rewrite an anchor's
   * annotation comment from its turnRange. May reject (offline app-server,
   * unknown thread, etc.) -- PaperTrailService degrades on failure rather
   * than writing/overwriting a comment with empty content; see writeAnnotation
   * and rewriteTranscript.
   */
  readThreadTurns(threadId: string): Promise<ChatEntry[][]>;
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
   * Called once a turn on `threadId` has finished. Two independent triggers
   * share this one entry point:
   *
   * 1. **Pending-anchor path** -- this turn began with beginPendingAnchor()
   *    (a live selection was reattached at send time). Either creates a
   *    fresh anchor, or -- when the selection matched an anchor already on
   *    this thread -- extends that anchor (the pre-amendment behavior).
   * 2. **Thread-scoped path** (spec amendment 2026-07-26 / bug-triage #4) --
   *    no matching pending snapshot (the common case: a typed follow-up with
   *    no selection reattached), but the thread already has an OPEN anchor.
   *    Extends that anchor regardless of selection, closing the gap where
   *    normal follow-ups never grew turnRange past the first turn.
   *
   * Every extension (either path) rewrites the anchor's annotation comment
   * with the full transcript of its (possibly now-wider) turnRange, through
   * the same serialized write queue as every other Zotero mutation here.
   * Returns the new/extended anchor, or null when there was nothing to do
   * (no pending snapshot and no open anchor for this thread, or the turn
   * ended in an error).
   */
  async completeTurn(
    context: ReaderContext,
    threadId: string,
    entries: ChatEntry[],
    turnIndex: number,
  ): Promise<AnchorRecord | null> {
    const erroredThisTurn = entries.at(-1)?.kind === "error";
    const pending = this.pendingAnchor;

    if (pending && pending.threadId === threadId) {
      this.pendingAnchor = null;
      if (erroredThisTurn) return null;

      if (pending.followUpOf) {
        const existing = this.callbacks.getAnchors(context).find((anchor) => anchor.anchorId === pending.followUpOf);
        if (!existing) return null;
        return this.extendAnchor(context, existing, turnIndex);
      }

      return this.createAnchor(context, pending, entries, turnIndex);
    }

    // No pending snapshot for THIS thread (typed follow-up, or a pending
    // snapshot that belongs to some other thread and is left untouched for
    // its own turn to consume later): fall back to thread identity. Only
    // ever touches the single open anchor with the latest turnRange end for
    // `threadId` -- never a different thread, never a different paper
    // (getAnchors(context) is already scoped to the live context's paper).
    if (erroredThisTurn) return null;
    const openAnchor = this.latestOpenAnchorForThread(context, threadId);
    if (!openAnchor || openAnchor.turnRange[1] >= turnIndex) return null;
    return this.extendAnchor(context, openAnchor, turnIndex);
  }

  /** The open anchor for `threadId` with the greatest turnRange end, or null when none is open. */
  private latestOpenAnchorForThread(context: ReaderContext, threadId: string): AnchorRecord | null {
    let latest: AnchorRecord | null = null;
    for (const anchor of this.callbacks.getAnchors(context)) {
      if (anchor.threadId !== threadId || anchor.status !== "open") continue;
      if (!latest || anchor.turnRange[1] > latest.turnRange[1]) latest = anchor;
    }
    return latest;
  }

  /**
   * Creates a brand-new anchor for a just-answered pending selection+question.
   * `answerSummary` is a free, synchronous first-paragraph digest (see
   * summaryFallback) rather than an LLM-generated one: the spec amendment
   * that introduced the full-transcript comment also retired the old
   * blocking `summarize()` round-trip (a 10s-capped runUtilityTurn call)
   * that used to feed the now-deprecated "Q + 要点" comment -- its only
   * remaining consumer is noting.ts's degenerate "thread unreadable"
   * fallback, which doesn't justify gating every write on an LLM call.
   * The annotation comment itself no longer depends on the summary at all:
   * writeAnnotation() below pulls the real transcript for this anchor's
   * turnRange via readThreadTurns().
   */
  private async createAnchor(
    context: ReaderContext,
    pending: PendingAnchor,
    entries: ChatEntry[],
    turnIndex: number,
  ): Promise<AnchorRecord> {
    const answer = [...entries].reverse().find((entry) => entry.kind === "assistant")?.text ?? "";
    const answerSummary = summaryFallback(answer);

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
    else if (consent === "off") {
      // No annotation write, but the question list (which reads anchors via
      // getAnchors) has a new record-only entry -- render now instead of
      // waiting for some unrelated future onState() call.
      this.callbacks.onState();
    }

    return record;
  }

  /**
   * Extends an already-open anchor's turnRange to `turnIndex` and rewrites
   * its annotation comment with the full transcript of the widened range --
   * one enqueue() per turn, so the session-store patch and the Zotero
   * saveTx() never interleave with another queued write for this paper.
   */
  private async extendAnchor(
    context: ReaderContext,
    anchor: AnchorRecord,
    turnIndex: number,
  ): Promise<AnchorRecord> {
    const turnRange: [number, number] = [anchor.turnRange[0], turnIndex];
    return this.enqueue(async () => {
      await this.callbacks.updateAnchor(context, anchor.anchorId, { turnRange });
      const updated: AnchorRecord = { ...anchor, turnRange };
      await this.rewriteTranscript(updated);
      return updated;
    });
  }

  /** Non-null when a consent card needs to be rendered. */
  consentRequest(): { question: string; pageNumber?: number } | null {
    if (!this.pendingConsentRequest) return null;
    const { record } = this.pendingConsentRequest;
    return { question: record.question, pageNumber: record.pageNumber };
  }

  /**
   * Accepting turns consent on for every future turn, but by the time the
   * user sees the consent card there is often more than one record-only
   * anchor already saved for this paper -- every unset turn after the first
   * parks nothing new (see the "first parked request" comment in
   * completeTurn) and just stays record-only. Accept must backfill ALL of
   * them, not just the one that happened to trigger the card, or the
   * earlier questions silently keep no highlight forever.
   */
  async resolveConsent(context: ReaderContext, decision: "accept" | "decline"): Promise<void> {
    const pending = this.pendingConsentRequest;
    this.pendingConsentRequest = null;
    if (decision === "accept") {
      this.callbacks.setConsent("on");
      if (pending) {
        const backfillTargets = this.callbacks.getAnchors(pending.context).filter(
          (anchor) => !anchor.annotationKey && anchor.position !== undefined && anchor.position !== null,
        );
        for (const anchor of backfillTargets) {
          // writeAnnotation() never throws (it catches and reports via
          // onState() internally), so one failed write can never stop the
          // rest of the loop -- each anchor's write is isolated.
          await this.enqueue(() => this.writeAnnotation(pending.context, anchor));
        }
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
   * Reads a thread's turns (via the readThreadTurns callback -- the same
   * pipeline Noting's buildNotingSnapshot uses) and slices them to a
   * turnRange, producing the {question, answer} pairs the transcript
   * builder needs. Rejects when the read itself fails (offline app-server,
   * etc.) -- callers decide what "no transcript available" should degrade
   * to; this never silently substitutes an empty transcript, which would
   * read as "this anchor has no Q&A" instead of "we couldn't fetch it".
   */
  private async transcriptExchangesFor(
    threadId: string,
    turnRange: readonly [number, number],
  ): Promise<TranscriptExchange[]> {
    const turns = await this.callbacks.readThreadTurns(threadId);
    const [start, end] = turnRange;
    return turns.slice(start, end + 1)
      .flatMap((turnEntries) => buildQaFromEntries(turnEntries, undefined))
      .map((qa) => ({ question: qa.question, answer: qa.answerMarkdown }));
  }

  private async buildTranscriptComment(anchor: AnchorRecord): Promise<string> {
    const exchanges = await this.transcriptExchangesFor(anchor.threadId, anchor.turnRange);
    return buildAnchorTranscriptComment(exchanges);
  }

  /**
   * Writes (or silently skips, when the selection has no position to anchor
   * to) the Zotero highlight for a just-recorded anchor. Always runs inside
   * `enqueue()` so it never interleaves with another queued write for the
   * same paper. The comment is the anchor's full transcript (round 1 only,
   * at creation time -- its turnRange is still [turnIndex, turnIndex]). If
   * the transcript read itself fails, this still writes an annotation --
   * just with a minimal one-round comment built from data already on hand
   * (record.question/answerSummary) instead of leaving the highlight
   * commentless.
   */
  private async writeAnnotation(context: ReaderContext, record: AnchorRecord): Promise<AnchorRecord> {
    if (record.position === undefined || record.position === null) {
      // Nothing to write, but the question list still gained a record-only
      // entry -- render now instead of waiting for an unrelated future
      // onState() call.
      this.callbacks.onState();
      return record;
    }
    try {
      let comment: string;
      try {
        comment = await this.buildTranscriptComment(record);
      }
      catch {
        comment = buildAnchorTranscriptComment([{ question: record.question, answer: record.answerSummary ?? "" }]);
      }
      const annotationKey = await this.host.createHighlight({
        libraryID: record.libraryID,
        attachmentKey: record.attachmentKey,
        selectedText: record.selectedText,
        comment,
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

  /**
   * Rewrites an already-written annotation's comment with the full
   * transcript of `anchor`'s (possibly just-widened) turnRange. A no-op
   * when the anchor never got an annotation (no position, consent off/parked)
   * -- nothing to rewrite. When the transcript read itself fails, this skips
   * the rewrite entirely rather than overwriting a good existing comment
   * with an empty one -- next turn's rewrite will catch it up. When the
   * annotation was deleted by the user by hand, updateAnnotationComment()
   * rejects (mirrors createZoteroAnchorHost's other lookups) and this skips
   * silently too, exactly like deleteAnnotation's "already removed" handling
   * -- neither failure mode ever fails the write queue.
   */
  private async rewriteTranscript(anchor: AnchorRecord): Promise<void> {
    if (!anchor.annotationKey) return;
    let comment: string;
    try {
      comment = await this.buildTranscriptComment(anchor);
    }
    catch {
      return;
    }
    try {
      await this.host.updateAnnotationComment(anchor.libraryID, anchor.annotationKey, comment);
    }
    catch {
      // User already removed it by hand: rewrite stays a silent no-op.
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
