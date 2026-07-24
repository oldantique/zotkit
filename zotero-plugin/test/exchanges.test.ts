import { describe, expect, it } from "vitest";
import {
  activityLabel, contentEntries, formatElapsed, friendlyToolName,
  groupEntries, processEntries,
} from "../src/exchanges";
import type { ChatEntry } from "../src/sidebar";

const e = (id: string, kind: ChatEntry["kind"], extra: Partial<ChatEntry> = {}): ChatEntry =>
  ({ id, kind, text: "", ...extra }) as ChatEntry;

describe("groupEntries", () => {
  it("splits before each user entry and keeps a preamble group", () => {
    const groups = groupEntries([
      e("s1", "status"), e("u1", "user"), e("r1", "reasoning"), e("a1", "assistant"),
      e("u2", "user"), e("t1", "tool"), e("a2", "assistant"),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["preamble", "u1", "u2"]);
    expect(groups[1]!.entries.map((x) => x.id)).toEqual(["u1", "r1", "a1"]);
    expect(processEntries(groups[2]!).map((x) => x.id)).toEqual(["t1"]);
    expect(contentEntries(groups[2]!).map((x) => x.id)).toEqual(["u2", "a2"]);
  });
});

describe("activityLabel", () => {
  it("labels the latest running entry by kind", () => {
    expect(activityLabel([e("r", "reasoning", { state: "running" })])).toBe("思考中…");
    expect(activityLabel([
      e("r", "reasoning", { state: "complete" }),
      e("t", "tool", { state: "running", title: "zotero_read_pdf_pages" }),
    ])).toBe("正在调用 读取论文页面");
    expect(activityLabel([e("c", "command", { state: "running" })])).toBe("执行命令…");
    expect(activityLabel([e("a", "assistant", { state: "running" })])).toBe("正在撰写回答…");
    expect(activityLabel([e("a", "assistant", { state: "complete" })])).toBe("思考中…");
  });
});

describe("friendlyToolName / formatElapsed", () => {
  it("maps known tools and passes through unknown ones", () => {
    expect(friendlyToolName("zotero_search_current_pdf")).toBe("检索本篇 PDF");
    expect(friendlyToolName("unknown_tool")).toBe("unknown_tool");
  });
  it("formats seconds and minutes", () => {
    expect(formatElapsed(4_200)).toBe("4s");
    expect(formatElapsed(102_000)).toBe("1m 42s");
    expect(formatElapsed(500)).toBe("1s"); // 向上取整,不显示 0s
  });
});
