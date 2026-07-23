# ⌘K 浮动提问窗 + Apple 风格 UI 改造 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 ⌘K 呼出的 Spotlight 式毛玻璃浮动提问窗(与侧边栏共享同一会话、自动携带 PDF 选区),并把全部界面改造成 Apple 风格(系统蓝主题)。

**Architecture:** 新视图 `FloatPanelView`(纯 HTML + 回调,与 `SidebarView` 同构)挂载在 Zotero 主窗口文档上 `position: fixed` 覆于阅读器;plugin 层把它接入现有 `renderChatViews()` 状态推送管线,`CodexService` 零改动。会话启动从 `openResearchChat` 中抽出无宿主依赖的 `ensureChatSession()`,浮窗与侧边栏共用。样式改造只动 CSS 与 `plugin.ts` 内两处内联样式,不改 DOM 结构与类名。

**Tech Stack:** TypeScript(严格模式,tsc 7)、Vitest 4 + happy-dom、纯 DOM(无框架)、CSS custom properties。

**Spec:** `docs/superpowers/specs/2026-07-23-float-chat-apple-ui-design.md`

## Global Constraints

- 工作目录:仓库根的 `zotero-plugin/`;所有 npm 命令在该目录执行。依赖已安装(如需重装:`npm ci --offline`,本机 npm 直连 registry 会超时)。
- 每个任务结束必须 `npm run check`(tsc --noEmit)与 `npm test`(vitest)全绿;基线为 13 文件 172 测试,只增不减。
- **禁止**在 Linux 运行 `npm run build`、`npm run verify`、`npm run native:*`(需要 macOS)。
- 不修改 `src/codex-service.ts`、`src/codex-app-server.ts`、`src/protocol.ts`、native/、版本号。
- 不重命名/删除任何现有 CSS 类与 DOM 结构;样式改造仅改样式值与新增类。
- 主题色:浅色 `#007AFF` / 深色 `#0A84FF`;全部紫色(`#6c5ce7` 及各处紫色 rgba)必须清除。
- 新代码遵循仓库风格:视图类 `(host, callbacks)` + `setState(partial)` + `destroy()`;中文 UI 文案;注释只写代码无法表达的约束。
- git 提交信息末尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: `FloatPanelView` 骨架 — 挂载、显隐、发送、关闭

**Files:**
- Create: `zotero-plugin/src/float-panel.ts`
- Modify: `zotero-plugin/src/sidebar.ts`(仅导出两个既有符号)
- Test: `zotero-plugin/test/float-panel.test.ts`

**Interfaces:**
- Consumes: `SidebarPhase`、`ChatEntry` 类型与 `createSidebarIcon`(来自 `src/sidebar.ts`);`renderMarkdown(doc, text)`(来自 `src/markdown.ts`)。
- Produces(后续任务依赖的确切签名):
  ```ts
  export interface FloatSelectionInfo { text: string; pageNumber?: number }
  export interface FloatPanelState {
    phase: SidebarPhase; running: boolean; error?: string;
    entries: ChatEntry[]; paperTitle: string; selection: FloatSelectionInfo | null;
  }
  export interface FloatPanelCallbacks {
    onSend(text: string): void; onStop(): void; onClose(): void;
    onRemoveSelection(): void; onLogin(): void;
  }
  export class FloatPanelView {
    constructor(host: HTMLElement, callbacks: FloatPanelCallbacks);
    setState(next: Partial<FloatPanelState>): void;
    show(): void; hide(): void; isVisible(): boolean;
    focusComposer(): void; destroy(): void;
  }
  export function latestExchange(entries: ChatEntry[]): ChatEntry[];
  ```

- [ ] **Step 1: 在 `src/sidebar.ts` 导出图标工具**

`src/sidebar.ts` 中把 `type SidebarIcon`(第 145 行)与 `function createSidebarIcon`(第 1235 行)改为导出,其余不动:

```ts
export type SidebarIcon = "history" | "new" | "terminal" | "more" | "refresh" | "send" | "stop" | "context" | "close";
```

```ts
export function createSidebarIcon(doc: Document, icon: SidebarIcon): SVGElement {
```

- [ ] **Step 2: 写失败测试**

创建 `zotero-plugin/test/float-panel.test.ts`:

