import { renderMarkdown } from "./markdown";
import { copyToClipboard } from "./platform";
import {
  activityLabel,
  contentEntries,
  formatElapsed,
  groupEntries,
  processEntries,
  type Exchange,
} from "./exchanges";

export type SidebarPhase = "connecting" | "signed-out" | "ready" | "unavailable" | "error";

export interface PaperContextView {
  key: string;
  title: string;
  authors?: string;
  pageLabel?: string;
  pageIndex?: number;
  pagesCount?: number;
  selectionText?: string;
  pdfPath?: string;
}

export interface ChatEntry {
  id: string;
  kind: "user" | "assistant" | "reasoning" | "tool" | "command" | "status" | "error";
  text: string;
  title?: string;
  state?: "running" | "complete" | "failed";
}

export interface ModelOption {
  id: string;
  label: string;
  supportedReasoningEfforts?: ReasoningEffortOption[];
  defaultReasoningEffort?: string;
  isDefault?: boolean;
}

export interface ReasoningEffortOption {
  reasoningEffort: string;
  description?: string;
}

export interface ThreadOption {
  id: string;
  title: string;
  updatedAt: string;
  active: boolean;
  status?: "idle" | "running" | "attention";
}

export type ResearchMode = "ask" | "agent";

export type ResearchContextKind =
  | "paper"
  | "page"
  | "selection"
  | "annotation"
  | "library"
  | "collection"
  | "external-paper";

export interface ResearchContextChip {
  id: string;
  kind: ResearchContextKind;
  label: string;
  detail?: string;
  removable?: boolean;
}

export interface ResearchContextSuggestion extends ResearchContextChip {
  disabled?: boolean;
}

export interface ResearchPlanStep {
  id: string;
  title: string;
  status: "pending" | "running" | "complete" | "failed";
}

export interface ResearchPlan {
  id: string;
  title?: string;
  explanation?: string;
  steps: ResearchPlanStep[];
}

export interface DiffReview {
  id: string;
  title: string;
  summary?: string;
  diff: string;
  state?: "pending" | "accepted" | "rejected" | "failed";
}

export interface PendingApproval {
  id: string;
  title: string;
  description?: string;
  command?: string;
  kind?: "tool" | "command" | "permission";
  risk?: "low" | "medium" | "high";
}

export interface CheckpointOption {
  id: string;
  label: string;
  createdAt?: string;
}

export interface SidebarState {
  phase: SidebarPhase;
  accountLabel?: string;
  error?: string;
  context?: PaperContextView | null;
  entries: ChatEntry[];
  models: ModelOption[];
  threads: ThreadOption[];
  selectedModel: string;
  effort: string;
  running: boolean;
  threadTitle?: string;
  mode: ResearchMode;
  contextChips: ResearchContextChip[];
  contextSuggestions: ResearchContextSuggestion[];
  plan: ResearchPlan | null;
  reviews: DiffReview[];
  pendingApproval: PendingApproval | null;
  checkpoints: CheckpointOption[];
  turnStartedAt: number | null;
  turnDurations: Record<string, number>;
}

export interface SidebarCallbacks {
  onSend(text: string): void;
  onStop(): void;
  onNewThread(): void;
  onSelectThread(threadId: string): void;
  onLogin(): void;
  onLogout(): void;
  onOpenTerminal(): void;
  onRefreshContext(): void;
  onInsertSelection(): void;
  onModelChange(model: string): void;
  onEffortChange(effort: string): void;
  onModeChange?(mode: ResearchMode): void;
  onAddContext?(context: ResearchContextSuggestion): void;
  onRemoveContext?(contextId: string): void;
  onReviewDecision?(reviewId: string, decision: "accept" | "reject"): void;
  onApprovalDecision?(approvalId: string, decision: "approve-once" | "reject"): void;
  onRestoreCheckpoint?(checkpointId: string): void;
}

export type SidebarIcon = "history" | "new" | "terminal" | "more" | "refresh" | "send" | "stop" | "context" | "close" | "copy";

export class SidebarView {
  private readonly doc: Document;
  private readonly root: HTMLElement;
  private transcript!: HTMLElement;
  private textarea!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private modelSelect!: HTMLSelectElement;
  private effortSelect!: HTMLSelectElement;
  private modeSelect!: HTMLSelectElement;
  private safetyChip!: HTMLElement;
  private contextTitle!: HTMLElement;
  private contextMeta!: HTMLElement;
  private contextChips!: HTMLElement;
  private contextMenu!: HTMLElement;
  private contextMenuList!: HTMLElement;
  private contextMenuEmpty!: HTMLElement;
  private threadTabs!: HTMLElement;
  private statusArea!: HTMLElement;
  private loginLayer!: HTMLElement;
  private threadTitle!: HTMLElement;
  private accountButton!: HTMLButtonElement;
  private state: SidebarState;
  private readonly entryNodes = new Map<string, { fingerprint: string; node: HTMLElement }>();
  private emptyState: HTMLElement | null = null;
  private contextMenuOpen = false;
  private contextMenuQuery = "";
  private contextMenuSelection = 0;
  private contextQueryStart: number | null = null;
  private readonly expandedTurns = new Set<string>();
  private activityTimer: number | null = null;
  private pinnedToBottom = true;
  private lastActiveThreadId: string | undefined = undefined;

  constructor(
    body: HTMLElement,
    private readonly callbacks: SidebarCallbacks
  ) {
    this.doc = body.ownerDocument;
    this.root = this.doc.createElement("section");
    this.root.className = "zc-sidebar";
    body.replaceChildren(this.root);
    this.state = {
      phase: "connecting",
      entries: [],
      models: [],
      threads: [],
      selectedModel: "",
      effort: "medium",
      mode: "ask",
      running: false,
      context: null,
      contextChips: [],
      contextSuggestions: [],
      plan: null,
      reviews: [],
      pendingApproval: null,
      checkpoints: [],
      turnStartedAt: null,
      turnDurations: {},
    };
    this.build();
    this.render();
  }

  destroy(): void {
    if (this.activityTimer !== null) {
      this.doc.defaultView?.clearInterval(this.activityTimer);
      this.activityTimer = null;
    }
    this.root.remove();
  }

