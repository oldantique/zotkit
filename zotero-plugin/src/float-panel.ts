import { renderMarkdown } from "./markdown";
import { copyToClipboard } from "./platform";
import {
  createSidebarIcon,
  type ChatEntry,
  type ModelOption,
  type SidebarPhase,
} from "./sidebar";
import {
  activityLabel,
  contentEntries,
  formatElapsed,
  groupEntries,
  processEntries,
  type Exchange,
} from "./exchanges";

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
  models: ModelOption[];
  selectedModel: string;
  turnStartedAt: number | null;
  turnDurations: Record<string, number>;
}

export interface FloatPanelCallbacks {
  onSend(text: string): void;
  onStop(): void;
  onClose(): void;
  onRemoveSelection(): void;
  onLogin(): void;
  onModelChange(model: string): void;
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
  private modelSelect!: HTMLSelectElement;
  private note!: HTMLElement;
  private transcript!: HTMLElement;
  private state: FloatPanelState = {
    phase: "connecting",
    running: false,
    entries: [],
    paperTitle: "论文助手",
    selection: null,
    models: [],
    selectedModel: "",
    turnStartedAt: null,
    turnDurations: {},
  };
  private position: { left: number; top: number } | null = null;
  private readonly expandedTurns = new Set<string>();
  private activityTimer: number | null = null;
  private activityNode: HTMLElement | null = null;
  private activityLabelEl: HTMLElement | null = null;
  private activityElapsedEl: HTMLElement | null = null;
  private pinnedToBottom = true;
  private readonly handleResize = () => {
    if (this.root.hidden) return;
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
    if (this.activityTimer !== null) {
      this.doc.defaultView?.clearInterval(this.activityTimer);
      this.activityTimer = null;
    }
    this.doc.defaultView?.removeEventListener("resize", this.handleResize);
    this.root.remove();
  }

  setState(next: Partial<FloatPanelState>): void {
    this.state = { ...this.state, ...next };
    this.render();
  }