```ts
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FloatPanelView,
  latestExchange,
  type FloatPanelCallbacks,
} from "../src/float-panel";

function callbacks(): FloatPanelCallbacks {
  return {
    onSend: vi.fn(),
    onStop: vi.fn(),
    onClose: vi.fn(),
    onRemoveSelection: vi.fn(),
    onLogin: vi.fn(),
  };
}

function mount(handlers = callbacks()): { host: HTMLElement; view: FloatPanelView; handlers: FloatPanelCallbacks } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new FloatPanelView(host, handlers);
  return { host, view, handlers };
}

describe("FloatPanelView shell", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("mounts hidden and toggles with show/hide", () => {
    const { host, view } = mount();
    const root = host.querySelector<HTMLElement>(".zc-float")!;
    expect(root).not.toBeNull();
    expect(root.hidden).toBe(true);
    expect(view.isVisible()).toBe(false);
    view.show();
    expect(root.hidden).toBe(false);
    expect(view.isVisible()).toBe(true);
    view.hide();
    expect(root.hidden).toBe(true);
  });

  it("sends trimmed composer text on Enter and clears the input", () => {
    const { host, view, handlers } = mount();
    view.setState({ phase: "ready" });
    view.show();
    const input = host.querySelector<HTMLTextAreaElement>(".zc-float-input")!;
    input.value = "  什么是注意力机制？  ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(handlers.onSend).toHaveBeenCalledWith("什么是注意力机制？");
    expect(input.value).toBe("");
  });

  it("does not send while the panel is not ready", () => {
    const { host, handlers } = mount();
    const input = host.querySelector<HTMLTextAreaElement>(".zc-float-input")!;
    input.value = "question";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(handlers.onSend).not.toHaveBeenCalled();
  });

  it("closes via Escape, ⌘K inside the input, and the close button", () => {
    const { host, view, handlers } = mount();
    view.setState({ phase: "ready" });
    view.show();
    const input = host.querySelector<HTMLTextAreaElement>(".zc-float-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    host.querySelector<HTMLButtonElement>(".zc-float-close")!.click();
    expect(handlers.onClose).toHaveBeenCalledTimes(3);
  });

  it("shows connecting, signed-out (with login), and error notes; disables input unless ready", () => {
    const { host, view, handlers } = mount();
    view.setState({ phase: "connecting" });
    const input = host.querySelector<HTMLTextAreaElement>(".zc-float-input")!;
    expect(input.disabled).toBe(true);
    expect(host.textContent).toContain("正在连接 Codex");
    view.setState({ phase: "signed-out" });
    const login = host.querySelector<HTMLButtonElement>(".zc-float-login")!;
    login.click();
    expect(handlers.onLogin).toHaveBeenCalledOnce();
    view.setState({ phase: "error", error: "连接断开" });
    expect(host.textContent).toContain("连接断开");
    expect(host.querySelector<HTMLElement>(".zc-float-note")!.hidden).toBe(false);
    view.setState({ phase: "ready", error: undefined });
    expect(input.disabled).toBe(false);
    expect(host.querySelector<HTMLElement>(".zc-float-note")!.hidden).toBe(true);
  });

  it("renders the paper title in the drag bar and removes everything on destroy", () => {
    const { host, view } = mount();
    view.setState({ paperTitle: "Attention Is All You Need" });
    expect(host.querySelector(".zc-float-title")?.textContent).toBe("Attention Is All You Need");
    view.destroy();
    expect(host.querySelector(".zc-float")).toBeNull();
  });
});

describe("latestExchange", () => {
  it("returns entries from the last user message onward", () => {
    expect(latestExchange([
      { id: "u1", kind: "user", text: "q1" },
      { id: "a1", kind: "assistant", text: "a1" },
      { id: "u2", kind: "user", text: "q2" },
      { id: "t2", kind: "tool", text: "tool", title: "zotero_get_current_page" },
      { id: "a2", kind: "assistant", text: "a2" },
    ]).map((entry) => entry.id)).toEqual(["u2", "t2", "a2"]);
  });

  it("returns [] when there is no user entry yet", () => {
    expect(latestExchange([])).toEqual([]);
    expect(latestExchange([{ id: "s", kind: "status", text: "hi" }])).toEqual([]);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd zotero-plugin && npm test -- test/float-panel.test.ts`
Expected: FAIL — `Cannot find module '../src/float-panel'`。

- [ ] **Step 4: 实现 `src/float-panel.ts`**

