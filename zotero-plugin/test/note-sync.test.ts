import { describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "../src/sidebar";
import {
  buildExchangesFromEntries,
  mergeChatNoteHtml,
  syncChatNote,
  type ExchangeMeta,
  type NoteThreadSection,
} from "../src/note-sync";

describe("buildExchangesFromEntries", () => {
  it("keeps only completed Q&A pairs and attaches meta", () => {
    const meta = new Map<string, ExchangeMeta>([
      ["u1", { elapsedMs: 28_000, completedAt: "2026-07-23T10:00:28Z", model: "gpt-5-codex" }],
    ]);
    const out = buildExchangesFromEntries([
      { id: "u1", kind: "user", text: "问一" },
      { id: "r1", kind: "reasoning", text: "…", state: "complete" },
      { id: "a1", kind: "assistant", text: "答一", state: "complete" },
      { id: "u2", kind: "user", text: "悬空问题" },
    ] as ChatEntry[], meta);

    expect(out).toEqual([
      {
        question: "问一",
        answerMarkdown: "答一",
        meta: { elapsedMs: 28_000, completedAt: "2026-07-23T10:00:28Z", model: "gpt-5-codex" },
      },
    ]);
  });

  it("joins multiple assistant entries in one turn with a blank line", () => {
    const out = buildExchangesFromEntries([
      { id: "u1", kind: "user", text: "问" },
      { id: "a1", kind: "assistant", text: "第一段", state: "complete" },
      { id: "a2", kind: "assistant", text: "第二段", state: "complete" },
    ] as ChatEntry[], undefined);

    expect(out).toEqual([{ question: "问", answerMarkdown: "第一段\n\n第二段" }]);
  });

  it("returns an empty array when there are no entries", () => {
    expect(buildExchangesFromEntries([], undefined)).toEqual([]);
  });
});

describe("mergeChatNoteHtml", () => {
  const section: NoteThreadSection = {
    threadId: "th1",
    title: "主线程",
    dateLabel: "2026-07-23",
    exchanges: [{ question: "问", answerMarkdown: "**答**" }],
  };

  it("creates a fresh note body", () => {
    const html = mergeChatNoteHtml(null, "论文A", [section]);
    expect(html).toContain("<h1>AI 研究笔记 — 论文A</h1>");
    expect(html).toContain('<h2 data-zotkit-thread="th1">主线程 · 2026-07-23</h2>');
    expect(html).toContain("<p><strong>Q:</strong> 问</p>");
    expect(html).toContain("<p><strong>答</strong></p>");
  });

  it("escapes question text and the paper title", () => {
    const html = mergeChatNoteHtml(null, "论文<A>&B", [
      { ...section, exchanges: [{ question: "<script>alert(1)</script>", answerMarkdown: "答" }] },
    ]);
    expect(html).toContain("论文&lt;A&gt;&amp;B");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders a meta line with completedAt, model and elapsed time, omitting missing fields", () => {
    const html = mergeChatNoteHtml(null, "论文A", [
      {
        ...section,
        exchanges: [{
          question: "问",
          answerMarkdown: "答",
          meta: { completedAt: "2026-07-23T10:00:28Z", model: "gpt-5-codex", elapsedMs: 28_000 },
        }],
      },
    ]);
    expect(html).toMatch(/<p><em>\d{4}-\d{2}-\d{2} \d{2}:\d{2} · gpt-5-codex · 28s<\/em><\/p>/);

    const htmlNoModel = mergeChatNoteHtml(null, "论文A", [
      {
        ...section,
        exchanges: [{
          question: "问",
          answerMarkdown: "答",
          meta: { elapsedMs: 5_000 },
        }],
      },
    ]);
    expect(htmlNoModel).toContain("<p><em>5s</em></p>");
    expect(htmlNoModel).not.toContain("undefined");
  });

  it("omits the meta line entirely when meta is absent", () => {
    const html = mergeChatNoteHtml(null, "论文A", [section]);
    expect(html).not.toContain("<em>");
  });

  it("separates multiple exchanges with <hr> but not after the last", () => {
    const html = mergeChatNoteHtml(null, "论文A", [
      {
        ...section,
        exchanges: [
          { question: "问一", answerMarkdown: "答一" },
          { question: "问二", answerMarkdown: "答二" },
        ],
      },
    ]);
    expect(html.match(/<hr>/g)?.length ?? 0).toBe(1);
    expect(html.endsWith("<hr>")).toBe(false);
  });

  it("replaces the matching section, keeps unknown sections and appends new ones", () => {
    const existing = mergeChatNoteHtml(null, "论文A", [
      {
        threadId: "old",
        title: "旧线程",
        dateLabel: "2026-07-01",
        exchanges: [{ question: "旧问", answerMarkdown: "旧答" }],
      },
      {
        threadId: "th1",
        title: "主线程",
        dateLabel: "2026-07-20",
        exchanges: [{ question: "老", answerMarkdown: "老" }],
      },
    ]);
    const html = mergeChatNoteHtml(existing, "论文A", [
      section,
      {
        threadId: "th2",
        title: "新线程",
        dateLabel: "2026-07-23",
        exchanges: [{ question: "新", answerMarkdown: "新" }],
      },
    ]);
    expect(html).toContain("旧问"); // unmatched section retained
    expect(html).not.toContain("<p><strong>Q:</strong> 老</p>"); // matched section rebuilt
    expect(html).toContain("主线程 · 2026-07-20"); // keeps the existing section's date
    expect(html.indexOf("旧线程")).toBeLessThan(html.indexOf("主线程"));
    expect(html.indexOf("主线程")).toBeLessThan(html.indexOf("新线程"));
  });

  it("falls back to heading-text matching when the data attribute is stripped", () => {
    const stripped = mergeChatNoteHtml(null, "论文A", [
      { ...section, exchanges: [{ question: "老", answerMarkdown: "老" }] },
    ]).replace(' data-zotkit-thread="th1"', "");
    const html = mergeChatNoteHtml(stripped, "论文A", [section]);
    expect((html.match(/主线程/g) ?? []).length).toBe(1);
  });

  it("is idempotent: merging the same section twice does not duplicate it", () => {
    const once = mergeChatNoteHtml(null, "论文A", [section]);
    const twice = mergeChatNoteHtml(once, "论文A", [section]);
    expect(twice).toBe(once);
    expect((twice.match(/<h2\b/g) ?? []).length).toBe(1);
  });

  it("handles threadIds with special characters (escaped HTML): no duplicates on re-merge", () => {
    const specialSection: NoteThreadSection = {
      threadId: 'th"1&x',
      title: "线程",
      dateLabel: "2026-07-23",
      exchanges: [{ question: "问", answerMarkdown: "答" }],
    };
    const once = mergeChatNoteHtml(null, "论文A", [specialSection]);
    expect(once).toContain('data-zotkit-thread="th&quot;1&amp;x"');
    const twice = mergeChatNoteHtml(once, "论文A", [specialSection]);
    expect(twice).toBe(once);
    expect((twice.match(/<h2\b/g) ?? []).length).toBe(1);
  });

  it("builds a fresh body when existingHtml is an empty string", () => {
    const html = mergeChatNoteHtml("", "论文A", [section]);
    expect(html).toContain("<h1>AI 研究笔记 — 论文A</h1>");
    expect((html.match(/<h2\b/g) ?? []).length).toBe(1);
  });
});

describe("syncChatNote", () => {
  it("updates the tagged child note found via the resolved top-level item", async () => {
    const setNote = vi.fn();
    const saveTx = vi.fn(async () => {});
    const noteItem = {
      getTags: () => [{ tag: "zotkit-chat" }],
      getNote: () => "<h1>AI 研究笔记 — 论文A</h1>",
      setNote,
      saveTx,
    };
    const otherNote = { getTags: () => [{ tag: "other" }] };
    const topLevelItem = { libraryID: 1, key: "PARENT", getNotes: () => [10, 55] };
    const readerItem = { parentItem: { topLevelItem } };
    const itemsGet = vi.fn((id: number) => (id === 55 ? noteItem : id === 10 ? otherNote : null));
    const zotero = { Items: { get: itemsGet }, Item: vi.fn(), debug: vi.fn() };

    const section: NoteThreadSection = {
      threadId: "th1",
      title: "主线程",
      dateLabel: "2026-07-23",
      exchanges: [{ question: "问", answerMarkdown: "**答**" }],
    };

    await syncChatNote({ zotero, readerItem, paperTitle: "论文A", section });

    expect(setNote).toHaveBeenCalledOnce();
    expect(String(setNote.mock.calls[0]?.[0])).toContain('<h2 data-zotkit-thread="th1">');
    expect(saveTx).toHaveBeenCalledOnce();
    expect(zotero.Item).not.toHaveBeenCalled();
  });

  it("creates a new tagged note on the reader item itself when there is no tagged note or parent", async () => {
    const setNote = vi.fn();
    const addTag = vi.fn();
    const saveTx = vi.fn(async () => {});
    class FakeNoteItem {
      type: string;
      libraryID: unknown;
      parentKey: unknown;
      setNote = setNote;
      addTag = addTag;
      saveTx = saveTx;
      constructor(type: string) { this.type = type; }
    }
    const ItemCtor = vi.fn(FakeNoteItem);
    const readerItem = { libraryID: 2, key: "SOLO", getNotes: () => [] };
    const zotero = { Items: { get: vi.fn(() => null) }, Item: ItemCtor, debug: vi.fn() };

    const section: NoteThreadSection = {
      threadId: "th1",
      title: "主线程",
      dateLabel: "2026-07-23",
      exchanges: [{ question: "问", answerMarkdown: "答" }],
    };

    await syncChatNote({ zotero, readerItem, paperTitle: "论文A", section });

    expect(ItemCtor).toHaveBeenCalledWith("note");
    const created = ItemCtor.mock.results[0]?.value;
    expect(created.libraryID).toBe(2);
    expect(created.parentKey).toBe("SOLO");
    expect(addTag).toHaveBeenCalledWith("zotkit-chat");
    expect(setNote).toHaveBeenCalledOnce();
    expect(saveTx).toHaveBeenCalledOnce();
  });

  it("swallows write failures instead of throwing", async () => {
    const noteItem = {
      getTags: () => [{ tag: "zotkit-chat" }],
      getNote: () => null,
      setNote: vi.fn(),
      saveTx: vi.fn(async () => { throw new Error("write failed"); }),
    };
    const readerItem = { parentItem: { libraryID: 1, key: "PARENT", getNotes: () => [55] } };
    const debug = vi.fn();
    const zotero = { Items: { get: () => noteItem }, Item: vi.fn(), debug };

    const section: NoteThreadSection = {
      threadId: "th1",
      title: "主线程",
      dateLabel: "2026-07-23",
      exchanges: [{ question: "问", answerMarkdown: "答" }],
    };

    await expect(
      syncChatNote({ zotero, readerItem, paperTitle: "论文A", section }),
    ).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalled();
  });

  it("does nothing when there is no reader item to resolve", async () => {
    const zotero = { Items: { get: vi.fn() }, Item: vi.fn(), debug: vi.fn() };
    const section: NoteThreadSection = {
      threadId: "th1",
      title: "主线程",
      dateLabel: "2026-07-23",
      exchanges: [{ question: "问", answerMarkdown: "答" }],
    };

    await expect(
      syncChatNote({ zotero, readerItem: null, paperTitle: "论文A", section }),
    ).resolves.toBeUndefined();
    expect(zotero.Item).not.toHaveBeenCalled();
  });
});