  show(): void {
    this.pinnedToBottom = true;
    this.root.hidden = false;
    if (this.position) this.applyPosition(this.position.left, this.position.top);
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
    this.modelSelect = this.doc.createElement("select");
    this.modelSelect.className = "zc-float-model";
    this.modelSelect.title = "模型";
    this.modelSelect.hidden = true;
    this.modelSelect.addEventListener("change", () => {
      this.callbacks.onModelChange(this.modelSelect.value);
    });
    composer.append(this.textarea, this.stopButton, this.sendButton, this.modelSelect);

    this.note = this.doc.createElement("div");
    this.note.className = "zc-float-note";

    this.transcript = this.doc.createElement("main");
    this.transcript.className = "zc-float-transcript";
    this.transcript.addEventListener("scroll", () => {
      const { scrollTop, clientHeight, scrollHeight } = this.transcript;
      this.pinnedToBottom = scrollTop + clientHeight >= scrollHeight - 4;
    });
    this.transcript.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement | null)?.closest?.(".zc-math-copy");
      if (!target) return;
      const latex = target.getAttribute("data-latex");
      if (!latex || !copyToClipboard(latex)) return;
      target.classList.add("is-copied");
      this.doc.defaultView?.setTimeout(() => target.classList.remove("is-copied"), 1200);
    });

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
    this.renderModels();
    this.renderNote();
    this.renderTranscript();
  }

  private renderModels(): void {
    const models = this.state.models;
    this.modelSelect.hidden = models.length === 0;
    if (!models.length) {
      this.modelSelect.replaceChildren();
      return;
    }
    const previous = this.modelSelect.value;
    this.modelSelect.replaceChildren();
    for (const model of models) {
      const option = this.doc.createElement("option");
      option.value = model.id;
      option.textContent = model.label;
      this.modelSelect.appendChild(option);
    }
    this.modelSelect.value = this.state.selectedModel || previous || models[0]!.id;
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

    let activityGroup: Exchange | null = null;
    const groups = groupEntries(this.state.entries);
    groups.forEach((group, index) => {
      for (const entry of contentEntries(group)) {
        this.transcript.appendChild(this.renderEntry(entry));
      }
      if (group.id === "preamble") return;
      const isLastGroup = index === groups.length - 1;
      if (isLastGroup && this.state.running) {
        activityGroup = group;
        return;
      }
      const steps = processEntries(group).length;
      const elapsed = this.state.turnDurations[group.id];
      if (steps === 0 && elapsed === undefined) return;
      this.transcript.appendChild(this.renderTurnSummary(group, steps, elapsed));
      if (this.expandedTurns.has(group.id)) {
        this.transcript.appendChild(this.renderTurnDetail(processEntries(group)));
      }
    });
    const groupIds = new Set(groups.map((group) => group.id));
    for (const id of this.expandedTurns) {
      if (!groupIds.has(id)) this.expandedTurns.delete(id);
    }
    if (activityGroup) this.transcript.appendChild(this.renderActivityLine(activityGroup));

    if (this.pinnedToBottom) {
      this.transcript.scrollTop = this.transcript.scrollHeight;
    }
    this.syncActivityTimer();
  }

  private renderTurnSummary(group: Exchange, steps: number, elapsed: number | undefined): HTMLElement {
    const button = this.doc.createElement("button");
    button.type = "button";
    button.className = "zc-turn-summary";
    const parts: string[] = [];
    if (elapsed !== undefined) parts.push(`⏱ ${formatElapsed(elapsed)}`);
    if (steps > 0) parts.push(`${steps} 个步骤`);
    button.textContent = parts.join(" · ");
    button.addEventListener("click", () => {
      if (this.expandedTurns.has(group.id)) this.expandedTurns.delete(group.id);
      else this.expandedTurns.add(group.id);
      this.render();
    });
    return button;
  }

  private renderTurnDetail(processes: ChatEntry[]): HTMLElement {
    const container = this.doc.createElement("div");
    container.className = "zc-turn-detail";
    for (const entry of processes) {
      container.appendChild(this.renderEntry(entry));
    }
    return container;
  }

  /**
   * The activity line's spinner/shimmer are CSS animations keyed to the DOM
   * node's lifetime. `renderTranscript` wipes and rebuilds the whole
   * transcript on every render, so a freshly created node here would reset
   * those animations to frame 0 on each of the ~20/s streaming renders. This
   * node is created once and reused across renders (only its label/elapsed
   * text is patched in place) so the same element re-enters the transcript
   * each time instead of a brand-new one.
   */
  private renderActivityLine(group: Exchange): HTMLElement {
    if (!this.activityNode) {
      const line = this.doc.createElement("div");
      line.className = "zc-activity";
      const spinner = this.doc.createElement("span");
      spinner.className = "zc-activity-spinner";
      spinner.setAttribute("aria-hidden", "true");
      const label = this.doc.createElement("span");
      label.className = "zc-activity-label";
      line.append(spinner, label);
      this.activityNode = line;
      this.activityLabelEl = label;
    }
    const line = this.activityNode;
    const nextLabel = activityLabel(group.entries);
    if (this.activityLabelEl!.textContent !== nextLabel) this.activityLabelEl!.textContent = nextLabel;

    if (this.state.turnStartedAt !== null) {
      const nextElapsed = formatElapsed(Date.now() - this.state.turnStartedAt);
      if (!this.activityElapsedEl) {
        const elapsed = this.doc.createElement("span");
        elapsed.className = "zc-activity-elapsed";
        line.appendChild(elapsed);
        this.activityElapsedEl = elapsed;
      }
      if (this.activityElapsedEl.textContent !== nextElapsed) this.activityElapsedEl.textContent = nextElapsed;
    }
    else if (this.activityElapsedEl) {
      this.activityElapsedEl.remove();
      this.activityElapsedEl = null;
    }
    return line;
  }

  private syncActivityTimer(): void {
    if (this.state.running) {
      if (this.activityTimer === null) {
        this.activityTimer = this.doc.defaultView?.setInterval(() => {
          const turnStartedAt = this.state.turnStartedAt;
          if (turnStartedAt === null) return;
          const elapsed = this.transcript.querySelector<HTMLElement>(".zc-activity-elapsed");
          if (elapsed) elapsed.textContent = formatElapsed(Date.now() - turnStartedAt);
        }, 1000) ?? null;
      }
      return;
    }
    if (this.activityTimer !== null) {
      this.doc.defaultView?.clearInterval(this.activityTimer);
      this.activityTimer = null;
    }
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
    const markdownBody = this.doc.createElement("div");
    markdownBody.className = "zc-markdown";
    markdownBody.appendChild(renderMarkdown(this.doc, entry.text));
    content.appendChild(markdownBody);
    if (entry.kind === "assistant") {
      content.appendChild(this.createCopyAnswerButton(entry.text));
    }
    article.appendChild(content);
    return article;
  }

  private createCopyAnswerButton(text: string): HTMLButtonElement {
    const button = this.doc.createElement("button");
    button.type = "button";
    button.className = "zc-copy-answer";
    button.title = "复制回答";
    button.replaceChildren(createSidebarIcon(this.doc, "copy"));
    button.addEventListener("click", () => {
      if (!copyToClipboard(text)) return;
      button.classList.add("is-copied");
      button.title = "已复制";
      this.doc.defaultView?.setTimeout(() => {
        button.classList.remove("is-copied");
        button.title = "复制回答";
      }, 1500);
    });
    return button;
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
    if ((event.target as Element | null)?.closest?.(".zc-float-close")) return;
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