```ts
import { renderMarkdown } from "./markdown";
import {
  createSidebarIcon,
  type ChatEntry,
  type SidebarPhase,
} from "./sidebar";

export interface FloatSelectionInfo {
  text: string;
  pageNumber?: number;
}

export interface FloatPanelState {
  phase: SidebarPhase;
  running: boolean;
  error?: string;
  entries: ChatEntry[];
  paperTitle: string;
  selection: FloatSelectionInfo | null;
}

export interface FloatPanelCallbacks {
  onSend(text: string): void;
  onStop(): void;
  onClose(): void;
  onRemoveSelection(): void;
  onLogin(): void;
}

/** Entries belonging to the latest question: from the last user entry onward. */
export function latestExchange(entries: ChatEntry[]): ChatEntry[] {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index].kind === "user") return entries.slice(index);
  }
  return [];
}

export class FloatPanelView {
  private readonly doc: Document;
  private readonly root: HTMLElement;
  private bar!: HTMLElement;
  private title!: HTMLElement;
  private chip!: HTMLElement;
  private chipLabel!: HTMLElement;
  private textarea!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private note!: HTMLElement;
  private transcript!: HTMLElement;
  private state: FloatPanelState = {
    phase: "connecting",
    running: false,
    entries: [],
    paperTitle: "论文助手",
    selection: null,
  };
  private position: { left: number; top: number } | null = null;
  private readonly handleResize = () => {
    if (this.position) this.applyPosition(this.position.left, this.position.top);
  };

  constructor(
    host: HTMLElement,
    private readonly callbacks: FloatPanelCallbacks,
  ) {
    this.doc = host.ownerDocument;
    this.root = this.doc.createElement("section");
    this.root.className = "zc-float";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "Zotkit 快速提问");
    host.replaceChildren(this.root);
    this.build();
    this.render();
    this.doc.defaultView?.addEventListener("resize", this.handleResize);
  }

  destroy(): void {
    this.doc.defaultView?.removeEventListener("resize", this.handleResize);
    this.root.remove();
  }

  setState(next: Partial<FloatPanelState>): void {
    this.state = { ...this.state, ...next };
    this.render();
  }

  show(): void {
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  isVisible(): boolean {
    return !this.root.hidden;
  }

  focusComposer(): void {
    this.textarea.focus();
  }

  private build(): void {
    this.bar = this.doc.createElement("header");
    this.bar.className = "zc-float-bar";
    this.bar.addEventListener("mousedown", (event) => this.beginDrag(event));
    const grip = this.doc.createElement("span");
    grip.className = "zc-float-grip";
    grip.setAttribute("aria-hidden", "true");
    this.title = this.doc.createElement("span");
    this.title.className = "zc-float-title";
    const close = this.doc.createElement("button");
    close.type = "button";
    close.className = "zc-float-close";
    close.title = "关闭（Esc）";
    close.setAttribute("aria-label", close.title);
    close.replaceChildren(createSidebarIcon(this.doc, "close"));
    close.addEventListener("click", () => this.callbacks.onClose());
    this.bar.append(grip, this.title, close);

    this.chip = this.doc.createElement("div");
    this.chip.className = "zc-float-chip";
    this.chip.hidden = true;
    const glyph = this.doc.createElement("span");
    glyph.className = "zc-float-chip-glyph";
    glyph.textContent = "“";
    glyph.setAttribute("aria-hidden", "true");
    this.chipLabel = this.doc.createElement("span");
    this.chipLabel.className = "zc-float-chip-label";
    const remove = this.doc.createElement("button");
    remove.type = "button";
    remove.className = "zc-float-chip-remove";
    remove.title = "移除选区上下文";
    remove.setAttribute("aria-label", remove.title);
    remove.replaceChildren(createSidebarIcon(this.doc, "close"));
    remove.addEventListener("click", () => this.callbacks.onRemoveSelection());
    this.chip.append(glyph, this.chipLabel, remove);

    const composer = this.doc.createElement("div");
    composer.className = "zc-float-composer";
    this.textarea = this.doc.createElement("textarea");
    this.textarea.className = "zc-float-input";
    this.textarea.rows = 1;
    this.textarea.placeholder = "问点关于这篇论文的问题…";
    this.textarea.addEventListener("input", () => this.autoSize());
    this.textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.submit();
      }
    });
    this.sendButton = this.doc.createElement("button");
    this.sendButton.type = "button";
    this.sendButton.className = "zc-float-send";
    this.sendButton.title = "发送";
    this.sendButton.setAttribute("aria-label", this.sendButton.title);
    this.sendButton.replaceChildren(createSidebarIcon(this.doc, "send"));
    this.sendButton.addEventListener("click", () => this.submit());
    this.stopButton = this.doc.createElement("button");
    this.stopButton.type = "button";
    this.stopButton.className = "zc-float-stop";
    this.stopButton.title = "停止生成";
    this.stopButton.setAttribute("aria-label", this.stopButton.title);
    this.stopButton.replaceChildren(createSidebarIcon(this.doc, "stop"));
    this.stopButton.addEventListener("click", () => this.callbacks.onStop());
    composer.append(this.textarea, this.stopButton, this.sendButton);

    this.note = this.doc.createElement("div");
    this.note.className = "zc-float-note";

    this.transcript = this.doc.createElement("main");
    this.transcript.className = "zc-float-transcript";

    this.root.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        this.callbacks.onClose();
        return;
      }
      if (
        event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
        && event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.callbacks.onClose();
      }
    });

    this.root.append(this.bar, this.chip, composer, this.note, this.transcript);
  }

  private render(): void {
    this.title.textContent = this.state.paperTitle || "论文助手";
    this.renderChip();
    this.textarea.disabled = this.state.phase !== "ready";
    this.stopButton.hidden = !this.state.running;
    this.stopButton.style.display = this.state.running ? "grid" : "none";
    this.renderNote();
    this.renderTranscript();
  }

  private renderChip(): void {
    const selection = this.state.selection;
    this.chip.hidden = !selection;
    if (!selection) return;
    this.chipLabel.textContent = selection.pageNumber
      ? `已选 ${selection.text.length} 字 · 第 ${selection.pageNumber} 页`
      : `已选 ${selection.text.length} 字`;
  }

  private renderNote(): void {
    this.note.replaceChildren();
    this.note.hidden = false;
    this.note.classList.toggle("is-error", Boolean(this.state.error));
    if (this.state.phase === "connecting") {
      this.note.textContent = "正在连接 Codex…";
      return;
    }
    if (this.state.phase === "signed-out") {
      const text = this.doc.createElement("span");
      text.textContent = "使用 ChatGPT 登录后即可提问。";
      const login = this.doc.createElement("button");
      login.type = "button";
      login.className = "zc-float-login";
      login.textContent = "使用 ChatGPT 登录";
      login.addEventListener("click", () => this.callbacks.onLogin());
      this.note.append(text, login);
      return;
    }
    if (this.state.error) {
      this.note.textContent = this.state.error;
      return;
    }
    this.note.textContent = this.state.running ? "Enter 发送补充 · 完整对话在侧边栏" : "";
    this.note.hidden = !this.note.textContent;
  }

  private renderTranscript(): void {
    this.transcript.replaceChildren();
    this.transcript.hidden = this.state.entries.length === 0;
    for (const entry of this.state.entries) {
      this.transcript.appendChild(this.renderEntry(entry));
    }
    this.transcript.scrollTop = this.transcript.scrollHeight;
  }

  private renderEntry(entry: ChatEntry): HTMLElement {
    const article = this.doc.createElement("article");
    article.className = `zc-float-entry zc-entry-${entry.kind}`;
    article.dataset.entryId = entry.id;
    if (entry.kind === "user") {
      const bubble = this.doc.createElement("div");
      bubble.className = "zc-user-bubble";
      bubble.textContent = entry.text;
      article.appendChild(bubble);
      return article;
    }
    if (entry.kind === "tool" || entry.kind === "command" || entry.kind === "reasoning") {
      const details = this.doc.createElement("details");
      details.className = "zc-tool-card";
      const summary = this.doc.createElement("summary");
      summary.textContent = entry.title || (entry.kind === "reasoning" ? "思考过程" : "工具");
      const content = this.doc.createElement("div");
      content.className = "zc-tool-content";
      content.appendChild(renderMarkdown(this.doc, entry.text));
      details.append(summary, content);
      article.appendChild(details);
      return article;
    }
    if (entry.kind === "status") {
      article.textContent = entry.text;
      return article;
    }
    const content = this.doc.createElement("div");
    content.className = "zc-entry-content";
    content.appendChild(renderMarkdown(this.doc, entry.text));
    article.appendChild(content);
    return article;
  }

  private submit(): void {
    const text = this.textarea.value.trim();
    if (!text || this.state.phase !== "ready") return;
    this.textarea.value = "";
    this.autoSize();
    this.callbacks.onSend(text);
  }

  private autoSize(): void {
    this.textarea.style.height = "auto";
    this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, 120)}px`;
  }

  private beginDrag(event: MouseEvent): void {
    if (event.button !== 0) return;
    const rect = this.root.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    const onMove = (move: MouseEvent) => {
      this.root.classList.add("is-dragged");
      this.applyPosition(move.clientX - offsetX, move.clientY - offsetY);
    };
    const onUp = () => {
      this.doc.removeEventListener("mousemove", onMove, true);
      this.doc.removeEventListener("mouseup", onUp, true);
    };
    this.doc.addEventListener("mousemove", onMove, true);
    this.doc.addEventListener("mouseup", onUp, true);
    event.preventDefault();
  }

  private applyPosition(left: number, top: number): void {
    const win = this.doc.defaultView;
    if (!win) return;
    const margin = 8;
    const maxLeft = Math.max(margin, win.innerWidth - this.root.offsetWidth - margin);
    const maxTop = Math.max(margin, win.innerHeight - this.root.offsetHeight - margin);
    this.position = {
      left: Math.min(Math.max(left, margin), maxLeft),
      top: Math.min(Math.max(top, margin), maxTop),
    };
    this.root.style.left = `${this.position.left}px`;
    this.root.style.top = `${this.position.top}px`;
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd zotero-plugin && npm test -- test/float-panel.test.ts && npm run check`
Expected: 新测试文件全部 PASS;tsc 无错误。

- [ ] **Step 6: 全量回归 + 提交**

Run: `cd zotero-plugin && npm test`
Expected: 14 test files passed;测试总数 ≥ 180。

```bash
git add zotero-plugin/src/float-panel.ts zotero-plugin/src/sidebar.ts zotero-plugin/test/float-panel.test.ts
git commit -m "feat(plugin): FloatPanelView — Spotlight-style quick ask shell

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 选区芯片、最近一轮转录与拖动行为的测试补全

**Files:**
- Modify: `zotero-plugin/test/float-panel.test.ts`(追加用例;实现已在 Task 1 就位,本任务是行为验收)
- Modify(仅当测试暴露缺陷): `zotero-plugin/src/float-panel.ts`

**Interfaces:**
- Consumes: Task 1 的全部导出。
- Produces: 无新接口;锁定 `.zc-float-chip`、`.zc-float-transcript`、拖动 clamp 行为。

- [ ] **Step 1: 追加失败/验收测试**

在 `test/float-panel.test.ts` 末尾追加:

```ts
describe("FloatPanelView selection chip and transcript", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("shows the selection chip with size and page, and forwards removal", () => {
    const { host, view, handlers } = mount();
    view.setState({ selection: { text: "a".repeat(128), pageNumber: 3 } });
    const chip = host.querySelector<HTMLElement>(".zc-float-chip")!;
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toContain("已选 128 字");
    expect(chip.textContent).toContain("第 3 页");
    chip.querySelector<HTMLButtonElement>(".zc-float-chip-remove")!.click();
    expect(handlers.onRemoveSelection).toHaveBeenCalledOnce();
    view.setState({ selection: null });
    expect(chip.hidden).toBe(true);
  });

  it("renders only the latest exchange: user bubble, tool card, markdown answer", () => {
    const { host, view } = mount();
    view.setState({
      phase: "ready",
      entries: latestExchange([
        { id: "u1", kind: "user", text: "old question" },
        { id: "a1", kind: "assistant", text: "old answer" },
        { id: "u2", kind: "user", text: "这段在说什么？" },
        { id: "t2", kind: "tool", title: "zotero_get_current_selection", text: "ok", state: "complete" },
        { id: "a2", kind: "assistant", text: "**核心** 是注意力" },
      ]),
    });
    const transcript = host.querySelector<HTMLElement>(".zc-float-transcript")!;
    expect(transcript.hidden).toBe(false);
    expect(transcript.textContent).not.toContain("old question");
    expect(transcript.querySelector(".zc-user-bubble")?.textContent).toBe("这段在说什么？");
    expect(transcript.textContent).toContain("zotero_get_current_selection");
    expect(transcript.querySelector("strong")?.textContent).toBe("核心");
  });

  it("hides the transcript when there is no exchange yet", () => {
    const { host, view } = mount();
    view.setState({ phase: "ready", entries: [] });
    expect(host.querySelector<HTMLElement>(".zc-float-transcript")!.hidden).toBe(true);
  });

  it("shows the stop button only while running", () => {
    const { host, view } = mount();
    view.setState({ phase: "ready", running: true });
    expect(host.querySelector<HTMLElement>(".zc-float-stop")!.hidden).toBe(false);
    view.setState({ running: false });
    expect(host.querySelector<HTMLElement>(".zc-float-stop")!.hidden).toBe(true);
  });
});

describe("FloatPanelView drag", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("moves with the pointer and clamps to the viewport margin", () => {
    const { host, view } = mount();
    view.show();
    const root = host.querySelector<HTMLElement>(".zc-float")!;
    const bar = host.querySelector<HTMLElement>(".zc-float-bar")!;
    bar.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 10, clientY: 10, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 210, clientY: 130, bubbles: true }));
    expect(root.classList.contains("is-dragged")).toBe(true);
    expect(root.style.left).toBe("200px");
    expect(root.style.top).toBe("120px");
    // Far past the left/top edge → clamped to the 8px margin.
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: -500, clientY: -500, bubbles: true }));
    expect(root.style.left).toBe("8px");
    expect(root.style.top).toBe("8px");
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    // After mouseup, further moves are ignored.
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400, clientY: 400, bubbles: true }));
    expect(root.style.left).toBe("8px");
  });
});
```

- [ ] **Step 2: 运行**

Run: `cd zotero-plugin && npm test -- test/float-panel.test.ts`
Expected: 全部 PASS(Task 1 已实现这些行为;若有 FAIL,按失败信息修正 `src/float-panel.ts`,不改测试预期)。

- [ ] **Step 3: 全量回归 + 提交**

Run: `cd zotero-plugin && npm run check && npm test`
Expected: 全绿。

```bash
git add zotero-plugin/test/float-panel.test.ts zotero-plugin/src/float-panel.ts
git commit -m "test(plugin): lock float panel chip, latest-exchange transcript, drag clamping

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 浮窗基础样式(毛玻璃卡片)

**Files:**
- Modify: `zotero-plugin/src/styles.css`(文件末尾、`@keyframes` 定义之前追加)

**Interfaces:**
- Consumes: 现有 `--zc-*` token(Task 5 换成 Apple 值后自动生效)、Task 1 的类名。
- Produces: `.zc-float*` 样式块;后续任务不改这些选择器。

- [ ] **Step 1: 在 `src/styles.css` 第 569 行(`@keyframes zc-spin` 之前)插入**

```css
.zc-float {
  position: fixed;
  top: 14%;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: grid;
  grid-template-rows: auto auto auto auto minmax(0, auto);
  width: min(620px, calc(100vw - 48px));
  max-height: 72vh;
  box-sizing: border-box;
  padding: 0 0 2px;
  border: 1px solid color-mix(in srgb, var(--zc-border) 72%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--zc-bg) 78%, transparent);
  backdrop-filter: blur(24px) saturate(1.4);
  box-shadow: 0 24px 70px rgba(0, 0, 0, .28), inset 0 1px 0 rgba(255, 255, 255, .22);
  color: var(--zc-text);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
}
.zc-float, .zc-float * { box-sizing: border-box; }
.zc-float[hidden] { display: none; }
.zc-float.is-dragged { transform: none; }

