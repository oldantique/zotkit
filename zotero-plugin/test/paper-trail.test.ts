import { describe, expect, it } from "vitest";
import { buildAnchorComment, computeSortIndex, summaryFallback } from "../src/paper-trail";

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
