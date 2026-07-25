import { describe, expect, it, vi } from "vitest";
import {
  buildAnchorComment,
  computeSortIndex,
  PaperTrailService,
  summaryFallback,
  type AnchorHost,
  type PaperTrailCallbacks,
} from "../src/paper-trail";
import type { ReaderContext } from "../src/reader-context";

describe("buildAnchorComment", () => {
  it("joins question and summary, and never embeds ids", () => {
    expect(buildAnchorComment("为什么用 KL 散度?", "因为它衡量分布差异。")).toBe(
      "Q: 为什么用 KL 散度?\n\n因为它衡量分布差异。",
    );
  });
  it("caps question at 600 and summary at 900 characters", () => {
    const comment = buildAnchorComment("问".repeat(700), "答".repeat(1000));
    expect(comment).toContain("问".repeat(600));
    expect(comment).not.toContain("问".repeat(601));
    expect(comment).toContain("答".repeat(900));
    expect(comment).not.toContain("答".repeat(901));
  });
  it("omits the summary block when the summary is empty", () => {
    expect(buildAnchorComment("q", "  ")).toBe("Q: q");
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
    deleteAnnotation: vi.fn(async () => {}),
    annotationExists: vi.fn(async () => true),
    resolveParentItemKey: vi.fn(async () => "PARENT"),
    attachmentFile: vi.fn(async () => null),   // pdfSha256 → null 路径
  };
}

function makeCallbacks(consent: string): PaperTrailCallbacks & { anchors: any[] } {
  const anchors: any[] = [];
  let consentValue = consent;
  return {
    anchors,
    onState: vi.fn(),
    summarize: vi.fn(async () => "两句要点。"),
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

const entries = [
  { id: "u1", kind: "user", text: "为什么?" },
  { id: "a1", kind: "assistant", text: "因为注意力矩阵……", state: "complete" },
] as any;

describe("PaperTrailService", () => {
  it("writes a highlight with comment, color, tags after the first completed turn (consent on)", async () => {
    const host = makeHost();
    const callbacks = makeCallbacks("on");
    const service = new PaperTrailService(host, callbacks, () => new Date("2026-07-25T01:00:00Z"), (p) => `${p}-1`);
    const context = trailContext();
    service.beginPendingAnchor(context, "为什么?", "thread-a");
    const anchor = await service.completeTurn(context, "thread-a", entries, 4);
    expect(anchor).toMatchObject({
      annotationKey: "ANN1", pageNumber: 7, status: "open", turnRange: [4, 4],
      itemKey: "PARENT", question: "为什么?", answerSummary: "两句要点。",
    });
    expect(host.created[0]).toMatchObject({
      color: "#a28ae5", pageLabel: "7", sortIndex: "00006|000000|09287",
      comment: "Q: 为什么?\n\n两句要点。", tags: ["zotkit-chat", "zotkit-open"],
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

  it("uses the fallback summary when summarize fails", async () => {
    const host = makeHost();
    const callbacks = makeCallbacks("on");
    (callbacks.summarize as any).mockResolvedValue(null);
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();
    service.beginPendingAnchor(context, "q", "thread-a");
    await service.completeTurn(context, "thread-a", entries, 0);
    expect(host.created[0].comment).toBe("Q: q\n\n因为注意力矩阵……");
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
    const callbacks = makeCallbacks("unset");
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

  it("skips duplicate anchors for the same thread + selection, extends turnRange instead", async () => {
    const host = makeHost();
    const callbacks = makeCallbacks("on");
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();
    service.beginPendingAnchor(context, "q1", "thread-a");
    await service.completeTurn(context, "thread-a", entries, 0);
    service.beginPendingAnchor(context, "追问", "thread-a");  // 同选区
    await service.completeTurn(context, "thread-a", entries, 1);
    expect(callbacks.anchors).toHaveLength(1);
    expect(callbacks.anchors[0].turnRange).toEqual([0, 1]);
    expect(host.createHighlight).toHaveBeenCalledTimes(1);
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
    const callbacks = makeCallbacks("unset");
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();

    service.beginPendingAnchor(context, "q1", "thread-a");
    await service.completeTurn(context, "thread-a", entries, 0);   // parks (record #1)

    // A second question while still unset: per the existing "first parked
    // request kept" comment, this stays record-only without re-parking --
    // but it must still be backfilled once the user accepts.
    const context2 = { ...context, selection: { ...context.selection!, text: "另一段选中文字" } };
    service.beginPendingAnchor(context2, "q2", "thread-a");
    await service.completeTurn(context2, "thread-a", entries, 1);   // record-only (record #2)

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
    host.createHighlight = vi.fn(async (target: any) => {
      if (target.attachmentKey === "ATTACH" && target.comment.startsWith("Q: q1")) {
        throw new Error("Zotero write failed");
      }
      return "ANN-ok";
    });
    const callbacks = makeCallbacks("unset");
    const service = new PaperTrailService(host, callbacks);
    const context = trailContext();

    service.beginPendingAnchor(context, "q1", "thread-a");
    await service.completeTurn(context, "thread-a", entries, 0);
    const context2 = { ...context, selection: { ...context.selection!, text: "另一段选中文字" } };
    service.beginPendingAnchor(context2, "q2", "thread-a");
    await service.completeTurn(context2, "thread-a", entries, 1);

    await service.resolveConsent(context, "accept");

    expect(host.createHighlight).toHaveBeenCalledTimes(2);
    expect(callbacks.anchors[0].annotationKey).toBeUndefined();   // failed write: no key
    expect(callbacks.anchors[1].annotationKey).toBe("ANN-ok");    // isolated: still written
  });

  it("acceptance: A/B identity snapshot -- the Zotero write and recorded anchor always carry the ORIGINAL selection context's identity, even when a different context is passed to completeTurn (MUST 3)", async () => {
    const host = makeHost();
    const callbacks = makeCallbacks("on");
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
