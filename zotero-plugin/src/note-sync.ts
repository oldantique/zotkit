import { contentEntries, formatElapsed, groupEntries } from "./exchanges";
import { escapeHtml, markdownToNoteHtml } from "./markdown";
import type { ChatEntry } from "./sidebar";

/** Tag placed on the per-item Zotero note that auto-syncs chat Q&A. */
export const NOTE_SYNC_TAG = "zotkit-chat";

const HEADING_SPLIT_RE = /<h2\b[^>]*>[\s\S]*?(?=<h2\b|$)/g;
const HEADING_OPEN_RE = /^<h2\b([^>]*)>([\s\S]*?)<\/h2>/;
const THREAD_ATTR_RE = /data-zotkit-thread="([^"]*)"/;
const DATE_SUFFIX_RE = / · ([^·]+)$/;
const STRIP_TAGS_RE = /<[^>]+>/g;

export interface NoteExchange {
  question: string;
  answerMarkdown: string;
  meta?: { completedAt?: string; model?: string; elapsedMs?: number };
}

export interface NoteThreadSection {
  threadId: string;
  title: string;
  /** e.g. "2026-07-23" — the date a section was first created; merges reuse the existing one. */
  dateLabel: string;
  exchanges: NoteExchange[];
}

export interface ExchangeMeta {
  elapsedMs?: number;
  completedAt?: string;
  model?: string;
}

interface ParsedSection {
  raw: string;
  threadId: string | null;
  headingText: string;
  dateLabel: string | null;
}

/**
 * Turns raw chat entries into the Q&A pairs a note section is built from.
 * Groups without a completed assistant answer (dangling questions, or a
 * leading run of process entries with no user turn) are dropped.
 */
export function buildExchangesFromEntries(
  entries: ChatEntry[],
  meta: ReadonlyMap<string, ExchangeMeta> | undefined,
): NoteExchange[] {
  const exchanges: NoteExchange[] = [];
  for (const group of groupEntries(entries)) {
    const userEntry = group.entries.find((entry) => entry.kind === "user");
    if (!userEntry) continue;
    const assistantEntries = contentEntries(group).filter((entry) => entry.kind === "assistant");
    if (!assistantEntries.length) continue;
    const answerMarkdown = assistantEntries.map((entry) => entry.text).join("\n\n");
    const exchangeMeta = meta?.get(userEntry.id);
    exchanges.push({
      question: userEntry.text,
      answerMarkdown,
      ...(exchangeMeta ? { meta: exchangeMeta } : {}),
    });
  }
  return exchanges;
}

/**
 * Merges freshly-synced thread sections into the note's existing HTML body.
 * The H1 is always regenerated from `paperTitle`. Existing `<h2>` sections are
 * kept in their original order; a section whose `data-zotkit-thread` (or,
 * failing that, its heading-text `${title} · ` prefix) matches an incoming
 * section is rebuilt with the new content but keeps its original date label.
 * Sections present only in `sections` are appended, in argument order.
 */
export function mergeChatNoteHtml(
  existingHtml: string | null,
  paperTitle: string,
  sections: readonly NoteThreadSection[],
): string {
  const h1 = `<h1>AI 研究笔记 — ${escapeHtml(paperTitle)}</h1>`;
  const existingSections = parseExistingSections(existingHtml);
  const consumed = new Set<number>();

  const rebuilt = existingSections.map((parsed) => {
    const matchIndex = sections.findIndex(
      (section, index) => !consumed.has(index) && matchesSection(parsed, section),
    );
    if (matchIndex === -1) return parsed.raw;
    consumed.add(matchIndex);
    const section = sections[matchIndex]!;
    const dateLabel = parsed.dateLabel ?? section.dateLabel;
    return renderSection({ ...section, dateLabel });
  });

  const appended = sections
    .filter((_, index) => !consumed.has(index))
    .map((section) => renderSection(section));

  return [h1, ...rebuilt, ...appended].join("");
}

function matchesSection(parsed: ParsedSection, section: NoteThreadSection): boolean {
  if (parsed.threadId !== null) return parsed.threadId === section.threadId;
  return parsed.headingText.startsWith(`${section.title} · `);
}