  setState(next: Partial<SidebarState>): void {
    this.state = { ...this.state, ...next };
    this.render();
  }

  focusComposer(text?: string): void {
    if (text !== undefined) {
      const prefix = this.textarea.value.trim() ? `${this.textarea.value.trim()}\n\n` : "";
      this.textarea.value = prefix + text;
      this.autoSizeComposer();
    }
    this.textarea.focus();
  }

  revealComposer(): void {
    this.textarea.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private build(): void {
    const topbar = this.doc.createElement("header");
    topbar.className = "zc-topbar";

    const identity = this.doc.createElement("div");
    identity.className = "zc-identity";
    const icon = this.doc.createElement("img");
    icon.src = "chrome://zotkit/content/icons/icon.svg";
    icon.alt = "";
    const titles = this.doc.createElement("div");
    const product = this.doc.createElement("div");
    product.className = "zc-product-title";
    product.textContent = "Research Chat";
    this.threadTitle = this.doc.createElement("div");
    this.threadTitle.className = "zc-thread-title";
    this.threadTitle.textContent = "论文助手";
    titles.append(product, this.threadTitle);
    identity.append(icon, titles);

    const actions = this.doc.createElement("div");
    actions.className = "zc-top-actions";
    const historyButton = this.iconButton("history", "对话历史", () => this.toggleHistoryMenu());
    const newButton = this.iconButton("new", "新对话", () => this.callbacks.onNewThread());
    const terminalButton = this.iconButton(
      "terminal",
      "打开高级 CLI 终端",
      () => this.callbacks.onOpenTerminal(),
      "Terminal",
    );
    terminalButton.classList.add("zc-terminal-button");
    this.accountButton = this.iconButton("more", "账户", () => this.toggleAccountMenu());
    actions.append(historyButton, newButton, terminalButton, this.accountButton);
    topbar.append(identity, actions);

    this.threadTabs = this.doc.createElement("nav");
    this.threadTabs.className = "zc-thread-tabs";
    this.threadTabs.setAttribute("aria-label", "论文对话标签");

    const contextCard = this.doc.createElement("section");
    contextCard.className = "zc-context-card";
    const contextIcon = this.doc.createElement("div");
    contextIcon.className = "zc-pdf-icon";
    contextIcon.textContent = "PDF";
    const contextCopy = this.doc.createElement("div");
    contextCopy.className = "zc-context-copy";
    this.contextTitle = this.doc.createElement("div");
    this.contextTitle.className = "zc-context-title";
    this.contextMeta = this.doc.createElement("div");
    this.contextMeta.className = "zc-context-meta";
    contextCopy.append(this.contextTitle, this.contextMeta);
    const refresh = this.iconButton("refresh", "刷新 Reader 上下文", () => this.callbacks.onRefreshContext());
    contextCard.append(contextIcon, contextCopy, refresh);

    this.transcript = this.doc.createElement("main");
    this.transcript.className = "zc-transcript";
    this.transcript.addEventListener("scroll", () => {
      const { scrollTop, clientHeight, scrollHeight } = this.transcript;
      this.pinnedToBottom = scrollTop + clientHeight >= scrollHeight - 4;
    });

    const composerWrap = this.doc.createElement("footer");
    composerWrap.className = "zc-composer-wrap";
    const composer = this.doc.createElement("div");
    composer.className = "zc-composer";
    this.contextChips = this.doc.createElement("div");
    this.contextChips.className = "zc-composer-chips";
    const addContext = this.iconButton("context", "添加论文上下文（@）", () => {
      this.openContextMenu("");
      this.textarea.focus();
    });
    addContext.classList.add("zc-add-context-button");
    this.contextChips.appendChild(addContext);

    this.contextMenu = this.doc.createElement("section");
    this.contextMenu.className = "zc-context-menu";
    this.contextMenu.hidden = true;
    const contextMenuHeader = this.doc.createElement("header");
    contextMenuHeader.textContent = "添加上下文";
    const contextMenuHint = this.doc.createElement("span");
    contextMenuHint.textContent = "输入 @ 快速筛选";
    contextMenuHeader.appendChild(contextMenuHint);
    this.contextMenuList = this.doc.createElement("div");
    this.contextMenuList.className = "zc-context-menu-list";
    this.contextMenuList.setAttribute("role", "listbox");
    this.contextMenuEmpty = this.doc.createElement("div");
    this.contextMenuEmpty.className = "zc-context-menu-empty";
    this.contextMenuEmpty.textContent = "没有匹配的上下文";
    this.contextMenu.append(contextMenuHeader, this.contextMenuList, this.contextMenuEmpty);

    this.textarea = this.doc.createElement("textarea");
    this.textarea.className = "zc-composer-input";
    this.textarea.rows = 1;
    this.textarea.placeholder = "询问这篇论文…";
    this.textarea.addEventListener("input", () => {
      this.autoSizeComposer();
      this.updateContextMenuFromComposer();
    });
    this.textarea.addEventListener("keydown", (event) => {
      if (this.handleContextMenuKeydown(event)) return;
      if (event.key === "Escape" && this.state.running && !event.isComposing) {
        event.preventDefault();
        this.callbacks.onStop();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.submit();
      }
    });
    const composerFooter = this.doc.createElement("div");
    composerFooter.className = "zc-composer-footer";
    const controls = this.doc.createElement("div");
    controls.className = "zc-composer-controls";
    this.modeSelect = this.doc.createElement("select");
    this.modeSelect.className = "zc-compact-select zc-mode-picker";
    this.modeSelect.title = "研究模式";
    for (const [value, label] of [["ask", "Ask"], ["agent", "Agent"]] as const) {
      const option = this.doc.createElement("option");
      option.value = value;
      option.textContent = label;
      this.modeSelect.appendChild(option);
    }
    this.modeSelect.addEventListener("change", () => {
      this.callbacks.onModeChange?.(this.modeSelect.value as ResearchMode);
    });
    this.modelSelect = this.doc.createElement("select");
    this.modelSelect.className = "zc-compact-select";
    this.modelSelect.title = "模型";
    this.modelSelect.addEventListener("change", () => {
      this.renderEfforts(this.modelSelect.value, true);
      this.callbacks.onModelChange(this.modelSelect.value);
    });
    this.effortSelect = this.doc.createElement("select");
    this.effortSelect.className = "zc-compact-select";
    this.effortSelect.title = "思考强度";
    this.effortSelect.addEventListener("change", () => this.callbacks.onEffortChange(this.effortSelect.value));
    this.safetyChip = this.doc.createElement("span");
    this.safetyChip.className = "zc-safety-chip";
    controls.append(this.modeSelect, this.modelSelect, this.effortSelect, this.safetyChip);
    this.sendButton = this.doc.createElement("button");
    this.sendButton.type = "button";
    this.sendButton.className = "zc-send-button";
    this.sendButton.addEventListener("click", () => this.submit());
    this.stopButton = this.doc.createElement("button");
    this.stopButton.type = "button";
    this.stopButton.className = "zc-send-button is-running";
    this.setButtonIcon(this.stopButton, "stop");
    this.stopButton.title = "停止生成（Esc）";
    this.stopButton.setAttribute("aria-label", this.stopButton.title);
    this.stopButton.addEventListener("click", () => this.callbacks.onStop());
    const composerActions = this.doc.createElement("div");
    composerActions.style.cssText = "display:flex;align-items:center;gap:6px";
    composerActions.append(this.stopButton, this.sendButton);
    composerFooter.append(controls, composerActions);
    composer.append(this.contextChips, this.contextMenu, this.textarea, composerFooter);
    this.statusArea = this.doc.createElement("div");
    this.statusArea.className = "zc-status-area";
    composerWrap.append(composer, this.statusArea);

    this.loginLayer = this.doc.createElement("div");
    this.loginLayer.className = "zc-login-layer";

    this.root.append(
      topbar,
      this.threadTabs,
      contextCard,
      this.transcript,
      composerWrap,
      this.loginLayer,
    );
  }

  private render(): void {
    this.threadTitle.textContent = this.state.threadTitle || "论文助手";
    this.modeSelect.value = this.state.mode;
    this.root.dataset.mode = this.state.mode;
    this.safetyChip.textContent = this.state.mode === "ask" ? "只读" : "需审批";
    this.safetyChip.title = this.state.mode === "ask"
      ? "Ask 模式只读取论文与文库上下文"
      : "Agent 模式的命令、文件或文库变更必须经过审批";
    this.renderThreadTabs();
    this.renderContext();
    this.renderContextChips();
    this.renderContextMenu();
    this.renderModels();
    this.renderEfforts();
    this.renderTranscript();
    this.renderLoginLayer();
    this.setButtonIcon(this.sendButton, "send");
    this.sendButton.title = this.state.running ? "发送补充" : "发送";
    this.sendButton.setAttribute("aria-label", this.sendButton.title);
    this.stopButton.hidden = !this.state.running;
    this.stopButton.style.display = this.state.running ? "grid" : "none";
    this.textarea.disabled = this.state.phase !== "ready";
    this.statusArea.textContent = this.state.error || (this.state.running
      ? "Enter 发送补充 · Esc 停止生成"
      : "Codex 可能会出错，请核对论文原文与页码。");
    this.statusArea.classList.toggle("is-error", Boolean(this.state.error));
  }

  private renderContext(): void {
    const context = this.state.context;
    if (!context) {
      this.contextTitle.textContent = "请先在 Zotero 中打开一篇 PDF";
      this.contextMeta.textContent = "切换论文时，对话也会自动切换";
      return;
    }
    this.contextTitle.textContent = context.title || "当前 PDF";
    const pieces = [
      context.pageLabel ? `第 ${context.pageLabel} 页` : "PDF 已连接",
      context.pagesCount ? `共 ${context.pagesCount} 页` : "",
      context.selectionText ? `选区 ${context.selectionText.length} 字` : "未选中文本"
    ].filter(Boolean);
    this.contextMeta.textContent = pieces.join(" · ");
  }

  private renderThreadTabs(): void {
    this.threadTabs.replaceChildren();
    this.threadTabs.hidden = this.state.threads.length === 0;
    if (!this.state.threads.length) return;
    const scroller = this.doc.createElement("div");
    scroller.className = "zc-thread-tab-scroll";
    for (const thread of this.state.threads.slice(0, 12)) {
      const button = this.doc.createElement("button");
      button.type = "button";
      button.className = "zc-thread-tab";
      button.classList.toggle("is-active", thread.active);
      button.dataset.threadId = thread.id;
      button.title = thread.title || "论文对话";
      if (thread.active) button.setAttribute("aria-current", "page");
      const state = this.doc.createElement("span");
      state.className = `zc-thread-tab-state is-${thread.status || "idle"}`;
      state.setAttribute("aria-hidden", "true");
      const label = this.doc.createElement("span");
      label.textContent = thread.title || "论文对话";
      button.append(state, label);
      button.addEventListener("click", () => this.callbacks.onSelectThread(thread.id));
      scroller.appendChild(button);
    }
    const add = this.iconButton("new", "新对话", () => this.callbacks.onNewThread());
    add.classList.add("zc-thread-tab-add");
    this.threadTabs.append(scroller, add);
  }

  private renderContextChips(): void {
    this.contextChips.replaceChildren();
    for (const chip of this.effectiveContextChips()) {
      const wrapper = this.doc.createElement("span");
      wrapper.className = `zc-context-chip is-${chip.kind}`;
      wrapper.dataset.contextId = chip.id;
      wrapper.title = chip.detail || chip.label;
      const icon = this.doc.createElement("span");
      icon.className = "zc-context-chip-icon";
      icon.textContent = contextGlyph(chip.kind);
      icon.setAttribute("aria-hidden", "true");
      const label = this.doc.createElement("span");
      label.className = "zc-context-chip-label";
      label.textContent = chip.label;
      wrapper.append(icon, label);
      if (chip.removable) {
        const remove = this.iconButton("close", `移除上下文：${chip.label}`, () => {
          this.callbacks.onRemoveContext?.(chip.id);
        });
        remove.classList.add("zc-context-chip-remove");
        wrapper.appendChild(remove);
      }
      this.contextChips.appendChild(wrapper);
    }
    const add = this.iconButton("context", "添加论文上下文（@）", () => {
      this.openContextMenu("");
      this.textarea.focus();
    });
    add.classList.add("zc-add-context-button");
    this.contextChips.appendChild(add);
  }

  private effectiveContextChips(): ResearchContextChip[] {
    if (this.state.contextChips.length) return this.state.contextChips;
    const context = this.state.context;
    if (!context) return [];
    const chips: ResearchContextChip[] = [{
      id: "active-paper",
      kind: "paper",
      label: "当前论文",
      detail: context.title,
      removable: false,
    }];
    if (context.pageLabel) {
      chips.push({
        id: "current-page",
        kind: "page",
        label: `第 ${context.pageLabel} 页`,
        removable: true,
      });
    }
    if (context.selectionText) {
      chips.push({
        id: "current-selection",
        kind: "selection",
        label: `选区 · ${context.selectionText.length} 字`,
        removable: true,
      });
    }
    return chips;
  }

  private effectiveContextSuggestions(): ResearchContextSuggestion[] {
    if (this.state.contextSuggestions.length) return this.state.contextSuggestions;
    const context = this.state.context;
    const suggestions: ResearchContextSuggestion[] = [
      {
        id: "active-paper",
        kind: "paper",
        label: "当前论文",
        detail: context?.title || "Zotero Reader 中打开的 PDF",
        disabled: !context,
      },
      {
        id: "current-page",
        kind: "page",
        label: context?.pageLabel ? `当前页 · 第 ${context.pageLabel} 页` : "当前页",
        detail: "当前可见 PDF 页面的文字",
        disabled: !context,
      },
      {
        id: "current-selection",
        kind: "selection",
        label: "当前选区",
        detail: context?.selectionText
          ? `${context.selectionText.length} 字`
          : "请先在 PDF 中选择文字",
        disabled: !context?.selectionText,
      },
      {
        id: "active-annotations",
        kind: "annotation",
        label: "这篇论文的批注",
        detail: "按需读取高亮、评论与页码",
        disabled: !context,
      },
      {
        id: "zotero-library",
        kind: "library",
        label: "Zotero 文库",
        detail: "搜索其他论文、分类与标签",
      },
    ];
    return suggestions;
  }

  private filteredContextSuggestions(): ResearchContextSuggestion[] {
    const query = this.contextMenuQuery.trim().toLocaleLowerCase();
    if (!query) return this.effectiveContextSuggestions();
    return this.effectiveContextSuggestions().filter((suggestion) => [
      suggestion.label,
      suggestion.detail || "",
      suggestion.kind,
    ].join(" ").toLocaleLowerCase().includes(query));
  }

  private renderContextMenu(): void {
    const suggestions = this.filteredContextSuggestions();
    this.contextMenu.hidden = !this.contextMenuOpen;
    this.contextMenuList.replaceChildren();
    this.contextMenuEmpty.hidden = suggestions.length > 0;
    if (!this.contextMenuOpen) return;
    this.contextMenuSelection = Math.min(
      this.contextMenuSelection,
      Math.max(0, suggestions.length - 1),
    );
    if (suggestions[this.contextMenuSelection]?.disabled) {
      const enabledIndex = suggestions.findIndex((suggestion) => !suggestion.disabled);
      if (enabledIndex >= 0) this.contextMenuSelection = enabledIndex;
    }
    suggestions.forEach((suggestion, index) => {
      const button = this.doc.createElement("button");
      button.type = "button";
      button.className = "zc-context-option";
      button.classList.toggle("is-selected", index === this.contextMenuSelection);
      button.disabled = Boolean(suggestion.disabled);
      button.dataset.contextId = suggestion.id;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === this.contextMenuSelection));
      const mark = this.doc.createElement("span");
      mark.className = `zc-context-option-mark is-${suggestion.kind}`;
      mark.textContent = contextGlyph(suggestion.kind);
      const copy = this.doc.createElement("span");
      const title = this.doc.createElement("strong");
      title.textContent = suggestion.label;
      const detail = this.doc.createElement("small");
      detail.textContent = suggestion.detail || contextKindLabel(suggestion.kind);
      copy.append(title, detail);
      button.append(mark, copy);
      button.addEventListener("mouseenter", () => {
        this.contextMenuSelection = index;
        for (const [optionIndex, option] of [
          ...this.contextMenuList.querySelectorAll<HTMLElement>(".zc-context-option"),
        ].entries()) {
          const selected = optionIndex === index;
          option.classList.toggle("is-selected", selected);
          option.setAttribute("aria-selected", String(selected));
        }
      });
      button.addEventListener("click", () => this.chooseContextSuggestion(suggestion));
      this.contextMenuList.appendChild(button);
    });
  }

  private openContextMenu(query: string, queryStart: number | null = null): void {
    this.contextMenuOpen = true;
    this.contextMenuQuery = query;
    this.contextQueryStart = queryStart;
    this.contextMenuSelection = 0;
    this.renderContextMenu();
  }

  private closeContextMenu(): void {
    this.contextMenuOpen = false;
    this.contextMenuQuery = "";
    this.contextQueryStart = null;
    this.contextMenuSelection = 0;
    this.renderContextMenu();
  }

  private updateContextMenuFromComposer(): void {
    const cursor = this.textarea.selectionStart ?? this.textarea.value.length;
    const beforeCursor = this.textarea.value.slice(0, cursor);
    const match = /(?:^|\s)@([^\s@]*)$/u.exec(beforeCursor);
    if (!match) {
      if (this.contextQueryStart !== null) this.closeContextMenu();
      return;
    }
    const query = match[1] || "";
    const queryStart = cursor - query.length - 1;
    this.openContextMenu(query, queryStart);
  }

  private handleContextMenuKeydown(event: KeyboardEvent): boolean {
    if (!this.contextMenuOpen || event.isComposing) return false;
    const suggestions = this.filteredContextSuggestions();
    if (event.key === "Escape") {
      event.preventDefault();
      this.closeContextMenu();
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!suggestions.length) return true;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      let index = this.contextMenuSelection;
      for (let attempts = 0; attempts < suggestions.length; attempts++) {
        index = (index + direction + suggestions.length) % suggestions.length;
        if (!suggestions[index]?.disabled) break;
      }
      this.contextMenuSelection = index;
      this.renderContextMenu();
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const suggestion = suggestions[this.contextMenuSelection];
      if (!suggestion || suggestion.disabled) {
        this.closeContextMenu();
        return true;
      }
      this.chooseContextSuggestion(suggestion);
      return true;
    }
    return false;
  }

  private chooseContextSuggestion(suggestion: ResearchContextSuggestion): void {
    if (suggestion.disabled) return;
    if (this.contextQueryStart !== null) {
      const cursor = this.textarea.selectionStart ?? this.textarea.value.length;
      const before = this.textarea.value.slice(0, this.contextQueryStart);
      const after = this.textarea.value.slice(cursor);
      const spacer = before && !/\s$/u.test(before) && after && !/^\s/u.test(after) ? " " : "";
      this.textarea.value = before + spacer + after;
      const nextCursor = before.length + spacer.length;
      this.textarea.setSelectionRange(nextCursor, nextCursor);
      this.autoSizeComposer();
    }
    this.callbacks.onAddContext?.(suggestion);
    if (!this.callbacks.onAddContext && suggestion.kind === "selection") {
      this.callbacks.onInsertSelection();
    }
    this.closeContextMenu();
    this.textarea.focus();
  }

  private renderModels(): void {
    const previous = this.modelSelect.value;
    this.modelSelect.replaceChildren();
    const models = this.state.models.length
      ? this.state.models
      : [{ id: "", label: "默认模型" }];
    for (const model of models) {
      const option = this.doc.createElement("option");
      option.value = model.id;
      option.textContent = model.label;
      this.modelSelect.appendChild(option);
    }
    this.modelSelect.value = this.state.selectedModel || previous || models[0]?.id || "";
  }

  private renderEfforts(modelId = this.modelSelect.value, preferModelDefault = false): void {
    const model = this.state.models.find((candidate) => candidate.id === modelId);
    const efforts = model?.supportedReasoningEfforts?.length
      ? model.supportedReasoningEfforts
      : FALLBACK_REASONING_EFFORTS;
    const supported = new Set(efforts.map((option) => option.reasoningEffort));
    const modelDefault = model?.defaultReasoningEffort;
    const selected = preferModelDefault || !supported.has(this.state.effort)
      ? (modelDefault && supported.has(modelDefault) ? modelDefault : efforts[0]?.reasoningEffort || "medium")
      : this.state.effort;
    this.effortSelect.replaceChildren();
    for (const effort of efforts) {
      const option = this.doc.createElement("option");
      option.value = effort.reasoningEffort;
      option.textContent = `思考 ${effortLabel(effort.reasoningEffort)}`;
      if (effort.description) option.title = effort.description;
      this.effortSelect.appendChild(option);
    }
    this.effortSelect.value = selected;
  }

  private renderTranscript(): void {
    const desired: HTMLElement[] = [];
    const activeIDs = new Set<string>();
    const hasWorkbenchCards = Boolean(
      this.state.plan
      || this.state.reviews.length
      || this.state.pendingApproval
      || this.state.checkpoints.length,
    );
    if (!this.state.entries.length && !hasWorkbenchCards && this.state.phase === "ready") {
      this.emptyState ||= this.createEmptyState();
      const title = this.emptyState.querySelector("h2");
      const subtitle = this.emptyState.querySelector("p");
      if (title) title.textContent = this.state.context ? "和当前论文一起思考" : "打开一篇 PDF 开始";
      if (subtitle) {
        subtitle.textContent = this.state.context
          ? "Codex 能按需读取当前页、选区、全文和批注，并在回答中给出位置。"
          : "插件会自动识别当前论文，不需要复制文件路径。";
      }
      desired.push(this.emptyState);
    }

    if (this.state.plan) {
      const plan = this.state.plan;
      const id = `research-plan:${plan.id}`;
      const fingerprint = JSON.stringify(plan);
      activeIDs.add(id);
      desired.push(this.cachedEntryNode(id, fingerprint, () => this.renderPlanCard(plan)));
    }

    let activityGroup: Exchange | null = null;
    const groups = groupEntries(this.state.entries);
    groups.forEach((group, index) => {
      for (const entry of contentEntries(group)) {
        activeIDs.add(entry.id);
        const fingerprint = JSON.stringify([
          entry.kind,
          entry.text,
          entry.title || "",
          entry.state || ""
        ]);
        desired.push(this.cachedEntryNode(entry.id, fingerprint, () => this.renderEntry(entry)));
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
      const summaryId = `turn-summary:${group.id}`;
      const expanded = this.expandedTurns.has(group.id);
      activeIDs.add(summaryId);
      const summaryFingerprint = JSON.stringify([elapsed ?? null, steps, expanded]);
      desired.push(this.cachedEntryNode(
        summaryId,
        summaryFingerprint,
        () => this.renderTurnSummary(group, steps, elapsed),
      ));
      if (expanded) {
        const detailId = `turn-detail:${group.id}`;
        const processes = processEntries(group);
        activeIDs.add(detailId);
        const detailFingerprint = JSON.stringify(
          processes.map((entry) => [entry.id, entry.kind, entry.text, entry.title || "", entry.state || ""]),
        );
        desired.push(this.cachedEntryNode(
          detailId,
          detailFingerprint,
          () => this.renderTurnDetail(processes),
        ));
      }
    });
    const groupIds = new Set(groups.map((group) => group.id));
    for (const id of this.expandedTurns) {
      if (!groupIds.has(id)) this.expandedTurns.delete(id);
    }

    for (const review of this.state.reviews) {
      const id = `diff-review:${review.id}`;
      const fingerprint = JSON.stringify(review);
      activeIDs.add(id);
      desired.push(this.cachedEntryNode(id, fingerprint, () => this.renderDiffReview(review)));
    }

    if (this.state.pendingApproval) {
      const approval = this.state.pendingApproval;
      const id = `approval:${approval.id}`;
      const fingerprint = JSON.stringify(approval);
      activeIDs.add(id);
      desired.push(this.cachedEntryNode(id, fingerprint, () => this.renderApprovalCard(approval)));
    }

    if (this.state.checkpoints.length) {
      const id = "research-checkpoints";
      const fingerprint = JSON.stringify(this.state.checkpoints);
      activeIDs.add(id);
      desired.push(this.cachedEntryNode(
        id,
        fingerprint,
        () => this.renderCheckpointCard(this.state.checkpoints),
      ));
    }
    if (activityGroup) desired.push(this.renderActivityLine(activityGroup));
    for (const id of this.entryNodes.keys()) {
      if (!activeIDs.has(id)) this.entryNodes.delete(id);
    }
    reconcileChildren(this.transcript, desired);
    const activeThreadId = this.state.threads.find((thread) => thread.active)?.id;
    if (activeThreadId !== this.lastActiveThreadId) {
      this.pinnedToBottom = true;
    }
    this.lastActiveThreadId = activeThreadId;
    if (this.pinnedToBottom) {
      this.transcript.scrollTop = this.transcript.scrollHeight;
    }
    this.syncActivityTimer();
  }

  private cachedEntryNode(
    id: string,
    fingerprint: string,
    create: () => HTMLElement,
  ): HTMLElement {
    const existing = this.entryNodes.get(id);
    if (existing?.fingerprint === fingerprint) return existing.node;
    const node = create();
    const previousDetails = existing?.node.querySelector("details");
    const nextDetails = node.querySelector("details");
    if (previousDetails && nextDetails) nextDetails.open = previousDetails.open;
    this.entryNodes.set(id, { fingerprint, node });
    return node;
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

  private renderActivityLine(group: Exchange): HTMLElement {
    const line = this.doc.createElement("div");
    line.className = "zc-activity";
    const spinner = this.doc.createElement("span");
    spinner.className = "zc-activity-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const label = this.doc.createElement("span");
    label.className = "zc-activity-label";
    label.textContent = activityLabel(group.entries);
    line.append(spinner, label);
    if (this.state.turnStartedAt !== null) {
      const elapsed = this.doc.createElement("span");
      elapsed.className = "zc-activity-elapsed";
      elapsed.textContent = formatElapsed(Date.now() - this.state.turnStartedAt);
      line.appendChild(elapsed);
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

  private createEmptyState(): HTMLElement {
    const empty = this.doc.createElement("div");
    empty.className = "zc-empty-state";
    const mark = this.doc.createElement("img");
    mark.src = "chrome://zotkit/content/icons/icon.svg";
    mark.alt = "";
    const title = this.doc.createElement("h2");
    const subtitle = this.doc.createElement("p");
    const suggestions = this.doc.createElement("div");
    suggestions.className = "zc-suggestions";
    for (const prompt of ["解释当前选中的段落", "总结本页的核心论证", "这篇论文有哪些关键假设？"]) {
      const button = this.doc.createElement("button");
      button.type = "button";
      button.textContent = prompt;
      button.addEventListener("click", () => this.focusComposer(prompt));
      suggestions.appendChild(button);
    }
    empty.append(mark, title, subtitle, suggestions);
    return empty;
  }

  private renderPlanCard(plan: ResearchPlan): HTMLElement {
    const article = this.doc.createElement("article");
    article.className = "zc-entry zc-plan-card";
    article.dataset.entryId = `research-plan:${plan.id}`;
    const details = this.doc.createElement("details");
    details.open = true;
    const summary = this.doc.createElement("summary");
    const title = this.doc.createElement("span");
    title.textContent = plan.title || "研究计划";
    const progress = this.doc.createElement("small");
    const complete = plan.steps.filter((step) => step.status === "complete").length;
    progress.textContent = `${complete}/${plan.steps.length}`;
    summary.append(title, progress);
    const body = this.doc.createElement("div");
    body.className = "zc-plan-body";
    if (plan.explanation) {
      const explanation = this.doc.createElement("p");
      explanation.textContent = plan.explanation;
      body.appendChild(explanation);
    }
    const list = this.doc.createElement("ol");
    for (const step of plan.steps) {
      const item = this.doc.createElement("li");
      item.className = `is-${step.status}`;
      item.dataset.planStepId = step.id;
      const state = this.doc.createElement("span");
      state.className = "zc-plan-step-state";
      state.textContent = step.status === "complete" ? "✓"
        : step.status === "failed" ? "!"
          : step.status === "running" ? "◌" : "";
      const label = this.doc.createElement("span");
      label.textContent = step.title;
      item.append(state, label);
      list.appendChild(item);
    }
    body.appendChild(list);
    details.append(summary, body);
    article.appendChild(details);
    return article;
  }

  private renderDiffReview(review: DiffReview): HTMLElement {
    const article = this.doc.createElement("article");
    article.className = `zc-entry zc-review-card is-${review.state || "pending"}`;
    article.dataset.entryId = `diff-review:${review.id}`;
    const details = this.doc.createElement("details");
    details.open = review.state === undefined || review.state === "pending";
    const summary = this.doc.createElement("summary");
    const identity = this.doc.createElement("span");
    identity.textContent = review.title;
    const badge = this.doc.createElement("small");
    badge.textContent = review.state === "accepted" ? "已接受"
      : review.state === "rejected" ? "已忽略"
        : review.state === "failed" ? "应用失败" : "Review";
    summary.append(identity, badge);
    const body = this.doc.createElement("div");
    body.className = "zc-review-body";
    if (review.summary) {
      const description = this.doc.createElement("p");
      description.textContent = review.summary;
      body.appendChild(description);
    }
    const diff = this.doc.createElement("pre");
    diff.className = "zc-diff-view";
    for (const line of review.diff.replace(/\r\n?/g, "\n").split("\n")) {
      const row = this.doc.createElement("span");
      row.className = line.startsWith("+") && !line.startsWith("+++") ? "is-addition"
        : line.startsWith("-") && !line.startsWith("---") ? "is-deletion"
          : line.startsWith("@@") ? "is-hunk" : "is-context";
      row.textContent = line || " ";
      diff.append(row, this.doc.createTextNode("\n"));
    }
    const actions = this.doc.createElement("div");
    actions.className = "zc-review-actions";
    const reject = this.doc.createElement("button");
    reject.type = "button";
    reject.textContent = "忽略";
    reject.disabled = Boolean(review.state && review.state !== "pending");
    reject.addEventListener("click", () => this.callbacks.onReviewDecision?.(review.id, "reject"));
    const accept = this.doc.createElement("button");
    accept.type = "button";
    accept.className = "is-primary";
    accept.textContent = "接受建议";
    accept.disabled = Boolean(review.state && review.state !== "pending");
    accept.addEventListener("click", () => this.callbacks.onReviewDecision?.(review.id, "accept"));
    actions.append(reject, accept);
    body.append(diff, actions);
    details.append(summary, body);
    article.appendChild(details);
    return article;
  }

  private renderApprovalCard(approval: PendingApproval): HTMLElement {
    const article = this.doc.createElement("article");
    article.className = `zc-entry zc-approval-card is-${approval.risk || "medium"}`;
    article.dataset.entryId = `approval:${approval.id}`;
    const heading = this.doc.createElement("div");
    heading.className = "zc-approval-heading";
    const badge = this.doc.createElement("span");
    badge.textContent = approval.kind === "command" ? "命令审批"
      : approval.kind === "tool" ? "工具审批" : "需要确认";
    const title = this.doc.createElement("strong");
    title.textContent = approval.title;
    heading.append(badge, title);
    article.appendChild(heading);
    if (approval.description) {
      const description = this.doc.createElement("p");
      description.textContent = approval.description;
      article.appendChild(description);
    }
    if (approval.command) {
      const command = this.doc.createElement("code");
      command.textContent = approval.command;
      article.appendChild(command);
    }
    const actions = this.doc.createElement("div");
    actions.className = "zc-approval-actions";
    const reject = this.doc.createElement("button");
    reject.type = "button";
    reject.textContent = "拒绝";
    reject.addEventListener("click", () => {
      this.callbacks.onApprovalDecision?.(approval.id, "reject");
    });
    const approve = this.doc.createElement("button");
    approve.type = "button";
    approve.className = "is-primary";
    approve.textContent = "仅允许这一次";
    approve.addEventListener("click", () => {
      this.callbacks.onApprovalDecision?.(approval.id, "approve-once");
    });
    actions.append(reject, approve);
    article.appendChild(actions);
    return article;
  }

  private renderCheckpointCard(checkpoints: CheckpointOption[]): HTMLElement {
    const article = this.doc.createElement("article");
    article.className = "zc-entry zc-checkpoint-card";
    article.dataset.entryId = "research-checkpoints";
    const heading = this.doc.createElement("div");
    heading.className = "zc-checkpoint-heading";
    const title = this.doc.createElement("strong");
    title.textContent = "Checkpoints";
    const detail = this.doc.createElement("small");
    detail.textContent = "恢复到先前的研究上下文";
    heading.append(title, detail);
    const list = this.doc.createElement("div");
    list.className = "zc-checkpoint-list";
    for (const checkpoint of checkpoints.slice(0, 4)) {
      const row = this.doc.createElement("div");
      const copy = this.doc.createElement("span");
      const label = this.doc.createElement("strong");
      label.textContent = checkpoint.label;
      const time = this.doc.createElement("small");
      time.textContent = formatDateTime(checkpoint.createdAt);
      copy.append(label, time);
      const restore = this.doc.createElement("button");
      restore.type = "button";
      restore.textContent = "Restore";
      restore.addEventListener("click", () => {
        this.callbacks.onRestoreCheckpoint?.(checkpoint.id);
      });
      row.append(copy, restore);
      list.appendChild(row);
    }
    article.append(heading, list);
    return article;
  }

  private renderEntry(entry: ChatEntry): HTMLElement {
    const article = this.doc.createElement("article");
    article.className = `zc-entry zc-entry-${entry.kind}`;
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
      if (entry.kind === "reasoning") details.open = false;
      const summary = this.doc.createElement("summary");
      const state = this.doc.createElement("span");
      state.className = `zc-tool-state ${entry.state || "complete"}`;
      state.textContent = entry.state === "running" ? "◌" : entry.state === "failed" ? "!" : "✓";
      const label = this.doc.createElement("span");
      label.textContent = entry.title || (entry.kind === "reasoning" ? "思考过程" : "工具");
      summary.append(state, label);
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
    const avatar = this.doc.createElement("img");
    avatar.className = "zc-entry-avatar";
    avatar.src = "chrome://zotkit/content/icons/icon.svg";
    avatar.alt = "Codex";
    const content = this.doc.createElement("div");
    content.className = "zc-entry-content";
    const markdownBody = this.doc.createElement("div");
    markdownBody.className = "zc-markdown";
    markdownBody.appendChild(renderMarkdown(this.doc, entry.text));
    content.appendChild(markdownBody);
    if (entry.kind === "assistant") {
      content.appendChild(this.createCopyAnswerButton(entry.text));
    }
    article.append(avatar, content);
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

  private renderLoginLayer(): void {
    this.loginLayer.replaceChildren();
    this.loginLayer.hidden = this.state.phase === "ready";
    if (this.state.phase === "ready") return;
    const card = this.doc.createElement("div");
    card.className = "zc-login-card";
    const icon = this.doc.createElement("img");
    icon.src = "chrome://zotkit/content/icons/icon.svg";
    icon.alt = "";
    const title = this.doc.createElement("h2");
    const detail = this.doc.createElement("p");
    const button = this.doc.createElement("button");
    button.type = "button";
    button.className = "zc-login-button";
    if (this.state.phase === "connecting") {
      title.textContent = "正在连接 Codex";
      detail.textContent = "读取你已有的 Codex CLI 登录状态…";
      button.hidden = true;
    }
    else if (this.state.phase === "signed-out") {
      title.textContent = "在 Zotero 中使用 Codex";
      detail.textContent = "使用 ChatGPT 登录。登录状态由本机 Codex CLI 管理；插件不会读取或保存令牌。";
      button.textContent = "使用 ChatGPT 登录";
      button.addEventListener("click", () => this.callbacks.onLogin());
    }
    else {
      title.textContent = this.state.phase === "unavailable" ? "未找到 Codex CLI" : "Codex 暂时不可用";
      detail.textContent = this.state.error || "请确认 Codex CLI 已安装，然后重试。";
      button.textContent = "重试";
      button.addEventListener("click", () => this.callbacks.onRefreshContext());
    }
    card.append(icon, title, detail, button);
    if (this.state.phase === "unavailable" || this.state.phase === "error") {
      const terminal = this.doc.createElement("button");
      terminal.type = "button";
      terminal.className = "zc-login-secondary";
      terminal.textContent = "打开高级 Terminal";
      terminal.addEventListener("click", () => this.callbacks.onOpenTerminal());
      card.appendChild(terminal);
    }
    this.loginLayer.appendChild(card);
  }

  private toggleAccountMenu(): void {
    const existing = this.root.querySelector(".zc-account-menu");
    if (existing) {
      existing.remove();
      return;
    }
    const menu = this.doc.createElement("div");
    menu.className = "zc-account-menu";
    const label = this.doc.createElement("div");
    label.textContent = this.state.accountLabel || "Codex";
    const readonly = this.doc.createElement("small");
    readonly.textContent = this.state.mode === "ask"
      ? "Ask：文库只读"
      : "Agent：变更需审批并生成 Checkpoint";
    const logout = this.doc.createElement("button");
    logout.type = "button";
    logout.textContent = "退出 Codex 登录";
    logout.addEventListener("click", () => {
      menu.remove();
      this.callbacks.onLogout();
    });
    menu.append(label, readonly, logout);
    this.root.appendChild(menu);
  }

  private toggleHistoryMenu(): void {
    const existing = this.root.querySelector(".zc-history-menu");
    if (existing) {
      existing.remove();
      return;
    }
    this.root.querySelector(".zc-account-menu")?.remove();
    const menu = this.doc.createElement("div");
    menu.className = "zc-history-menu";
    const heading = this.doc.createElement("div");
    heading.className = "zc-menu-heading";
    heading.textContent = "这篇论文的对话";
    menu.appendChild(heading);
    if (!this.state.threads.length) {
      const empty = this.doc.createElement("small");
      empty.textContent = "还没有历史对话";
      menu.appendChild(empty);
    }
    for (const thread of this.state.threads) {
      const button = this.doc.createElement("button");
      button.type = "button";
      button.className = thread.active ? "is-active" : "";
      const title = this.doc.createElement("span");
      title.textContent = thread.title || "论文对话";
      const time = this.doc.createElement("small");
      const date = new Date(thread.updatedAt);
      time.textContent = Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
      button.append(title, time);
      button.addEventListener("click", () => {
        menu.remove();
        this.callbacks.onSelectThread(thread.id);
      });
      menu.appendChild(button);
    }
    this.root.appendChild(menu);
  }

  private submit(): void {
    const text = this.textarea.value.trim();
    if (!text || this.state.phase !== "ready") return;
    this.closeContextMenu();
    this.textarea.value = "";
    this.autoSizeComposer();
    this.callbacks.onSend(text);
  }

  private autoSizeComposer(): void {
    this.textarea.style.height = "auto";
    this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, 180)}px`;
  }

  private iconButton(
    icon: SidebarIcon,
    title: string,
    onClick: () => void,
    visibleLabel?: string
  ): HTMLButtonElement {
    const button = this.doc.createElement("button");
    button.type = "button";
    button.className = "zc-icon-button";
    button.title = title;
    button.setAttribute("aria-label", title);
    this.setButtonIcon(button, icon);
    if (visibleLabel) {
      const label = this.doc.createElement("span");
      label.className = "zc-button-label";
      label.textContent = visibleLabel;
      button.appendChild(label);
    }
    button.addEventListener("click", onClick);
    return button;
  }

  private setButtonIcon(button: HTMLButtonElement, icon: SidebarIcon): void {
    button.replaceChildren(createSidebarIcon(this.doc, icon));
  }
}

const SIDEBAR_ICON_PATHS: Record<SidebarIcon, string[]> = {
  history: ["M5 6h14", "M5 12h14", "M5 18h14"],
  new: ["M12 5v14", "M5 12h14"],
  terminal: ["M4 5h16v14H4z", "m7 9 3 3-3 3", "M13 15h4"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  refresh: ["M20 6v5h-5", "M4 18v-5h5", "M18.2 9a7 7 0 0 0-11.7-2.5L4 11", "M5.8 15a7 7 0 0 0 11.7 2.5L20 13"],
  send: ["M12 19V5", "M6 11l6-6 6 6"],
  stop: ["M8 8h8v8H8z"],
  context: ["M12 5v14", "M5 12h14", "M4 4h16v16H4z"],
  close: ["m7 7 10 10", "m17 7-10 10"],
  copy: ["M9 9h10v12H9z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"],
};

export function createSidebarIcon(doc: Document, icon: SidebarIcon): SVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("zc-button-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", icon === "more" ? "3" : "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const data of SIDEBAR_ICON_PATHS[icon]) {
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", data);
    svg.appendChild(path);
  }
  return svg;
}

const FALLBACK_REASONING_EFFORTS: ReasoningEffortOption[] = [
  { reasoningEffort: "minimal" },
  { reasoningEffort: "low" },
  { reasoningEffort: "medium" },
  { reasoningEffort: "high" },
  { reasoningEffort: "xhigh" },
  { reasoningEffort: "max" },
  { reasoningEffort: "ultra" }
];

function effortLabel(effort: string): string {
  const labels: Record<string, string> = {
    minimal: "最少",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最大",
    ultra: "Ultra"
  };
  return labels[effort] || effort;
}

function contextGlyph(kind: ResearchContextKind): string {
  const glyphs: Record<ResearchContextKind, string> = {
    paper: "P",
    page: "§",
    selection: "“",
    annotation: "✦",
    library: "⌘",
    collection: "#",
    "external-paper": "P",
  };
  return glyphs[kind];
}

function contextKindLabel(kind: ResearchContextKind): string {
  const labels: Record<ResearchContextKind, string> = {
    paper: "论文",
    page: "PDF 页面",
    selection: "Reader 选区",
    annotation: "Zotero 批注",
    library: "文库",
    collection: "分类",
    "external-paper": "其他论文",
  };
  return labels[kind];
}

function formatDateTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function reconcileChildren(parent: HTMLElement, desired: readonly HTMLElement[]): void {
  let cursor: ChildNode | null = parent.firstChild;
  for (const node of desired) {
    if (node === cursor) {
      cursor = cursor.nextSibling;
      continue;
    }
    parent.insertBefore(node, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}
