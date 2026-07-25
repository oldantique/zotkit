// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildFrontMatter, buildNotingPrompt, countMathErrors, notingFileName } from "../src/noting";

const snapshot = {
  paperTitle: "Attention Is All You Need",
  itemKey: "PARENT", attachmentKey: "ATTACH", libraryID: 1,
  pdfSha256Now: "abc", hashMismatch: false,
  anchors: [{
    anchorId: "a1", pageNumber: 7, status: "open" as const, question: "为什么?",
    answerSummary: "要点。", qa: [{ question: "为什么?", answerMarkdown: "因为 $x$。" }],
  }],
  userAnnotations: [{ pageNumber: 2, type: "highlight", text: "画线原文", comment: "我的想法" }],
  createdAt: "2026-07-25T02:00:00.000Z",
};

describe("buildNotingPrompt", () => {
  it("contains the template sections, page-ordered QA, and open-question rules", () => {
    const prompt = buildNotingPrompt(snapshot);
    for (const heading of ["# Citation", "# One-sentence Takeaway", "# Method", "# Key Equations", "# Reading Q&A", "# Open Questions", "# My Understanding"]) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain("[p.7]");
    expect(prompt).toContain("(推导)");
    expect(prompt).toContain("<untrusted_paper_content>");   // 用户批注包裹
    expect(prompt.indexOf("<untrusted_paper_content>")).toBeLessThan(prompt.indexOf("画线原文"));
  });
});

describe("countMathErrors", () => {
  it("counts KaTeX failures and passes valid formulas", () => {
    expect(countMathErrors(document, "好公式 $e=mc^2$")).toBe(0);
    expect(countMathErrors(document, "坏公式 $\\notARealCommand{$ 和 $x$")).toBe(1);
  });
});

describe("buildFrontMatter", () => {
  it("emits yaml with identity, hash, counts", () => {
    const yaml = buildFrontMatter(snapshot, "gpt-5", 1);
    expect(yaml.startsWith("---\n")).toBe(true);
    expect(yaml).toContain("zotero_item_key: PARENT");
    expect(yaml).toContain("attachment_key: ATTACH");
    expect(yaml).toContain("paper_sha256: abc");
    expect(yaml).toContain("anchor_count: 1");
    expect(yaml).toContain("open_questions: 1");
    expect(yaml).toContain("math_errors: 1");
    expect(yaml).toContain("model: gpt-5");
    expect(yaml.trimEnd().endsWith("---")).toBe(true);
  });
});

describe("notingFileName", () => {
  it("slugs the title and stamps the date", () => {
    expect(notingFileName("Attention Is All You Need!", new Date("2026-07-25T00:00:00Z")))
      .toBe("Attention-Is-All-You-Need-reading-notes-20260725.md");
  });
  it("falls back for empty titles", () => {
    expect(notingFileName("  ", new Date("2026-07-25T00:00:00Z"))).toBe("paper-reading-notes-20260725.md");
  });
});