.zc-float-bar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 6px 8px 4px 12px;
  cursor: grab;
  user-select: none;
}
.zc-float-bar:active { cursor: grabbing; }
.zc-float-grip { width: 30px; height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--zc-muted) 40%, transparent); }
.zc-float-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--zc-muted); font-size: 11px; font-weight: 600; }
.zc-float-close { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 7px; color: var(--zc-muted); background: transparent; cursor: pointer; }
.zc-float-close:hover { color: var(--zc-text); background: var(--zc-bg-hover); }
.zc-float-close .zc-button-icon { width: 13px; height: 13px; }

.zc-float-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 12px 6px;
  padding: 5px 6px 5px 9px;
  border: 1px solid color-mix(in srgb, var(--zc-accent) 26%, transparent);
  border-radius: 9px;
  color: var(--zc-accent);
  background: var(--zc-accent-soft);
  font-size: 11px;
  font-weight: 600;
}
.zc-float-chip[hidden] { display: none; }
.zc-float-chip-glyph { font-size: 14px; line-height: 1; }
.zc-float-chip-label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zc-float-chip-remove { display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 5px; color: inherit; background: transparent; cursor: pointer; opacity: .7; }
.zc-float-chip-remove:hover { background: color-mix(in srgb, currentColor 12%, transparent); opacity: 1; }
.zc-float-chip-remove .zc-button-icon { width: 10px; height: 10px; }

