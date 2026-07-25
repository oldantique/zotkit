import type { JsonValue } from "./reader-context";

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
