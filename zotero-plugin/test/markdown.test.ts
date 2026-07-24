// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { markdownToNoteHtml, renderMarkdown } from "../src/markdown";

function render(markdown: string): HTMLDivElement {
  const host = document.createElement("div");
  host.appendChild(renderMarkdown(document, markdown));
  return host;
}

describe("safe paper Markdown renderer", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("renders Markdown links and bare URLs with external-navigation safeguards", () => {
    const host = render(
      "Read [the paper](https://example.org/paper?q=1) and https://example.org/appendix.",
    );
    const links = [...host.querySelectorAll("a")];

    expect(links).toHaveLength(2);
    expect(links[0]?.textContent).toBe("the paper");
    expect(links[0]?.href).toBe("https://example.org/paper?q=1");
    for (const link of links) {
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
      expect(link.referrerPolicy).toBe("no-referrer");
    }
  });

  it("rejects executable and credential-bearing link destinations without parsing HTML", () => {
    const host = render(
      '[bad](javascript:alert(1)) [creds](https://user:pass@example.org/) <img src=x onerror="alert(1)">',
    );

    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector("img,script,iframe,object,embed")).toBeNull();
    expect(host.textContent).toContain("[bad](javascript:alert(1))");
    expect(host.textContent).toContain("<img");
  });

  it("renders aligned tables and inline formatting inside cells", () => {
    const host = render([
      "| Symbol | Meaning | Result |",
      "| :--- | :---: | ---: |",
      "| $x \\mid y$ | **conditional** | `true` |",
    ].join("\n"));

    expect(host.querySelectorAll("table")).toHaveLength(1);
    expect(host.querySelectorAll("th")).toHaveLength(3);
    expect(host.querySelector("th:nth-child(2)")?.classList.contains("zc-align-center")).toBe(true);
    expect(host.querySelector("th:nth-child(3)")?.classList.contains("zc-align-right")).toBe(true);
    expect(host.querySelector("td strong")?.textContent).toBe("conditional");
    expect(host.querySelector("td code")?.textContent).toBe("true");
    expect(host.querySelector("td .katex")).not.toBeNull();
  });

  it("renders inline and multiline display LaTeX locally with KaTeX", () => {
    const host = render([
      "Einstein wrote $E = mc^2$.",
      "",
      "$$",
      "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
      "$$",
      "",
      "And \\(\\alpha + \\beta\\) is inline.",
    ].join("\n"));

    expect(host.querySelectorAll(".zc-math-inline .katex")).toHaveLength(2);
    expect(host.querySelectorAll(".zc-math-display .katex-display")).toHaveLength(1);
    expect(host.querySelector(".zc-math-error")).toBeNull();
  });

  it("keeps code literal and hardens untrusted TeX commands", () => {
    const host = render([
      "`$not_math$`",
      "",
      "$\\href{javascript:alert(1)}{click}$",
      "",
      "```md",
      "[not a link](https://example.org) $not_math$ <script>alert(1)</script>",
      "```",
    ].join("\n"));

    expect(host.querySelectorAll(".zc-math-inline")).toHaveLength(1);
    expect(host.querySelector(".zc-math-inline a, .zc-math-inline img")).toBeNull();
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("pre code")?.textContent).toContain("[not a link]");
    expect(host.querySelector("p > code")?.textContent).toBe("$not_math$");
  });

  it("falls back to visible source text for invalid formulas", () => {
    const host = render("Before $\\notARealCommand{$ after");
    const fallback = host.querySelector(".zc-math-error");

    expect(fallback?.textContent).toBe("$\\notARealCommand{$");
    expect(host.textContent).toContain("after");
  });

  it("wraps math output with a copyable container carrying the LaTeX source", () => {
    const fragment = renderMarkdown(document, "$$E = mc^2$$\n\n行内 $a+b$ 检查");
    const display = document.createElement("div");
    display.appendChild(fragment);
    const block = display.querySelector(".zc-math-display.zc-math-copy")!;
    expect(block.getAttribute("data-latex")).toBe("E = mc^2");
    expect(block.getAttribute("title")).toBe("点击复制 LaTeX");
    const inline = display.querySelector(".zc-math-inline.zc-math-copy")!;
    expect(inline.getAttribute("data-latex")).toBe("a+b");
  });

  it("carries the copy attributes on the KaTeX-error fallback too", () => {
    const host = render("Before $\\notARealCommand{$ after");
    const fallback = host.querySelector(".zc-math-error.zc-math-copy")!;

    expect(fallback.getAttribute("data-latex")).toBe("\\notARealCommand{");
    expect(fallback.getAttribute("title")).toBe("点击复制 LaTeX");
  });
});

describe("markdownToNoteHtml", () => {
  it("demotes headings and keeps structure Zotero-safe", () => {
    expect(markdownToNoteHtml("# 标题\n\n正文 **粗** *斜* `code`")).toBe(
      "<h3>标题</h3><p>正文 <strong>粗</strong> <em>斜</em> <code>code</code></p>",
    );
    expect(markdownToNoteHtml("### 小节")).toBe("<h4>小节</h4>");
  });
  it("keeps LaTeX as literal escaped text", () => {
    expect(markdownToNoteHtml("$$E < mc^2$$")).toBe("<p>$$E &lt; mc^2$$</p>");
    expect(markdownToNoteHtml("内联 $a<b$ 完")).toBe("<p>内联 $a&lt;b$ 完</p>");
  });
  it("renders lists, quotes and fenced code", () => {
    expect(markdownToNoteHtml("- 一\n- 二")).toBe("<ul><li>一</li><li>二</li></ul>");
    expect(markdownToNoteHtml("> 引用")).toBe("<blockquote><p>引用</p></blockquote>");
    expect(markdownToNoteHtml("```js\nconst a = 1 < 2;\n```")).toBe(
      "<pre>const a = 1 &lt; 2;</pre>",
    );
  });
  it("emits markdown tables as preformatted text and whitelists links", () => {
    expect(markdownToNoteHtml("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(
      "<pre>| a | b |\n| --- | --- |\n| 1 | 2 |</pre>",
    );
    expect(markdownToNoteHtml("[官网](https://example.com) [坏](javascript:x)")).toBe(
      '<p><a href="https://example.com">官网</a> 坏</p>',
    );
  });
});
