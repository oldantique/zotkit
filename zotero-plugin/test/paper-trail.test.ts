import { describe, expect, it, vi } from "vitest";
import {
  buildAnchorTranscriptComment,
  computeSortIndex,
  PaperTrailService,
  summaryFallback,
  type AnchorHost,
  type PaperTrailCallbacks,
} from "../src/paper-trail";
import type { ReaderContext } from "../src/reader-context";

const TRUNCATED_MARKER = "\n\n（对话过长，已截断，完整记录见对话面板）";

describe("buildAnchorTranscriptComment", () => {
  it("joins Q/A rounds with a blank line, preserving full text verbatim", () => {
    const comment = buildAnchorTranscriptComment([
      { question: "为什么用 KL 散度?", answer: "因为它衡量分布差异。" },
      { question: "还有别的散度吗?", answer: "还有 JS 散度等。" },
    ]);
    expect(comment).toBe(
      "Q: 为什么用 KL 散度?\n\nA: 因为它衡量分布差异。\n\nQ: 还有别的散度吗?\n\nA: 还有 JS 散度等。",
    );
  });

  it("returns an empty string for no exchanges", () => {
    expect(buildAnchorTranscriptComment([])).toBe("");
  });

  it("does not cap individual answers below the total cap", () => {
    const longAnswer = "答".repeat(2000);
    const comment = buildAnchorTranscriptComment([{ question: "q", answer: longAnswer }]);
    expect(comment).toContain(longAnswer);
  });

  it("truncates the TOTAL at 50000 characters and appends the truncation marker", () => {
    const longAnswer = "答".repeat(60_000);
    const comment = buildAnchorTranscriptComment([{ question: "q", answer: longAnswer }]);
    expect(comment.length).toBe(50_000 + TRUNCATED_MARKER.length);
    expect(comment.endsWith(TRUNCATED_MARKER)).toBe(true);
    expect(comment.startsWith(`Q: q\n\nA: ${"答".repeat(100)}`)).toBe(true);
  });

  it("does not truncate when the total is exactly at the cap", () => {
    const comment = buildAnchorTranscriptComment([{ question: "q", answer: "a".repeat(50_000 - "Q: q\n\nA: ".length) }]);
    expect(comment.length).toBe(50_000);
    expect(comment.endsWith(TRUNCATED_MARKER)).toBe(false);
  });
});

describe("summaryFallback", () => {
  it("returns the first paragraph with markdown markers stripped", () => {
    expect(summaryFallback("**核心**是 `注意力`。\n\n后续段落")).toBe("核心是 注意力。");
  });
  it("caps at 300 characters", () => {
    expect(summaryFallback("长".repeat(400)).length).toBe(300);
  });
  it("returns empty string for whitespace-only input", () => {
    expect(summaryFallback("  \n\n ")).toBe("");
  });
});

describe("computeSortIndex", () => {
  it("formats pageIndex|offset|top as 5|6|5 zero-padded digits", () => {
    expect(computeSortIndex({ pageIndex: 6, rects: [[10, 700, 200, 712]] })).toBe("00006|000000|09287");
  });
  it("falls back to zeros without position data", () => {
    expect(computeSortIndex(undefined)).toBe("00000|000000|00000");
    expect(computeSortIndex({ pageIndex: 2 })).toBe("00002|000000|00000");
  });
});

function trailContext(): ReaderContext {
  return {
    schemaVersion: 1, capturedAt: "2026-07-25T00:00:00.000Z",
    attachment: { id: 7, key: "ATTACH", libraryID: 1, title: "Paper", filename: "p.pdf", creators: [], tags: [] },
    parent: { id: 6, key: "PARENT", libraryID: 1, title: "A Paper", creators: [], tags: [] },
    pdfPath: "/papers/p.pdf", page: null, fullText: null, workspace: null, warnings: [],
    selection: {
      text: "选中的定理", pageIndex: 6, pageNumber: 7,
      position: { pageIndex: 6, rects: [[10, 700, 200, 712]] },
      capturedAt: "2026-07-25T00:00:00.000Z",
    },
  } as unknown as ReaderContext;
}

