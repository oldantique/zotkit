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
    if (entries[index]!.kind === "user") return entries.slice(index);
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