.zc-float-composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: end;
  gap: 6px;
  margin: 0 10px;
  padding: 4px 4px 4px 8px;
  border: 1px solid var(--zc-border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--zc-bg-raised) 88%, transparent);
  transition: border-color .15s;
}
.zc-float-composer:focus-within { border-color: color-mix(in srgb, var(--zc-accent) 55%, var(--zc-border)); }
.zc-float-input {
  min-height: 34px;
  max-height: 120px;
  padding: 7px 2px;
  resize: none;
  border: 0;
  outline: 0;
  color: var(--zc-text);
  background: transparent;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.45;
}
.zc-float-input::placeholder { color: var(--zc-muted); }
.zc-float-send,
.zc-float-stop {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  margin-bottom: 3px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: #fff;
  background: var(--zc-accent);
  cursor: pointer;
}
.zc-float-send:hover { background: var(--zc-accent-strong); }
.zc-float-stop { color: var(--zc-accent); background: var(--zc-accent-soft); }
.zc-float-send .zc-button-icon,
.zc-float-stop .zc-button-icon { width: 14px; height: 14px; }

.zc-float-note { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 0; padding: 5px 12px 4px; color: var(--zc-muted); font-size: 10.5px; text-align: center; }
.zc-float-note[hidden] { display: none; }
.zc-float-note.is-error { color: var(--zc-danger); }
.zc-float-login { min-height: 26px; padding: 0 10px; border: 0; border-radius: 7px; color: #fff; background: var(--zc-accent); font: inherit; font-size: 10.5px; font-weight: 600; cursor: pointer; }
.zc-float-login:hover { background: var(--zc-accent-strong); }

.zc-float-transcript {
  min-height: 0;
  max-height: 55vh;
  margin: 2px 4px 6px;
  padding: 6px 8px;
  overflow: auto;
  scrollbar-width: thin;
  overscroll-behavior: contain;
  font-size: 12.5px;
  line-height: 1.55;
}
.zc-float-transcript[hidden] { display: none; }
.zc-float-entry { margin: 0 0 12px; }
.zc-float-entry:last-child { margin-bottom: 2px; }
.zc-float-entry.zc-entry-user { display: flex; justify-content: flex-end; }
.zc-float-entry.zc-entry-status { color: var(--zc-muted); text-align: center; font-size: 10px; }
.zc-float-entry.zc-entry-error { color: var(--zc-danger); }
```

- [ ] **Step 2: 回归 + 提交**

Run: `cd zotero-plugin && npm run check && npm test`
Expected: 全绿(CSS 不影响测试;确认无语法错误导致构建脚本报警即可)。

```bash
git add zotero-plugin/src/styles.css
git commit -m "style(plugin): frosted-glass float panel styles

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: plugin 接线 — ⌘K、会话共享、选区注入、生命周期

**Files:**
- Modify: `zotero-plugin/src/plugin.ts`
- Test: `zotero-plugin/test/plugin-state.test.ts`(追加用例)

**Interfaces:**
- Consumes: `FloatPanelView`、`latestExchange`、`FloatPanelState`(Task 1);既有 `renderChatViews`、`updateInteractionContext`、`removeInteractionContext`、`reportError`、`paperTitle`。
- Produces(plugin 私有,测试经 `as any` 访问):`ensureChatSession(): Promise<void>`、`toggleFloatPanel(): Promise<void>`、`hideFloatPanel(win: Window): void`、`mountFloatPanel(win: Window): { host: HTMLElement; view: FloatPanelView }`、字段 `floatPanels: Map<Window, { host: HTMLElement; view: FloatPanelView }>`、`floatFocusReturn: HTMLElement | null`。

- [ ] **Step 1: 写失败测试**

在 `test/plugin-state.test.ts` 的第一个 `describe` 内追加(紧跟现有快捷键用例之后):

```ts
  it("adds ⌘K to the Reader shortcuts and leaves editable controls alone", () => {
    const plugin = new ZoteroChatPlugin() as any;
    plugin.toggleFloatPanel = vi.fn(async () => {});
    plugin.installShortcutHandler(window);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    expect(plugin.toggleFloatPanel).toHaveBeenCalledOnce();

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    expect(plugin.toggleFloatPanel).toHaveBeenCalledOnce();
    plugin.removeShortcutHandler(window);
    input.remove();
  });

  it("toggleFloatPanel opens with the cached selection attached, then closes and restores focus", async () => {
    const previousZotero = (globalThis as any).Zotero;
    (globalThis as any).Zotero = { getMainWindow: () => window };
    const focusTarget = document.createElement("button");
    document.body.appendChild(focusTarget);
    focusTarget.focus();
    const plugin = new ZoteroChatPlugin() as any;
    plugin.codex = { setInteractionContext: vi.fn() };
    plugin.context = {
      selection: { text: "chosen theorem", pageNumber: 3 },
      page: { pageNumber: 3 },
    };
    plugin.ensureChatSession = vi.fn(async () => {});
    plugin.renderChatViews = vi.fn();
    plugin.reportError = vi.fn();

    await plugin.toggleFloatPanel();
    const root = document.querySelector<HTMLElement>(".zc-float")!;
    expect(root.hidden).toBe(false);
    expect(plugin.addedContextIDs.has("current-selection")).toBe(true);
    expect(plugin.ensureChatSession).toHaveBeenCalledOnce();
    expect(plugin.renderChatViews).toHaveBeenCalled();

    await plugin.toggleFloatPanel();
    expect(root.hidden).toBe(true);
    expect(document.activeElement).toBe(focusTarget);

    plugin.floatPanels.get(window)?.view.destroy();
    plugin.floatPanels.get(window)?.host.remove();
    focusTarget.remove();
    (globalThis as any).Zotero = previousZotero;
  });

  it("toggleFloatPanel opens without a chip when nothing is selected", async () => {
    const previousZotero = (globalThis as any).Zotero;
    (globalThis as any).Zotero = { getMainWindow: () => window };
    const plugin = new ZoteroChatPlugin() as any;
    plugin.codex = { setInteractionContext: vi.fn() };
    plugin.context = null;
    plugin.ensureChatSession = vi.fn(async () => {});
    plugin.renderChatViews = vi.fn();

    await plugin.toggleFloatPanel();
    expect(document.querySelector<HTMLElement>(".zc-float")!.hidden).toBe(false);
    expect(plugin.addedContextIDs.has("current-selection")).toBe(false);

    plugin.hideFloatPanel(window);
    plugin.floatPanels.get(window)?.view.destroy();
    plugin.floatPanels.get(window)?.host.remove();
    (globalThis as any).Zotero = previousZotero;
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `cd zotero-plugin && npm test -- test/plugin-state.test.ts`
Expected: 新增 3 条 FAIL(`toggleFloatPanel is not a function` / ⌘K 未绑定)。

- [ ] **Step 3: 实现 plugin.ts 改动**

3a. 顶部 import(在 `sidebar` import 之后):

```ts
import { FloatPanelView, latestExchange } from "./float-panel";
```

3b. 类字段(`private chatViews = ...` 之后):

```ts
  private floatPanels = new Map<Window, { host: HTMLElement; view: FloatPanelView }>();
  private floatFocusReturn: HTMLElement | null = null;
```

3c. `installShortcutHandler` 的 keyHandler 中、`⌘⇧J` 分支之前插入:

```ts
      if (!event.shiftKey && key === "k") {
        event.preventDefault();
        event.stopPropagation();
        void this.toggleFloatPanel().catch((error) => this.reportError(error));
        return;
      }
```

3d. **会话启动抽取**:把 `openResearchChat` / `openResearchChatInternal`(现第 589–637 行)替换为:

```ts
  private openResearchChat(body?: HTMLElement, focus = true): Promise<void> {
    this.paneMode = "chat";
    this.terminal.setVisible(false);
    const host = body || this.activeSidebarBody();
    if (!host) return Promise.reject(new Error("请先展开 Zotkit 侧栏"));
    this.mountChat(host);
    const pending = this.ensureChatSession();
    if (focus) {
      void pending.then(() => {
        if (host.isConnected) this.chatViews.get(host)?.focusComposer();
      }).catch(() => { /* 启动失败由调用方处理 */ });
    }
    return pending;
  }

  private ensureChatSession(): Promise<void> {
    if (this.chatOpenPromise) return this.chatOpenPromise;
    const pending = this.ensureChatSessionInternal();
    this.chatOpenPromise = pending;
    const clear = () => {
      if (this.chatOpenPromise === pending) this.chatOpenPromise = null;
    };
    void pending.then(clear, clear);
    return pending;
  }

  private async ensureChatSessionInternal(): Promise<void> {
    this.chatPhase = "connecting";
    this.chatError = "";
    this.renderChatViews();
    await this.refreshContext();
    try {
      await this.codex.start();
      if (!this.codex.isSignedIn()) {
        this.chatPhase = "signed-out";
      }
      else {
        this.chatPhase = "ready";
        if (this.context) await this.codex.setPaper(this.context);
      }
      const defaultModel = this.codex.state.models.find((model) => model.isDefault)
        || this.codex.state.models[0];
      if (!this.selectedModel && defaultModel) this.selectedModel = defaultModel.id;
      await this.refreshMutationCheckpoints();
    }
    catch (error) {
      const value = error instanceof Error ? error : new Error(String(error));
      this.chatPhase = value.message.includes("未找到 Codex CLI") ? "unavailable" : "error";
      this.chatError = value.message;
      throw value;
    }
    finally {
      this.renderChatViews();
    }
  }
```

3e. `sendChat` 首行 `if (!this.codex.state.connected) await this.openResearchChat(undefined, false);` 改为:

```ts
    if (!this.codex.state.connected) await this.ensureChatSession();
```

3f. 浮窗生命周期方法(加在 `openChatWithSelection` 之后):

```ts
  private mountFloatPanel(win: Window): { host: HTMLElement; view: FloatPanelView } {
    let entry = this.floatPanels.get(win);
    if (entry) return entry;
    const host = win.document.createElement("div");
    host.className = "zc-float-host";
    win.document.documentElement.appendChild(host);
    const view = new FloatPanelView(host, {
      onSend: (text) => void this.sendChat(text).catch((error) => this.reportError(error)),
      onStop: () => void this.codex.interrupt().catch((error) => this.reportError(error)),
      onClose: () => this.hideFloatPanel(win),
      onRemoveSelection: () => this.removeInteractionContext("current-selection"),
      onLogin: () => void this.codex.login().catch((error) => this.reportError(error)),
    });
    entry = { host, view };
    this.floatPanels.set(win, entry);
    return entry;
  }

  private async toggleFloatPanel(): Promise<void> {
    const win = Zotero.getMainWindow();
    if (!win) return;
    const existing = this.floatPanels.get(win);
    if (existing?.view.isVisible()) {
      this.hideFloatPanel(win);
      return;
    }
    const entry = this.mountFloatPanel(win);
    const active = win.document.activeElement;
    this.floatFocusReturn = active && active !== win.document.body
      ? active as HTMLElement
      : null;
    // The selection-popup hook keeps this.context.selection fresh, so the
    // cached value is what the user just highlighted (mirrors ⌘L).
    if (this.context?.selection?.text) {
      this.addedContextIDs.add("current-selection");
      this.chatError = "";
      this.updateInteractionContext();
    }
    entry.view.show();
    this.renderChatViews();
    entry.view.focusComposer();
    void this.ensureChatSession()
      .then(() => entry.view.focusComposer())
      .catch((error) => this.reportError(error));
  }

  private hideFloatPanel(win: Window): void {
    const entry = this.floatPanels.get(win);
    if (!entry?.view.isVisible()) return;
    entry.view.hide();
    const target = this.floatFocusReturn;
    this.floatFocusReturn = null;
    if (target?.isConnected) {
      try { target.focus(); }
      catch { /* previously focused node may be gone */ }
    }
  }

  private renderFloatPanels(): void {
    const context = this.context;
    for (const [win, entry] of this.floatPanels) {
      if (win.closed || !entry.host.isConnected) {
        entry.view.destroy();
        entry.host.remove();
        this.floatPanels.delete(win);
        continue;
      }
      entry.view.setState({
        phase: this.chatPhase,
        running: this.codex.state.running,
        error: this.chatError || this.codex.state.fallbackReason || undefined,
        entries: latestExchange(this.codex.getChatEntries()),
        paperTitle: context ? paperTitle(context) : "论文助手",
        selection: this.addedContextIDs.has("current-selection") && context?.selection?.text
          ? {
            text: context.selection.text,
            pageNumber: context.selection.pageNumber ?? context.page.pageNumber,
          }
          : null,
      });
    }
  }
```

3g. `renderChatViews()` 末尾(chatViews 的 `for` 循环结束后、方法闭括号前)追加:

```ts
    this.renderFloatPanels();
```

3h. `shutdown()` 中 `for (const view of this.chatViews.values()) view.destroy();` 之后追加:

```ts
    for (const entry of this.floatPanels.values()) {
      entry.view.destroy();
      entry.host.remove();
    }
    this.floatPanels.clear();
```

3i. `onMainWindowUnload(win)` 中 `this.removeWindowAssets(win);` 之前追加:

```ts
    const floatEntry = this.floatPanels.get(win);
    if (floatEntry) {
      floatEntry.view.destroy();
      floatEntry.host.remove();
      this.floatPanels.delete(win);
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd zotero-plugin && npm test -- test/plugin-state.test.ts && npm run check`
Expected: 全部 PASS(含既有 chatOpenPromise 并发用例——`ensureChatSession` 保持了单飞语义)。

- [ ] **Step 5: 全量回归 + 提交**

Run: `cd zotero-plugin && npm test`
Expected: 14 文件全绿。

```bash
git add zotero-plugin/src/plugin.ts zotero-plugin/test/plugin-state.test.ts
git commit -m "feat(plugin): ⌘K floating ask panel wired to the shared Codex session

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Apple 设计 token 翻新(系统蓝 + 系统灰阶)

**Files:**
- Modify: `zotero-plugin/src/styles.css`(仅第 1–31 行的两个 token 块)

**Interfaces:**
- Consumes/Produces: 仅 CSS 变量值;所有组件经 token 自动继承。**不改任何选择器。**

- [ ] **Step 1: 替换 `:root` 块(第 1–18 行)为**

```css
:root {
  --zc-accent: #007aff;
  --zc-accent-strong: #0066d6;
  --zc-accent-soft: color-mix(in srgb, var(--zc-accent) 12%, transparent);
  --zc-bg: #ffffff;
  --zc-bg-raised: #ffffff;
  --zc-bg-subtle: #f5f5f7;
  --zc-bg-hover: #ececee;
  --zc-border: rgba(0, 0, 0, .1);
  --zc-text: #1d1d1f;
  --zc-muted: #86868b;
  --zc-danger: #ff3b30;
  --zc-warning: #ff9500;
  --zc-success: #34c759;
  --zc-code-bg: #1d1d1f;
  --zc-shadow: 0 10px 30px rgba(0, 0, 0, .1), 0 2px 8px rgba(0, 0, 0, .06);
  color-scheme: light dark;
}
```

- [ ] **Step 2: 替换 dark 覆盖块(原第 20–31 行)为**

```css
@media (prefers-color-scheme: dark) {
  :root {
    --zc-accent: #0a84ff;
    --zc-accent-strong: #409cff;
    --zc-bg: #1e1e1e;
    --zc-bg-raised: #2c2c2e;
    --zc-bg-subtle: #252527;
    --zc-bg-hover: #3a3a3c;
    --zc-border: rgba(255, 255, 255, .14);
    --zc-text: #f5f5f7;
    --zc-muted: #98989d;
    --zc-danger: #ff453a;
    --zc-warning: #ff9f0a;
    --zc-success: #30d158;
    --zc-shadow: 0 12px 38px rgba(0, 0, 0, .45), 0 2px 10px rgba(0, 0, 0, .3);
  }
}
```

- [ ] **Step 3: 回归 + 提交**

Run: `cd zotero-plugin && npm run check && npm test`
Expected: 全绿。

```bash
git add zotero-plugin/src/styles.css
git commit -m "style(plugin): Apple system-blue accent and system gray design tokens

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 组件级 Apple 化 + 紫色残留清理 + 文档

**Files:**
- Modify: `zotero-plugin/src/styles.css`、`zotero-plugin/src/plugin.ts`(两处内联样式)、`zotero-plugin/CHANGELOG.md`、`zotero-plugin/README.md`(若含快捷键列表)

**Interfaces:** 无新接口;只改样式值与文档。

- [ ] **Step 1: styles.css 组件规则按下表逐条替换**(选择器不变,只换声明;行号为 Task 3 插入前的原始行号,以选择器为准定位)

| 选择器 | 新声明(整条规则替换) |
|---|---|
| `.zc-sidebar`(第 44 行) | `position: relative; display: grid; grid-template-rows: auto auto auto minmax(0, 1fr) auto; width: 100%; height: clamp(420px, 72vh, 780px); min-height: 0; max-height: none; overflow: hidden; border: 1px solid var(--zc-border); border-radius: 12px; background: var(--zc-bg); box-shadow: var(--zc-shadow);` |
| `.zc-topbar`(第 70 行) | 原声明保持,`border-bottom` 不变,追加:`background: color-mix(in srgb, var(--zc-bg) 82%, transparent); backdrop-filter: blur(18px) saturate(1.3); position: sticky; top: 0; z-index: 8;` |
| `.zc-user-bubble`(第 245 行) | `max-width: 88%; padding: 8px 12px; border-radius: 18px 18px 4px 18px; color: #fff; background: var(--zc-accent); white-space: pre-wrap;` |
| `.zc-composer`(第 417 行) | `position: relative; border: 1px solid var(--zc-border); border-radius: 14px; background: var(--zc-bg-raised); box-shadow: var(--zc-shadow); transition: border-color .15s, box-shadow .15s;` |
| `.zc-composer:focus-within`(第 418 行) | `border-color: color-mix(in srgb, var(--zc-accent) 52%, var(--zc-border)); box-shadow: 0 0 0 3px var(--zc-accent-soft), var(--zc-shadow);` |
| `.zc-send-button`(第 464 行) | `display: grid; place-items: center; width: 28px; height: 28px; flex: none; border: 0; border-radius: 50%; color: #fff; background: var(--zc-accent); font: inherit; cursor: pointer;` |
| `.zc-compact-select`(第 458 行) | `min-width: 0; max-width: 108px; height: 24px; flex: 1 1 64px; padding: 0 6px; overflow: hidden; border: 0; border-radius: 999px; color: var(--zc-muted); background: var(--zc-bg-subtle); font: inherit; font-size: 9.25px; text-overflow: ellipsis;` |
| `.zc-context-chip.is-selection`(第 423 行) | `color: var(--zc-accent);` |
| `.zc-context-option-mark.is-selection`(第 443 行) | `color: var(--zc-accent);` |
| `.zc-diff-view .is-hunk`(第 387 行) | `color: #8ab4ff; background: rgba(10, 132, 255, .14);` |
| `.zc-login-layer`(第 470 行) | `position: absolute; inset: 47px 0 0; z-index: 18; display: grid; place-items: center; padding: 20px; background: color-mix(in srgb, var(--zc-bg) 88%, transparent); backdrop-filter: blur(22px) saturate(1.35);` |
| `.zc-terminal-sidebar`(第 491 行) | 声明中仅把 `border: 1px solid rgba(147, 136, 194, .22)` 改为 `border: 1px solid rgba(255, 255, 255, .12)`,其余不动 |

- [ ] **Step 2: styles.css 里清除所有残余紫色**

Run: `cd zotero-plugin && grep -nE '6c5ce7|5545d4|108, ?92, ?231|118, ?91, ?255|155, ?140, ?255|9b8cff|bfb2ff|c4b7ff|c5b8ff|a99ed6|a060b6|765bff|80, ?66, ?117' src/styles.css`

对命中的每一行(终端面板的紫色点缀等),做等义换色:紫色 rgba → 同透明度的蓝 `rgba(10, 132, 255, X)`;紫色十六进制文本色 → `#8ab4ff`(浅字)或 `var(--zc-accent)`(token 可用处);`radial-gradient` 里的 `rgba(80,66,117,.08)` → `rgba(28, 60, 110, .08)`。替换后重跑该 grep,Expected: 无输出。

- [ ] **Step 3: plugin.ts 内联样式换色**

`readerPopupButton`(原第 1162 行)的 `style.cssText` 改为:

```ts
    button.style.cssText = "min-height:28px;padding:4px 10px;border:1px solid rgba(0,122,255,.3);border-radius:8px;background:rgba(0,122,255,.12);color:inherit;font:600 11px -apple-system;cursor:pointer";
```

`registerReaderHooks` 中 toolbar 按钮(原第 328 行)`border-radius:6px` 改为 `border-radius:8px`(其余不动)。

- [ ] **Step 4: 文档**

`CHANGELOG.md`:在最新版本段落上方新增(保持既有格式;若有 Unreleased 段则并入):

```markdown
## Unreleased

- 新增 ⌘K 浮动提问窗：Spotlight 式毛玻璃卡片悬浮于 PDF 之上，自动携带当前选区，与侧边栏共享同一会话；Esc/⌘K 关闭，可拖动。
- 全部界面改为 Apple 风格：系统蓝主题（浅色 #007AFF / 深色 #0A84FF）、系统灰阶、iMessage 式用户气泡、毛玻璃顶栏与登录遮罩。
```

`README.md`:`grep -n "⌘" README.md`;若存在快捷键列表,按其格式追加一行 `⌘K — 呼出/关闭浮动提问窗（带当前 PDF 选区）`;若无列表则跳过。

- [ ] **Step 5: 回归 + 提交**

Run: `cd zotero-plugin && npm run check && npm test`
Expected: 全绿;`grep -c '6c5ce7' src/styles.css` 输出 0。

```bash
git add zotero-plugin/src/styles.css zotero-plugin/src/plugin.ts zotero-plugin/CHANGELOG.md zotero-plugin/README.md
git commit -m "style(plugin): Apple-style component pass — blue accent everywhere, no purple left

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 完成门槛(Linux 上可验证的部分)

1. `cd zotero-plugin && npm run check && npm test` — 14 文件全绿,总测试数 ≥ 185。
2. `grep -nE '6c5ce7|108, ?92, ?231' src/styles.css src/plugin.ts` — 无输出。
3. 所有任务各自成 commit,信息符合约定。

## Linux 无法验证、留给 Mac smoke test 的部分

- 毛玻璃(`backdrop-filter`)在 Zotero 主窗口的实际渲染、拖动手感、⌘K 在 Reader iframe 内的实际触发。
- 浅色/深色模式切换下的对比度;浮窗与 Reader 工具栏的 z-index 关系。
- 完整流程:划词 → ⌘K → 芯片带选区 → 提问 → 浮窗与侧边栏同步流式 → Esc 关闭焦点回 PDF。