function makeHost(): AnchorHost & { created: any[] } {
  const created: any[] = [];
  return {
    created,
    createHighlight: vi.fn(async (target: any) => { created.push(target); return `ANN${created.length}`; }),
    swapAnnotationTags: vi.fn(async () => {}),
    updateAnnotationComment: vi.fn(async () => {}),
    deleteAnnotation: vi.fn(async () => {}),
    annotationExists: vi.fn(async () => true),
    resolveParentItemKey: vi.fn(async () => "PARENT"),
    attachmentFile: vi.fn(async () => null),   // pdfSha256 → null 路径
  };
}

/**
 * PaperTrailService now fetches a thread's transcript via readThreadTurns()
 * whenever it needs to build/rewrite an annotation comment. `turnsByThread`
 * is a stand-in for the live thread store: index N holds turn N's entries.
 * Tests that don't assert on comment content can omit it entirely -- an
 * unconfigured/missing thread just yields an empty transcript, never a throw.
 */
function makeCallbacks(
  consent: string,
  turnsByThread: Record<string, any[][]> = {},
): PaperTrailCallbacks & { anchors: any[] } {
  const anchors: any[] = [];
  let consentValue = consent;
  return {
    anchors,
    onState: vi.fn(),
    readThreadTurns: vi.fn(async (threadId: string) => turnsByThread[threadId] ?? []),
    getAnchors: () => anchors,
    recordAnchor: vi.fn(async (_c, a) => { anchors.push(a); }),
    updateAnchor: vi.fn(async (_c, id, patch) => {
      const index = anchors.findIndex((a) => a.anchorId === id);
      if (index >= 0) anchors[index] = { ...anchors[index], ...patch };
    }),
    removeAnchor: vi.fn(async (_c, id) => {
      const index = anchors.findIndex((a) => a.anchorId === id);
      if (index >= 0) anchors.splice(index, 1);
    }),
    consent: () => consentValue as any,
    setConsent: vi.fn((value) => { consentValue = value; }),
  };
}

/** A per-turn transcript array with `roundEntries` at `index`, empty turns before it. */
function turnsAt(index: number, roundEntries: any[]): any[][] {
  const turns: any[][] = Array.from({ length: index + 1 }, () => []);
  turns[index] = roundEntries;
  return turns;
}

/** A per-turn transcript array built from a sparse {turnIndex: roundEntries} map. */
function turnsWith(rounds: Record<number, any[]>): any[][] {
  const maxIndex = Math.max(...Object.keys(rounds).map(Number));
  const turns: any[][] = Array.from({ length: maxIndex + 1 }, () => []);
  for (const [index, roundEntries] of Object.entries(rounds)) turns[Number(index)] = roundEntries;
  return turns;
}

const entries = [
  { id: "u1", kind: "user", text: "为什么?" },
  { id: "a1", kind: "assistant", text: "因为注意力矩阵……", state: "complete" },
] as any;

