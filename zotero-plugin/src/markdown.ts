import katex from "katex";

const TABLE_DIVIDER = /^:?-{3,}:?$/;
const UNSAFE_KATEX_ELEMENTS = [
  "a",
  "audio",
  "base",
  "button",
  "embed",
  "form",
  "foreignObject",
  "iframe",
  "img",
  "input",
  "link",
  "meta",
  "object",
  "option",
  "script",
  "select",
  "source",
  "style",
  "textarea",
  "track",
  "video",
].join(",");
const UNSAFE_URL_ATTRIBUTES = new Set(["href", "src", "srcset", "xlink:href"]);

interface MathBlock {
  expression: string;
  nextIndex: number;
  opening: "$$" | "\\[";
}

interface MarkdownLink {
  label: string;
  destination: string;
  end: number;
}

export function renderMarkdown(doc: Document, markdown: string): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] || "";
    if (line.startsWith("```")) {
      index = appendCodeBlock(doc, fragment, lines, index);
      continue;
    }

    const mathBlock = readMathBlock(lines, index);
    if (mathBlock) {
      appendMath(doc, fragment, mathBlock.expression, true, mathBlock.opening);
      index = mathBlock.nextIndex;
      continue;
    }

    const table = readTable(lines, index);
    if (table) {
      fragment.appendChild(renderTable(doc, table.header, table.alignments, table.rows));
      index = table.nextIndex;
      continue;
    }

    if (!line.trim()) {
      index++;
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(4, heading[1]?.length || 2);
      const element = doc.createElement(`h${level}`);
      appendInline(doc, element, heading[2] || "");
      fragment.appendChild(element);
      index++;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const list = doc.createElement("ul");
      while (index < lines.length && /^[-*]\s+/.test(lines[index] || "")) {
        const item = doc.createElement("li");
        appendInline(doc, item, (lines[index] || "").replace(/^[-*]\s+/, ""));
        list.appendChild(item);
        index++;
      }
      fragment.appendChild(list);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const list = doc.createElement("ol");
      while (index < lines.length && /^\d+\.\s+/.test(lines[index] || "")) {
        const item = doc.createElement("li");
        appendInline(doc, item, (lines[index] || "").replace(/^\d+\.\s+/, ""));
        list.appendChild(item);
        index++;
      }
      fragment.appendChild(list);
      continue;
    }

    if (line.startsWith("> ")) {
      const quote = doc.createElement("blockquote");
      const quoteLines: string[] = [];
      while (index < lines.length && (lines[index] || "").startsWith("> ")) {
        quoteLines.push((lines[index] || "").slice(2));
        index++;
      }
      appendInline(doc, quote, quoteLines.join("\n"));
      fragment.appendChild(quote);
      continue;
    }

    const paragraph = doc.createElement("p");
    const paragraphLines = [line];
    index++;
    while (index < lines.length && !startsBlock(lines, index)) {
      paragraphLines.push(lines[index] || "");
      index++;
    }
    appendInline(doc, paragraph, paragraphLines.join("\n"));
    fragment.appendChild(paragraph);
  }
  return fragment;
}

function appendCodeBlock(
  doc: Document,
  parent: Node,
  lines: readonly string[],
  startIndex: number,
): number {
  const language = (lines[startIndex] || "").slice(3).trim();
  const content: string[] = [];
  let index = startIndex + 1;
  while (index < lines.length && !(lines[index] || "").startsWith("```")) {
    content.push(lines[index] || "");
    index++;
  }
  if (index < lines.length) index++;

  const wrapper = doc.createElement("div");
  wrapper.className = "zc-code-block";
  const header = doc.createElement("div");
  header.className = "zc-code-header";
  header.textContent = language || "text";
  const copy = doc.createElement("button");
  copy.type = "button";
  copy.className = "zc-copy-button";
  copy.textContent = "复制";
  copy.addEventListener("click", () => {
    void doc.defaultView?.navigator.clipboard?.writeText(content.join("\n"));
    copy.textContent = "已复制";
    setTimeout(() => { copy.textContent = "复制"; }, 1200);
  });
  header.appendChild(copy);
  const pre = doc.createElement("pre");
  const code = doc.createElement("code");
  code.textContent = content.join("\n");
  pre.appendChild(code);
  wrapper.append(header, pre);
  parent.appendChild(wrapper);
  return index;
}

function startsBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index] || "";
  if (!line.trim()) return true;
  if (/^(#{1,4})\s+|^```|^[-*]\s+|^\d+\.\s+|^>\s+/.test(line)) return true;
  if (readMathBlock(lines, index)) return true;
  return Boolean(readTable(lines, index));
}

function readMathBlock(lines: readonly string[], startIndex: number): MathBlock | null {
  const trimmed = (lines[startIndex] || "").trim();
  const opening = trimmed.startsWith("$$") ? "$$"
    : trimmed.startsWith("\\[") ? "\\["
      : null;
  if (!opening) return null;
  const closing = opening === "$$" ? "$$" : "\\]";
  const first = trimmed.slice(opening.length);

  if (first.endsWith(closing) && first.length > closing.length) {
    return {
      expression: first.slice(0, -closing.length).trim(),
      nextIndex: startIndex + 1,
      opening,
    };
  }

  const expression: string[] = [];
  if (first) expression.push(first);
  for (let index = startIndex + 1; index < lines.length; index++) {
    const line = lines[index] || "";
    const withoutTrailingWhitespace = line.trimEnd();
    if (withoutTrailingWhitespace.endsWith(closing)) {
      expression.push(withoutTrailingWhitespace.slice(0, -closing.length));
      return {
        expression: expression.join("\n").trim(),
        nextIndex: index + 1,
        opening,
      };
    }
    expression.push(line);
  }
  return null;
}

function appendMath(
  doc: Document,
  parent: Node,
  expression: string,
  displayMode: boolean,
  opening: "$$" | "\\[" | "$" | "\\(",
): void {
  const element = doc.createElement(displayMode ? "div" : "span");
  element.className = displayMode ? "zc-math-display" : "zc-math-inline";
  try {
    katex.render(expression, element, {
      displayMode,
      throwOnError: true,
      strict: "error",
      trust: false,
      maxExpand: 1000,
      maxSize: 20,
      output: "htmlAndMathml",
    });
    hardenKatexOutput(element);
  }
  catch {
    element.classList.add("zc-math-error");
    const closing = opening === "\\[" ? "\\]" : opening === "\\(" ? "\\)" : opening;
    element.textContent = `${opening}${expression}${closing}`;
    element.title = "无法渲染此公式";
  }
  parent.appendChild(element);
}

function hardenKatexOutput(root: Element): void {
  for (const unsafe of root.querySelectorAll(UNSAFE_KATEX_ELEMENTS)) unsafe.remove();
  for (const element of root.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || UNSAFE_URL_ATTRIBUTES.has(name)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

function appendInline(doc: Document, parent: Node, text: string, allowLinks = true): void {
  let index = 0;
  let plain = "";
  const flushPlain = () => {
    if (!plain) return;
    parent.appendChild(doc.createTextNode(plain));
    plain = "";
  };

  while (index < text.length) {
    if (text.startsWith("\\(", index)) {
      const end = findUnescaped(text, "\\)", index + 2);
      if (end !== -1) {
        flushPlain();
        appendMath(doc, parent, text.slice(index + 2, end), false, "\\(");
        index = end + 2;
        continue;
      }
    }

    if (text[index] === "`") {
      const end = findUnescaped(text, "`", index + 1);
      if (end !== -1) {
        flushPlain();
        const code = doc.createElement("code");
        code.textContent = text.slice(index + 1, end);
        parent.appendChild(code);
        index = end + 1;
        continue;
      }
    }

    if (allowLinks && text[index] === "[") {
      const markdownLink = readMarkdownLink(text, index);
      if (markdownLink) {
        const href = safeHttpUrl(markdownLink.destination);
        if (href) {
          flushPlain();
          const link = createExternalLink(doc, href);
          appendInline(doc, link, markdownLink.label, false);
          parent.appendChild(link);
        }
        else {
          plain += text.slice(index, markdownLink.end);
        }
        index = markdownLink.end;
        continue;
      }
    }

    if (text.startsWith("**", index)) {
      const end = findUnescaped(text, "**", index + 2);
      if (end !== -1) {
        flushPlain();
        const strong = doc.createElement("strong");
        appendInline(doc, strong, text.slice(index + 2, end), allowLinks);
        parent.appendChild(strong);
        index = end + 2;
        continue;
      }
    }

    if (text[index] === "$" && text[index + 1] !== "$" && !/\s/.test(text[index + 1] || "")) {
      const end = findClosingDollar(text, index + 1);
      if (end !== -1) {
        flushPlain();
        appendMath(doc, parent, text.slice(index + 1, end), false, "$");
        index = end + 1;
        continue;
      }
    }

    const autoLink = readAutoLink(text, index);
    if (allowLinks && autoLink) {
      const href = safeHttpUrl(autoLink.value);
      if (href) {
        flushPlain();
        const link = createExternalLink(doc, href);
        link.textContent = autoLink.value;
        parent.appendChild(link);
        index = autoLink.end;
        continue;
      }
    }

    if (text[index] === "\n") {
      flushPlain();
      parent.appendChild(doc.createElement("br"));
      index++;
      continue;
    }

    if (text[index] === "\\" && isEscapableMarkdownCharacter(text[index + 1])) {
      plain += text[index + 1];
      index += 2;
      continue;
    }

    plain += text[index] || "";
    index++;
  }
  flushPlain();
}

function findUnescaped(text: string, delimiter: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const found = text.indexOf(delimiter, index);
    if (found === -1) return -1;
    if (!isEscaped(text, found)) return found;
    index = found + delimiter.length;
  }
  return -1;
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 === 1;
}

function findClosingDollar(text: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    if (text[index] !== "$" || isEscaped(text, index) || text[index + 1] === "$") continue;
    if (/\s/.test(text[index - 1] || "")) continue;
    const after = text[index + 1] || "";
    if (/\d/.test(after)) continue;
    return index;
  }
  return -1;
}

function readMarkdownLink(text: string, start: number): MarkdownLink | null {
  const labelEnd = findUnescaped(text, "]", start + 1);
  if (labelEnd === -1 || text[labelEnd + 1] !== "(") return null;
  let depth = 1;
  for (let index = labelEnd + 2; index < text.length; index++) {
    if (isEscaped(text, index)) continue;
    if (text[index] === "(") depth++;
    if (text[index] === ")") depth--;
    if (depth === 0) {
      let destination = text.slice(labelEnd + 2, index).trim();
      if (destination.startsWith("<") && destination.endsWith(">")) {
        destination = destination.slice(1, -1);
      }
      return {
        label: text.slice(start + 1, labelEnd),
        destination: unescapeMarkdown(destination),
        end: index + 1,
      };
    }
  }
  return null;
}

function readAutoLink(text: string, start: number): { value: string; end: number } | null {
  if (!/^https?:\/\//i.test(text.slice(start, start + 8))) return null;
  if (start > 0 && /[\p{L}\p{N}_]/u.test(text[start - 1] || "")) return null;
  const match = /^https?:\/\/[^\s<>]+/i.exec(text.slice(start));
  if (!match?.[0]) return null;
  let value = match[0];
  while (/[.,;:!?]$/.test(value)) value = value.slice(0, -1);
  while (value.endsWith(")") && countCharacter(value, ")") > countCharacter(value, "(")) {
    value = value.slice(0, -1);
  }
  return value ? { value, end: start + value.length } : null;
}

function countCharacter(text: string, character: string): number {
  let count = 0;
  for (const value of text) if (value === character) count++;
  return count;
}

function safeHttpUrl(value: string): string | null {
  if (!value || /[\u0000-\u001f\u007f\s]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.href;
  }
  catch {
    return null;
  }
}

function createExternalLink(doc: Document, href: string): HTMLAnchorElement {
  const link = doc.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  return link;
}

function isEscapableMarkdownCharacter(value: string | undefined): boolean {
  return Boolean(value && /[\\`*_$[\]()|]/.test(value));
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\`*_$[\]()|])/g, "$1");
}

function readTable(lines: readonly string[], startIndex: number): {
  header: string[];
  alignments: Array<"left" | "center" | "right" | null>;
  rows: string[][];
  nextIndex: number;
} | null {
  if (startIndex + 1 >= lines.length) return null;
  const headerLine = lines[startIndex] || "";
  if (!hasUnescapedPipe(headerLine)) return null;
  const header = splitTableRow(headerLine);
  const divider = splitTableRow(lines[startIndex + 1] || "");
  if (!header.length || divider.length !== header.length) return null;
  const alignments = divider.map(parseTableAlignment);
  if (alignments.some((alignment) => alignment === undefined)) return null;

  const rows: string[][] = [];
  let index = startIndex + 2;
  while (index < lines.length) {
    const line = lines[index] || "";
    if (!line.trim() || !hasUnescapedPipe(line)) break;
    const cells = splitTableRow(line);
    const row = Array.from({ length: header.length }, (_, cellIndex) => cells[cellIndex] || "");
    rows.push(row);
    index++;
  }
  return {
    header,
    alignments: alignments as Array<"left" | "center" | "right" | null>,
    rows,
    nextIndex: index,
  };
}

function renderTable(
  doc: Document,
  header: readonly string[],
  alignments: ReadonlyArray<"left" | "center" | "right" | null>,
  rows: readonly string[][],
): HTMLElement {
  const wrapper = doc.createElement("div");
  wrapper.className = "zc-table-wrap";
  const table = doc.createElement("table");
  const head = doc.createElement("thead");
  const headerRow = doc.createElement("tr");
  header.forEach((value, index) => {
    const cell = doc.createElement("th");
    applyTableAlignment(cell, alignments[index] || null);
    appendInline(doc, cell, value);
    headerRow.appendChild(cell);
  });
  head.appendChild(headerRow);
  table.appendChild(head);

  if (rows.length) {
    const body = doc.createElement("tbody");
    for (const values of rows) {
      const row = doc.createElement("tr");
      values.forEach((value, index) => {
        const cell = doc.createElement("td");
        applyTableAlignment(cell, alignments[index] || null);
        appendInline(doc, cell, value);
        row.appendChild(cell);
      });
      body.appendChild(row);
    }
    table.appendChild(body);
  }
  wrapper.appendChild(table);
  return wrapper;
}

function applyTableAlignment(
  cell: HTMLTableCellElement,
  alignment: "left" | "center" | "right" | null,
): void {
  if (alignment) cell.classList.add(`zc-align-${alignment}`);
}

function parseTableAlignment(value: string): "left" | "center" | "right" | null | undefined {
  const trimmed = value.trim();
  if (!TABLE_DIVIDER.test(trimmed)) return undefined;
  if (trimmed.startsWith(":") && trimmed.endsWith(":")) return "center";
  if (trimmed.endsWith(":")) return "right";
  if (trimmed.startsWith(":")) return "left";
  return null;
}

function hasUnescapedPipe(line: string): boolean {
  for (let index = 0; index < line.length; index++) {
    if (line[index] === "|" && !isEscaped(line, index)) return true;
  }
  return false;
}

function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  let inDollarMath = false;
  let inParenMath = false;
  let index = 0;
  const trimmed = line.trim();
  const start = trimmed.startsWith("|") ? 1 : 0;
  const end = trimmed.endsWith("|") && !isEscaped(trimmed, trimmed.length - 1)
    ? trimmed.length - 1
    : trimmed.length;

  index = start;
  while (index < end) {
    if (trimmed[index] === "`" && !isEscaped(trimmed, index)) inCode = !inCode;
    if (!inCode && trimmed.startsWith("\\(", index) && !isEscaped(trimmed, index)) {
      inParenMath = true;
    }
    else if (!inCode && inParenMath && trimmed.startsWith("\\)", index) && !isEscaped(trimmed, index)) {
      inParenMath = false;
    }
    else if (!inCode && !inParenMath && trimmed[index] === "$" && !isEscaped(trimmed, index)) {
      inDollarMath = !inDollarMath;
    }

    if (trimmed[index] === "|" && !isEscaped(trimmed, index) && !inCode && !inDollarMath && !inParenMath) {
      cells.push(cell.trim());
      cell = "";
    }
    else {
      cell += trimmed[index] || "";
    }
    index++;
  }
  cells.push(cell.trim());
  return cells;
}
