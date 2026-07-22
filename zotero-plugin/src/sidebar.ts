import { renderMarkdown } from "./markdown";

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
}

type SidebarIcon = "history" | "new" | "terminal" | "more" | "refresh" | "send" | "stop";

export class SidebarView {
  private readonly doc: Document;
  private readonly root: HTMLElement;
  private transcript!: HTMLElement;
  private textarea!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private modelSelect!: HTMLSelectElement;
  private effortSelect!: HTMLSelectElement;
  private contextTitle!: HTMLElement;
  private contextMeta!: HTMLElement;
  private selectionChip!: HTMLButtonElement;
  private statusArea!: HTMLElement;
  private loginLayer!: HTMLElement;
  private threadTitle!: HTMLElement;
  private accountButton!: HTMLButtonElement;
  private state: SidebarState;
  private readonly entryNodes = new Map<string, { fingerprint: string; node: HTMLElement }>();
  private emptyState: HTMLElement | null = null;

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
      running: false,
      context: null
    };
    this.build();
    this.render();
  }

  destroy(): void {
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
    product.textContent = "Codex";
    this.threadTitle = this.doc.createElement("div");
    this.threadTitle.className = "zc-thread-title";
    this.threadTitle.textContent = "论文助手";
    titles.append(product, this.threadTitle);
    identity.append(icon, titles);

    const actions = this.doc.createElement("div");
    actions.className = "zc-top-actions";
    const historyButton = this.iconButton("history", "对话历史", () => this.toggleHistoryMenu());
    const newButton = this.iconButton("new", "新对话", () => this.callbacks.onNewThread());
    const terminalButton = this.iconButton("terminal", "打开真实 CLI 终端", () => this.callbacks.onOpenTerminal(), "CLI");
    terminalButton.classList.add("zc-terminal-button");
    this.accountButton = this.iconButton("more", "账户", () => this.toggleAccountMenu());
    actions.append(historyButton, newButton, terminalButton, this.accountButton);
    topbar.append(identity, actions);

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

    const composerWrap = this.doc.createElement("footer");
    composerWrap.className = "zc-composer-wrap";
    const composer = this.doc.createElement("div");
    composer.className = "zc-composer";
    const chips = this.doc.createElement("div");
    chips.className = "zc-composer-chips";
    this.selectionChip = this.doc.createElement("button");
    this.selectionChip.type = "button";
    this.selectionChip.className = "zc-context-chip";
    this.selectionChip.addEventListener("click", () => this.callbacks.onInsertSelection());
    chips.appendChild(this.selectionChip);
    this.textarea = this.doc.createElement("textarea");
    this.textarea.className = "zc-composer-input";
    this.textarea.rows = 1;
    this.textarea.placeholder = "询问这篇论文…";
    this.textarea.addEventListener("input", () => this.autoSizeComposer());
    this.textarea.addEventListener("keydown", (event) => {
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
    const safety = this.doc.createElement("span");
    safety.className = "zc-safety-chip";
    safety.textContent = "只读";
    safety.title = "Codex 只能读取插件工作区；不会修改 Zotero 文库";
    controls.append(this.modelSelect, this.effortSelect, safety);
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
    composer.append(chips, this.textarea, composerFooter);
    this.statusArea = this.doc.createElement("div");
    this.statusArea.className = "zc-status-area";
    composerWrap.append(composer, this.statusArea);

    this.loginLayer = this.doc.createElement("div");
    this.loginLayer.className = "zc-login-layer";

    this.root.append(topbar, contextCard, this.transcript, composerWrap, this.loginLayer);
  }

  private render(): void {
    this.threadTitle.textContent = this.state.threadTitle || "论文助手";
    this.renderContext();
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
      this.selectionChip.textContent = "未选中文本";
      this.selectionChip.disabled = true;
      return;
    }
    this.contextTitle.textContent = context.title || "当前 PDF";
    const pieces = [
      context.pageLabel ? `第 ${context.pageLabel} 页` : "PDF 已连接",
      context.pagesCount ? `共 ${context.pagesCount} 页` : "",
      context.selectionText ? `选区 ${context.selectionText.length} 字` : "未选中文本"
    ].filter(Boolean);
    this.contextMeta.textContent = pieces.join(" · ");
    this.selectionChip.textContent = context.selectionText
      ? `当前选区 · ${context.selectionText.length} 字`
      : "当前 PDF";
    this.selectionChip.disabled = false;
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
    const distanceFromBottom = this.transcript.scrollHeight
      - this.transcript.clientHeight
      - this.transcript.scrollTop;
    const stickToBottom = !this.transcript.childElementCount || distanceFromBottom < 48;
    const desired: HTMLElement[] = [];
    const activeIDs = new Set<string>();
    if (!this.state.entries.length && this.state.phase === "ready") {
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

    for (const entry of this.state.entries) {
      activeIDs.add(entry.id);
      const fingerprint = JSON.stringify([
        entry.kind,
        entry.text,
        entry.title || "",
        entry.state || ""
      ]);
      const existing = this.entryNodes.get(entry.id);
      if (existing?.fingerprint === fingerprint) {
        desired.push(existing.node);
        continue;
      }
      const node = this.renderEntry(entry);
      const previousDetails = existing?.node.querySelector("details");
      const nextDetails = node.querySelector("details");
      if (previousDetails && nextDetails) nextDetails.open = previousDetails.open;
      this.entryNodes.set(entry.id, { fingerprint, node });
      desired.push(node);
    }
    for (const id of this.entryNodes.keys()) {
      if (!activeIDs.has(id)) this.entryNodes.delete(id);
    }
    reconcileChildren(this.transcript, desired);
    if (stickToBottom) this.transcript.scrollTop = this.transcript.scrollHeight;
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
    content.appendChild(renderMarkdown(this.doc, entry.text));
    article.append(avatar, content);
    return article;
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
      detail.textContent = "使用 ChatGPT 登录。登录状态与 Codex CLI、Cursor 共享；插件不会读取或保存令牌。";
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
    readonly.textContent = "文库访问：只读";
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
  send: ["M12 19V5", "m6 6-6-6-6 6"],
  stop: ["M8 8h8v8H8z"]
};

function createSidebarIcon(doc: Document, icon: SidebarIcon): SVGElement {
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