describe("PaperTrailService", () => {
  it("writes a highlight with a full-transcript comment after the first completed turn (consent on)", async () => {
    const host = makeHost();
    const round = [
      { id: "u1", kind: "user", text: "为什么?" },
      { id: "a1", kind: "assistant", text: "因为注意力矩阵……", state: "complete" },
    ] as any;
    const callbacks = makeCallbacks("on", { "thread-a": turnsAt(4, round) });
    const service = new PaperTrailService(host, callbacks, () => new Date("2026-07-25T01:00:00Z"), (p) => `${p}-1`);
    const context = trailContext();
    service.beginPendingAnchor(context, "为什么?", "thread-a");
    const anchor = await service.completeTurn(context, "thread-a", round, 4);
    expect(anchor).toMatchObject({
      annotationKey: "ANN1", pageNumber: 7, status: "open", turnRange: [4, 4],
      itemKey: "PARENT", question: "为什么?", answerSummary: "因为注意力矩阵……",
    });
    expect(host.created[0]).toMatchObject({
      color: "#a28ae5", pageLabel: "7", sortIndex: "00006|000000|09287",
      comment: "Q: 为什么?\n\nA: 因为注意力矩阵……", tags: ["zotkit-chat", "zotkit-open"],
    });
    expect(service.lastConfirmation()).toMatchObject({ pageNumber: 7 });
  });

  it("does not write on an error turn, and drops the pending snapshot", async () => {
    const host = makeHost();
    const service = new PaperTrailService(host, makeCallbacks("on"));
    const context = trailContext();
    service.beginPendingAnchor(context, "q", "thread-a");
    const result = await service.completeTurn(context, "thread-a",
      [...entries, { id: "e1", kind: "error", text: "boom" }] as any, 4);
    expect(result).toBeNull();
    expect(host.createHighlight).not.toHaveBeenCalled();
  });

  it("populates answerSummary synchronously via summaryFallback -- no LLM round-trip on the write path", async () => {
    const host = makeHost();
    const round = [
      { id: "u1", kind: "user", text: "q" },
      { id: "a1", kind: "assistant", text: "**核心**结论在这里。\n\n后续细节段落" },
    ] as any;
    const callbacks = makeCallbacks("on", { "thread-a": turnsAt(0, round) });
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();
    service.beginPendingAnchor(context, "q", "thread-a");
    const anchor = await service.completeTurn(context, "thread-a", round, 0);
    // The digest is the free, synchronous first-paragraph fallback...
    expect(anchor?.answerSummary).toBe("核心结论在这里。");
    // ...and the annotation comment is the real transcript, independent of it.
    expect(host.created[0].comment).toBe("Q: q\n\nA: **核心**结论在这里。\n\n后续细节段落");
  });

  it("records the anchor without an annotation when consent is off", async () => {
    const host = makeHost();
    const callbacks = makeCallbacks("off");
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();
    service.beginPendingAnchor(context, "q", "thread-a");
    const anchor = await service.completeTurn(context, "thread-a", entries, 0);
    expect(anchor?.annotationKey).toBeUndefined();
    expect(host.createHighlight).not.toHaveBeenCalled();
    expect(callbacks.anchors).toHaveLength(1);
  });

  it("parks a consent request when consent is unset, then writes on accept", async () => {
    const host = makeHost();
    const callbacks = makeCallbacks("unset", { "thread-a": turnsAt(0, entries) });
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();
    service.beginPendingAnchor(context, "q", "thread-a");
    const anchor = await service.completeTurn(context, "thread-a", entries, 0);
    expect(anchor?.annotationKey).toBeUndefined();       // 先落记录,不写批注
    expect(service.consentRequest()).toMatchObject({ question: "q" });
    await service.resolveConsent(context, "accept");
    expect(callbacks.setConsent).toHaveBeenCalledWith("on");
    expect(host.createHighlight).toHaveBeenCalledTimes(1);
    expect(callbacks.anchors[0].annotationKey).toBe("ANN1");
    expect(service.consentRequest()).toBeNull();
  });

  it("extends turnRange on a typed follow-up with NO reattached selection, and rewrites the comment with both rounds (bug-triage #4 fix)", async () => {
    const host = makeHost();
    const round0 = [{ id: "u1", kind: "user", text: "第一问" }, { id: "a1", kind: "assistant", text: "第一答" }] as any;
    const round1 = [{ id: "u2", kind: "user", text: "第二问(未选中文字追问)" }, { id: "a2", kind: "assistant", text: "第二答" }] as any;
    const callbacks = makeCallbacks("on", { "thread-a": turnsWith({ 0: round0, 1: round1 }) });
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();

    service.beginPendingAnchor(context, "第一问", "thread-a");
    const anchor = await service.completeTurn(context, "thread-a", round0, 0);
    expect(anchor?.turnRange).toEqual([0, 0]);
    expect(host.created[0].comment).toBe("Q: 第一问\n\nA: 第一答");

    // No beginPendingAnchor call here: simulates a typed follow-up with no
    // selection reattached -- exactly the gap bug-triage report #4 found.
    const extended = await service.completeTurn(context, "thread-a", round1, 1);

    expect(extended?.turnRange).toEqual([0, 1]);
    expect(callbacks.anchors[0].turnRange).toEqual([0, 1]);
    expect(host.createHighlight).toHaveBeenCalledTimes(1);   // no second annotation created
    expect(host.updateAnnotationComment).toHaveBeenCalledTimes(1);
    expect(host.updateAnnotationComment).toHaveBeenCalledWith(
      1, "ANN1", "Q: 第一问\n\nA: 第一答\n\nQ: 第二问(未选中文字追问)\n\nA: 第二答",
    );
  });

  it("skips duplicate anchors for the same thread + selection, extends turnRange and rewrites the comment instead", async () => {
    const host = makeHost();
    const round0 = [{ id: "u1", kind: "user", text: "q1" }, { id: "a1", kind: "assistant", text: "a1" }] as any;
    const round1 = [{ id: "u2", kind: "user", text: "追问" }, { id: "a2", kind: "assistant", text: "a2" }] as any;
    const callbacks = makeCallbacks("on", { "thread-a": turnsWith({ 0: round0, 1: round1 }) });
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();
    service.beginPendingAnchor(context, "q1", "thread-a");
    await service.completeTurn(context, "thread-a", round0, 0);
    service.beginPendingAnchor(context, "追问", "thread-a");  // 同选区
    await service.completeTurn(context, "thread-a", round1, 1);
    expect(callbacks.anchors).toHaveLength(1);
    expect(callbacks.anchors[0].turnRange).toEqual([0, 1]);
    expect(host.createHighlight).toHaveBeenCalledTimes(1);
    expect(host.updateAnnotationComment).toHaveBeenCalledWith(1, "ANN1", "Q: q1\n\nA: a1\n\nQ: 追问\n\nA: a2");
  });

  it("does NOT extend a resolved anchor on a later same-thread turn", async () => {
    const host = makeHost();
    const round0 = [{ id: "u1", kind: "user", text: "q" }, { id: "a1", kind: "assistant", text: "ans" }] as any;
    const callbacks = makeCallbacks("on", { "thread-a": turnsAt(0, round0) });
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();

    service.beginPendingAnchor(context, "q", "thread-a");
    const anchor = await service.completeTurn(context, "thread-a", round0, 0);
    await service.resolveAnchor(context, anchor!.anchorId);
    expect(callbacks.anchors[0].status).toBe("resolved");

    const round1 = [{ id: "u2", kind: "user", text: "追问" }, { id: "a2", kind: "assistant", text: "ans2" }] as any;
    const result = await service.completeTurn(context, "thread-a", round1, 1);   // typed follow-up, no selection
    expect(result).toBeNull();
    expect(callbacks.anchors[0].turnRange).toEqual([0, 0]);
    expect(host.updateAnnotationComment).not.toHaveBeenCalled();
  });

  it("does NOT extend an anchor when a DIFFERENT thread's turn completes", async () => {
    const host = makeHost();
    const round0 = [{ id: "u1", kind: "user", text: "q" }, { id: "a1", kind: "assistant", text: "ans" }] as any;
    const callbacks = makeCallbacks("on", { "thread-a": turnsAt(0, round0) });
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();

    service.beginPendingAnchor(context, "q", "thread-a");
    await service.completeTurn(context, "thread-a", round0, 0);

    const otherRound = [{ id: "u9", kind: "user", text: "别的问题" }, { id: "a9", kind: "assistant", text: "别的回答" }] as any;
    const result = await service.completeTurn(context, "thread-b", otherRound, 0);   // different thread, no open anchor there
    expect(result).toBeNull();
    expect(callbacks.anchors[0].turnRange).toEqual([0, 0]);   // thread-a's anchor is untouched
    expect(host.updateAnnotationComment).not.toHaveBeenCalled();
  });

  it("silently skips the comment rewrite when the annotation was deleted by hand, and keeps the write queue alive", async () => {
    const host = makeHost();
    const round0 = [{ id: "u1", kind: "user", text: "q" }, { id: "a1", kind: "assistant", text: "ans" }] as any;
    const round1 = [{ id: "u2", kind: "user", text: "追问" }, { id: "a2", kind: "assistant", text: "ans2" }] as any;
    const callbacks = makeCallbacks("on", { "thread-a": turnsWith({ 0: round0, 1: round1 }) });
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();

    service.beginPendingAnchor(context, "q", "thread-a");
    const anchor = await service.completeTurn(context, "thread-a", round0, 0);
    expect(anchor?.annotationKey).toBe("ANN1");

    host.updateAnnotationComment = vi.fn(async () => { throw new Error("Zotero item ANN1 is unavailable"); });

    // Typed follow-up, no selection -- thread-scoped extension path.
    const extended = await service.completeTurn(context, "thread-a", round1, 1);
    expect(extended?.turnRange).toEqual([0, 1]);                    // session-store patch still lands
    expect(callbacks.anchors[0].turnRange).toEqual([0, 1]);
    expect(host.updateAnnotationComment).toHaveBeenCalledTimes(1);  // attempted, then swallowed

    // Queue stays alive: a later queued operation still runs and completes normally.
    await service.resolveAnchor(context, anchor!.anchorId);
    expect(callbacks.anchors[0].status).toBe("resolved");
  });

  it("skips the comment rewrite (never blanks it) when the transcript read itself fails", async () => {
    const host = makeHost();
    const round0 = [{ id: "u1", kind: "user", text: "q" }, { id: "a1", kind: "assistant", text: "ans" }] as any;
    const callbacks = makeCallbacks("on", { "thread-a": turnsAt(0, round0) });
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();

    service.beginPendingAnchor(context, "q", "thread-a");
    const anchor = await service.completeTurn(context, "thread-a", round0, 0);
    expect(host.created[0].comment).toBe("Q: q\n\nA: ans");   // the good comment already written

    callbacks.readThreadTurns = vi.fn(async () => { throw new Error("app-server offline"); });

    // Typed follow-up, no selection -- thread-scoped extension path. The
    // session-store turnRange patch still lands (it doesn't need the
    // transcript), but the host comment is left exactly as it was --
    // never overwritten with an empty transcript.
    const extended = await service.completeTurn(context, "thread-a", round0, 1);
    expect(extended?.turnRange).toEqual([0, 1]);
    expect(callbacks.anchors[0].turnRange).toEqual([0, 1]);
    expect(host.updateAnnotationComment).not.toHaveBeenCalled();
    expect(anchor!.annotationKey).toBe("ANN1");   // unchanged; comment on the Zotero side was never touched
  });

  it("degrades to a minimal one-round comment (from record.question/answerSummary) when the transcript read fails during creation", async () => {
    const host = makeHost();
    const callbacks = makeCallbacks("on");   // no thread-a entry configured -> readThreadTurns default would be []
    callbacks.readThreadTurns = vi.fn(async () => { throw new Error("app-server offline"); });
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();
    const round0 = [
      { id: "u1", kind: "user", text: "q" },
      { id: "a1", kind: "assistant", text: "本轮答案" },
    ] as any;

    service.beginPendingAnchor(context, "q", "thread-a");
    const anchor = await service.completeTurn(context, "thread-a", round0, 0);

    // Still writes an annotation -- with a minimal comment built from data
    // already on hand (record.question + the synchronous summaryFallback
    // digest), not a blank one.
    expect(anchor?.annotationKey).toBe("ANN1");
    expect(host.created[0].comment).toBe("Q: q\n\nA: 本轮答案");
  });

  it("serializes concurrent turnRange extensions across threads without interleaving their comment rewrites", async () => {
    const host = makeHost();
    const roundA0 = [{ id: "ua0", kind: "user", text: "A0" }, { id: "aa0", kind: "assistant", text: "ansA0" }] as any;
    const roundA1 = [{ id: "ua1", kind: "user", text: "A1" }, { id: "aa1", kind: "assistant", text: "ansA1" }] as any;
    const roundB0 = [{ id: "ub0", kind: "user", text: "B0" }, { id: "ab0", kind: "assistant", text: "ansB0" }] as any;
    const roundB1 = [{ id: "ub1", kind: "user", text: "B1" }, { id: "ab1", kind: "assistant", text: "ansB1" }] as any;
    const callbacks = makeCallbacks("on", {
      "thread-a": turnsWith({ 0: roundA0, 1: roundA1 }),
      "thread-b": turnsWith({ 0: roundB0, 1: roundB1 }),
    });
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();
    const contextB: ReaderContext = { ...context, selection: { ...context.selection!, text: "另一段选中文字" } } as ReaderContext;

    service.beginPendingAnchor(context, "A0", "thread-a");
    await service.completeTurn(context, "thread-a", roundA0, 0);
    service.beginPendingAnchor(contextB, "B0", "thread-b");
    await service.completeTurn(contextB, "thread-b", roundB0, 0);
    expect(host.created.map((t) => t.attachmentKey)).toEqual(["ATTACH", "ATTACH"]);

    const order: string[] = [];
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      return { promise, resolve };
    };
    const gate = deferred();
    host.updateAnnotationComment = vi.fn(async (_libraryID: any, annotationKey: string) => {
      order.push(`start-${annotationKey}`);
      if (annotationKey === "ANN1") await gate.promise;
      order.push(`end-${annotationKey}`);
    });

    // Two typed follow-ups (no selection reattached) racing on different threads.
    const extendA = service.completeTurn(context, "thread-a", roundA1, 1);
    const extendB = service.completeTurn(contextB, "thread-b", roundB1, 1);

    const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
    await flush();
    // B's rewrite must not start while A's is still in flight -- proving the
    // single service-wide queue serializes rather than interleaves.
    expect(order).toEqual(["start-ANN1"]);

    gate.resolve();
    await Promise.all([extendA, extendB]);
    await flush();
    expect(order).toEqual(["start-ANN1", "end-ANN1", "start-ANN2", "end-ANN2"]);
  });

  it("undo deletes the annotation and the record", async () => {
    const host = makeHost();
    const callbacks = makeCallbacks("on");
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();
    service.beginPendingAnchor(context, "q", "thread-a");
    const anchor = await service.completeTurn(context, "thread-a", entries, 0);
    await service.undoAnchor(context, anchor!.anchorId);
    expect(host.deleteAnnotation).toHaveBeenCalledWith(1, "ANN1");
    expect(callbacks.anchors).toHaveLength(0);
    expect(service.lastConfirmation()).toBeNull();
  });

  it("resolveAnchor swaps open→resolved tags exactly once", async () => {
    const host = makeHost();
    const callbacks = makeCallbacks("on");
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();
    service.beginPendingAnchor(context, "q", "thread-a");
    const anchor = await service.completeTurn(context, "thread-a", entries, 0);
    await service.resolveAnchor(context, anchor!.anchorId);
    expect(host.swapAnnotationTags).toHaveBeenCalledWith(1, "ANN1", ["zotkit-resolved"], ["zotkit-open"]);
    expect(callbacks.anchors[0].status).toBe("resolved");
    await service.resolveAnchor(context, anchor!.anchorId);   // 幂等
    expect(host.swapAnnotationTags).toHaveBeenCalledTimes(1);
  });

  it("accept backfills every record-only anchor for the paper, not just the parked one (MUST 1)", async () => {
    const host = makeHost();
    const q1Round = [{ id: "u1", kind: "user", text: "q1" }, { id: "a1", kind: "assistant", text: "a1 答案" }] as any;
    const q2Round = [{ id: "u2", kind: "user", text: "q2" }, { id: "a2", kind: "assistant", text: "a2 答案" }] as any;
    const callbacks = makeCallbacks("unset", { "thread-a": turnsWith({ 0: q1Round, 1: q2Round }) });
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();

    service.beginPendingAnchor(context, "q1", "thread-a");
    await service.completeTurn(context, "thread-a", q1Round, 0);   // parks (record #1)

    // A second question while still unset: per the existing "first parked
    // request kept" comment, this stays record-only without re-parking --
    // but it must still be backfilled once the user accepts.
    const context2 = { ...context, selection: { ...context.selection!, text: "另一段选中文字" } };
    service.beginPendingAnchor(context2, "q2", "thread-a");
    await service.completeTurn(context2, "thread-a", q2Round, 1);   // record-only (record #2)

    expect(callbacks.anchors).toHaveLength(2);
    expect(callbacks.anchors.every((a: any) => a.annotationKey === undefined)).toBe(true);
    expect(service.consentRequest()).toMatchObject({ question: "q1" });

    await service.resolveConsent(context, "accept");

    expect(host.createHighlight).toHaveBeenCalledTimes(2);
    expect(callbacks.anchors[0].annotationKey).toBe("ANN1");
    expect(callbacks.anchors[1].annotationKey).toBe("ANN2");
  });

  it("accept isolates a single anchor's write failure -- the rest still get backfilled (MUST 1)", async () => {
    const host = makeHost();
    const q1Round = [{ id: "u1", kind: "user", text: "q1" }, { id: "a1", kind: "assistant", text: "a1 答案" }] as any;
    const q2Round = [{ id: "u2", kind: "user", text: "q2" }, { id: "a2", kind: "assistant", text: "a2 答案" }] as any;
    host.createHighlight = vi.fn(async (target: any) => {
      if (target.attachmentKey === "ATTACH" && target.comment.startsWith("Q: q1")) {
        throw new Error("Zotero write failed");
      }
      return "ANN-ok";
    });
    const callbacks = makeCallbacks("unset", { "thread-a": turnsWith({ 0: q1Round, 1: q2Round }) });
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();

    service.beginPendingAnchor(context, "q1", "thread-a");
    await service.completeTurn(context, "thread-a", q1Round, 0);
    const context2 = { ...context, selection: { ...context.selection!, text: "另一段选中文字" } };
    service.beginPendingAnchor(context2, "q2", "thread-a");
    await service.completeTurn(context2, "thread-a", q2Round, 1);

    await service.resolveConsent(context, "accept");

    expect(host.createHighlight).toHaveBeenCalledTimes(2);
    expect(callbacks.anchors[0].annotationKey).toBeUndefined();   // failed write: no key
    expect(callbacks.anchors[1].annotationKey).toBe("ANN-ok");    // isolated: still written
  });

  it("acceptance: A/B identity snapshot -- the Zotero write and recorded anchor always carry the ORIGINAL selection context's identity, even when a different context is passed to completeTurn (MUST 3)", async () => {
    const host = makeHost();
    const callbacks = makeCallbacks("on", { "thread-a": turnsAt(0, entries) });
    const service = new PaperTrailService(host, callbacks, () => new Date("2026-07-25T01:00:00Z"), (p) => `${p}-1`);
    const contextA = trailContext();   // attachment key ATTACH, library 1
    service.beginPendingAnchor(contextA, "q", "thread-a");

    const contextB: ReaderContext = {
      ...contextA,
      attachment: { ...(contextA as any).attachment, key: "OTHER_ATTACH", libraryID: 2 },
    } as ReaderContext;

    const anchor = await service.completeTurn(contextB, "thread-a", entries, 0);

    // The Zotero write landed under A's identity, not B's.
    expect(host.created[0]).toMatchObject({ libraryID: 1, attachmentKey: "ATTACH" });
    // The recorded anchor itself carries A's identity too.
    expect(anchor).toMatchObject({ libraryID: 1, attachmentKey: "ATTACH" });
    expect(callbacks.anchors[0]).toMatchObject({ libraryID: 1, attachmentKey: "ATTACH" });
  });

  it("skips highlight silently when the selection has no position", async () => {
    const host = makeHost();
    const callbacks = makeCallbacks("on");
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();
    (context as any).selection = { text: "裸文本", capturedAt: "2026-07-25T00:00:00.000Z" };
    service.beginPendingAnchor(context, "q", "thread-a");
    const anchor = await service.completeTurn(context, "thread-a", entries, 0);
    expect(anchor).not.toBeNull();
    expect(anchor?.annotationKey).toBeUndefined();
    expect(host.createHighlight).not.toHaveBeenCalled();
  });
});