function parseExistingSections(existingHtml: string | null): ParsedSection[] {
  if (!existingHtml) return [];
  const blocks = existingHtml.match(HEADING_SPLIT_RE) ?? [];
  return blocks.map((raw) => {
    const headingMatch = HEADING_OPEN_RE.exec(raw);
    const attrs = headingMatch?.[1] ?? "";
    const headingText = (headingMatch?.[2] ?? "").replace(STRIP_TAGS_RE, "");
    const threadIdMatch = THREAD_ATTR_RE.exec(attrs);
    const dateMatch = DATE_SUFFIX_RE.exec(headingText);
    return {
      raw,
      threadId: threadIdMatch ? threadIdMatch[1]! : null,
      headingText,
      dateLabel: dateMatch ? dateMatch[1]!.trim() : null,
    };
  });
}

function renderSection(section: NoteThreadSection): string {
  const heading = `<h2 data-zotkit-thread="${escapeHtml(section.threadId)}">`
    + `${escapeHtml(section.title)} · ${escapeHtml(section.dateLabel)}</h2>`;
  const rounds = section.exchanges.map((exchange) => {
    const parts = [
      `<p><strong>Q:</strong> ${escapeHtml(exchange.question)}</p>`,
      markdownToNoteHtml(exchange.answerMarkdown),
    ];
    const metaLine = renderMetaLine(exchange.meta);
    if (metaLine) parts.push(metaLine);
    return parts.join("");
  });
  return heading + rounds.join("<hr>");
}

function renderMetaLine(meta: NoteExchange["meta"]): string {
  if (!meta) return "";
  const parts: string[] = [];
  const localized = meta.completedAt ? formatLocalDateTime(meta.completedAt) : null;
  if (localized) parts.push(localized);
  if (meta.model) parts.push(meta.model);
  if (typeof meta.elapsedMs === "number") parts.push(formatElapsed(meta.elapsedMs));
  if (!parts.length) return "";
  return `<p><em>${escapeHtml(parts.join(" · "))}</em></p>`;
}

function formatLocalDateTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Resolves the top-level library item a chat note should be attached to. */
function resolveTopLevelItem(readerItem: any): any {
  if (!readerItem) return null;
  const parent = readerItem.parentItem ?? readerItem;
  return parent.topLevelItem ?? parent;
}

function findTaggedNote(zotero: any, top: any): any {
  const noteIDs: unknown[] = typeof top.getNotes === "function" ? top.getNotes() ?? [] : [];
  for (const id of noteIDs) {
    const candidate = zotero.Items?.get?.(id);
    if (!candidate || typeof candidate.getTags !== "function") continue;
    const tags = candidate.getTags() ?? [];
    if (Array.isArray(tags) && tags.some((tag: any) => tag?.tag === NOTE_SYNC_TAG)) return candidate;
  }
  return null;
}

/**
 * Writes the merged chat-note HTML back to Zotero: updates the child note
 * already tagged `zotkit-chat` under the resolved top-level item, or creates
 * one if none exists yet. All failures are swallowed after being logged —
 * note sync is a best-effort side effect and must never surface to the caller.
 */
export async function syncChatNote(deps: {
  zotero: any;
  readerItem: any;
  paperTitle: string;
  section: NoteThreadSection;
}): Promise<void> {
  const { zotero, readerItem, paperTitle, section } = deps;
  try {
    const top = resolveTopLevelItem(readerItem);
    if (!top) return;

    const existingNote = findTaggedNote(zotero, top);
    if (existingNote) {
      const existingHtml = typeof existingNote.getNote === "function" ? existingNote.getNote() : null;
      const merged = mergeChatNoteHtml(existingHtml ?? null, paperTitle, [section]);
      existingNote.setNote(merged);
      await existingNote.saveTx();
      return;
    }

    const merged = mergeChatNoteHtml(null, paperTitle, [section]);
    const note = new zotero.Item("note");
    note.libraryID = top.libraryID;
    note.parentKey = top.key;
    note.setNote(merged);
    note.addTag(NOTE_SYNC_TAG);
    await note.saveTx();
  }
  catch (error) {
    zotero.debug?.(`[Zotkit] note-sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
