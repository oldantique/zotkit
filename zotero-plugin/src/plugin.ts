import { NativeBridge } from "./native-bridge";
import readerToolbarIcon from "../assets/icon.svg";
import {
  CodexService,
  type CodexInteractionContextEntry,
  type CodexPendingApproval,
} from "./codex-service";
import {
  ReaderContextService,
  createGeckoProfileAdapter,
  createZotero9ReadAdapter,
  isStaleReaderCaptureError,
  type ReaderContext,
  type ReaderHook,
} from "./reader-context";
import {
  SidebarView,
  type CheckpointOption,
  type DiffReview,
  type PendingApproval,
  type ResearchContextChip,
  type ResearchContextSuggestion,
  type ResearchPlan,
  type SidebarPhase,
} from "./sidebar";
import { FloatPanelView, latestExchange } from "./float-panel";
import { TerminalPanel, type TerminalPaperOptions } from "./terminal-panel";
import { loadSettings, type ZoteroChatSettings } from "./settings";
import {
  ZoteroMutationApplyError,
  ZoteroMutationService,
  createZoteroMutationHost,
  type MutationResolution,
} from "./zotero-mutations";
import { buildExchangesFromEntries, syncChatNote, type NoteThreadSection } from "./note-sync";
import {
  debug,
  logError,
  PANE_ID,
  PLUGIN_ID,
  prefBool,
  prefString,
  profilePath,
  setPrefString,
} from "./platform";

interface PluginStartupData {
  id: string;
  version: string;
  rootURI: string;
}

/** Timing/model metadata recorded once a turn completes, keyed by its opening user entry. */
interface TurnMeta {
  elapsedMs: number;
  completedAt: string;
  model: string;
}

export const MAX_SELECTION_PROMPT_CHARACTERS = 32_000;

/** Keep the historical class name as a source-level compatibility shim. */
export class ZoteroChatPlugin {
  private settings!: ZoteroChatSettings;
  private readerContext!: ReaderContextService;
  private bridge!: NativeBridge;
  private terminal!: TerminalPanel;
  private codex!: CodexService;
  private mutations!: ZoteroMutationService;
  private views = new Set<HTMLElement>();
  private chatViews = new Map<HTMLElement, SidebarView>();
  private floatPanels = new Map<
    Window,
    { host: HTMLElement; view: FloatPanelView; focusReturn: HTMLElement | null }
  >();
  private shortcutWindows = new Set<Window>();
  private context: ReaderContext | null = null;
  private notifierID: string | null = null;
  private registeredPaneID: string | null = null;
  private pageRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private tabRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalOpenPromise: Promise<void> | null = null;
  private chatOpenPromise: Promise<void> | null = null;
  private chatRenderTimer: ReturnType<typeof setTimeout> | null = null;
  private paneMode: "chat" | "terminal" = "chat";
  private chatPhase: SidebarPhase = "connecting";
  private chatError = "";
  private selectedModel = "";
  private selectedEffort = "medium";
  private addedContextIDs = new Set<string>();
  private mutationCheckpoints: CheckpointOption[] = [];
  private contextRequestSequence = 0;
  private destroyed = false;
  private readonly turnStartedAt = new Map<string, number>();
  private readonly turnMeta = new Map<string, Map<string, TurnMeta>>();

  async startup(data: PluginStartupData): Promise<void> {
    this.settings = await loadSettings();
    await IOUtils.makeDirectory(profilePath(), {
      createAncestors: true,
      ignoreExisting: true,
      permissions: 0o700,
    });

    const readAdapter = createZotero9ReadAdapter(Zotero, {
      readUtf8: (path) => IOUtils.readUTF8(path),
      fileExists: (path) => IOUtils.exists(path),
    });
    const hostAdapter = createGeckoProfileAdapter({
      IOUtils,
      PathUtils: {
        profileDir: Zotero.Profile.dir,
        join: (...parts: string[]) => PathUtils.join(...parts),
        filename: (path: string) => PathUtils.filename(path),
      },
    }, { pluginDirectoryName: "zotkit" });
    this.readerContext = new ReaderContextService(readAdapter, hostAdapter, {
      libraryRoot: this.settings.libraryRoot || null,
    });
    this.bridge = new NativeBridge(data.rootURI, data.version);
    this.terminal = new TerminalPanel(this.bridge, this.settings.terminalHeight, {
      onPasteSelection: () => void this.pasteSelectionToTerminal(),
      onRefreshContext: () => void this.refreshAndSwitch().catch((error) => this.reportError(error)),
      onOpenChat: () => void this.openResearchChat(undefined, true).catch((error) => this.reportError(error)),
    });
    this.selectedModel = this.settings.defaultModel;
    this.selectedEffort = this.settings.reasoningEffort;
    this.mutations = new ZoteroMutationService(
      createZoteroMutationHost(Zotero, IOUtils, PathUtils),
      {
        getContext: () => this.context,
        onState: () => {
          this.renderChatViews();
          void this.refreshMutationCheckpoints();
        },
      },
    );
    this.codex = new CodexService(
      this.bridge,
      this.readerContext,
      data.version,
      {
        onState: () => this.handleCodexState(),
        onError: (error) => this.reportError(error),
        onFallbackRequested: (error) => {
          this.chatPhase = "unavailable";
          this.chatError = `${error.message}。你仍可从顶部打开高级 Terminal。`;
          this.renderChatViews();
        },
      },
      {
        tools: this.mutations.tools,
        invokeTool: (name, argumentsValue) => this.mutations.invokeTool(name, argumentsValue),
      },
    );

    for (const win of Zotero.getMainWindows()) await this.onMainWindowLoad(win);
    this.registerSection();
    this.registerReaderHooks();
    this.registerPageObserver();
    debug("Zotkit Research Chat startup complete", { version: data.version });
  }

  async shutdown(): Promise<void> {
    this.destroyed = true;
    this.contextRequestSequence += 1;
    if (this.pageRefreshTimer) clearTimeout(this.pageRefreshTimer);
    this.pageRefreshTimer = null;
    if (this.tabRefreshTimer) clearTimeout(this.tabRefreshTimer);
    this.tabRefreshTimer = null;
    if (this.chatRenderTimer) clearTimeout(this.chatRenderTimer);
    this.chatRenderTimer = null;
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = null;
    }
    for (const view of this.chatViews.values()) view.destroy();
    this.chatViews.clear();
    for (const entry of this.floatPanels.values()) {
      entry.view.destroy();
      entry.host.remove();
    }
    this.floatPanels.clear();
    this.views.clear();
    this.codex?.stop();
    this.terminal?.destroy();
    await this.bridge?.stop();
    try {
      if (this.registeredPaneID) {
        Zotero.ItemPaneManager.unregisterSection(this.registeredPaneID);
        this.registeredPaneID = null;
      }
    }
    catch { /* automatically removed by plugin ID */ }
    for (const win of [...this.shortcutWindows]) this.removeShortcutHandler(win);
    for (const win of Zotero.getMainWindows()) this.removeWindowAssets(win);
    debug("Zotkit Research Chat shutdown complete");
  }

  async onMainWindowLoad(win: Window): Promise<void> {
    if (this.destroyed) return;
    this.injectWindowAssets(win);
    this.installShortcutHandler(win);
  }

  async onMainWindowUnload(win: Window): Promise<void> {
    const floatEntry = this.floatPanels.get(win);
    if (floatEntry) {
      floatEntry.view.destroy();
      floatEntry.host.remove();
      this.floatPanels.delete(win);
    }
    this.removeWindowAssets(win);
  }

  private installShortcutHandler(win: Window | null | undefined): void {
    if (!win || this.shortcutWindows.has(win)) return;
    const previousHandler = (win as any).__zoteroChatKeyHandler;
    if (previousHandler) win.removeEventListener("keydown", previousHandler, true);
    const keyHandler = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey
        && !event.isComposing && !isEditableEventTarget(event.target)
      ) {
        const main = typeof Zotero === "undefined" ? win : (Zotero.getMainWindow?.() || win);
        const entry = main ? this.floatPanels.get(main) : undefined;
        if (entry?.view.isVisible()) {
          event.preventDefault();
          event.stopPropagation();
          this.hideFloatPanel(main!);
        }
        return;
      }
      if (!event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (isEditableEventTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (!event.shiftKey && key === "i") {
        event.preventDefault();
        event.stopPropagation();
        this.openSidebar();
        void this.openResearchChat(undefined, true).catch((error) => this.reportError(error));
        return;
      }
      if (!event.shiftKey && key === "l") {
        event.preventDefault();
        event.stopPropagation();
        this.openSidebar();
        void this.openChatWithSelection(true).catch((error) => this.reportError(error));
        return;
      }
      if (event.shiftKey && key === "l") {
        event.preventDefault();
        event.stopPropagation();
        this.openSidebar();
        void this.openChatWithSelection(false).catch((error) => this.reportError(error));
        return;
      }
      if (!event.shiftKey && key === "k") {
        event.preventDefault();
        event.stopPropagation();
        void this.toggleFloatPanel().catch((error) => this.reportError(error));
        return;
      }
      if (event.shiftKey && key === "j") {
        event.preventDefault();
        event.stopPropagation();
        this.openSidebar();
        void this.openTerminal().then(() => this.terminal.focus()).catch((error) => this.reportError(error));
      }
    };
    (win as any).__zoteroChatKeyHandler = keyHandler;
    win.addEventListener("keydown", keyHandler, true);
    this.shortcutWindows.add(win);
  }

  private registerSection(): void {
    const paneID = Zotero.ItemPaneManager.registerSection({
      paneID: PANE_ID,
      pluginID: PLUGIN_ID,
      header: {
        l10nID: "zotkit-pane-header",
        icon: "chrome://zotkit/content/icons/icon16.svg",
      },
      sidenav: {
        l10nID: "zotkit-pane-sidenav",
        icon: "chrome://zotkit/content/icons/icon20.svg",
      },
      sectionButtons: [
        {
          type: "zotkit-paste-selection",
          icon: "chrome://zotkit/content/icons/chat.svg",
          l10nID: "zotkit-section-new-chat",
          onClick: () => {
            this.openSidebar();
            void this.openChatWithSelection(true).catch((error) => this.reportError(error));
          },
        },
        {
          type: "zotkit-focus-terminal",
          icon: "chrome://zotkit/content/icons/terminal.svg",
          l10nID: "zotkit-section-terminal",
          onClick: () => {
            this.openSidebar();
            void this.openTerminal()
              .then(() => this.terminal.focus())
              .catch((error) => this.reportError(error));
          },
        },
      ],
      onDestroy: ({ body }: { body: HTMLElement }) => {
        this.terminal.unmount(body);
        this.chatViews.get(body)?.destroy();
        this.chatViews.delete(body);
        this.views.delete(body);
      },
      onItemChange: ({ body, item, tabType, setEnabled }: any) => {
        this.views.add(body);
        const isReader = tabType === "reader";
        const isPdf = Boolean(item?.isPDFAttachment?.())
          || item?.attachmentContentType === "application/pdf";
        setEnabled(isReader || isPdf);
        if (isReader || isPdf) this.signalReaderBodyReady(body);
      },
      onRender: ({ body }: { body: HTMLElement }) => {
        this.views.add(body);
        // DOM-only render. Codex/helper startup remains behind explicit pane expansion.
        if (this.paneMode === "chat") this.mountChat(body);
        else this.terminal.mount(body);
        this.signalReaderBodyReady(body);
      },
      onToggle: ({ body, event }: { body: HTMLElement; event: Event }) => {
        const expanded = Boolean((event.target as HTMLElement | null)?.hasAttribute("open"));
        if (!expanded) {
          this.terminal.setVisible(false);
          return;
        }
        this.views.add(body);
        if (this.paneMode === "terminal") {
          this.terminal.mount(body);
          void this.openTerminal(body).catch((error) => this.reportError(error));
        }
        else {
          this.mountChat(body);
          void this.openResearchChat(body, false).catch((error) => this.reportError(error));
        }
      },
      onAsyncRender: async ({ body }: { body: HTMLElement }) => {
        // Zotero may render collapsed sections while scrolling the Item Pane.
        // Keep this branch process-free unless the user has expanded it.
        if (!body.closest("collapsible-section")?.hasAttribute("open")) return;
        this.views.add(body);
        if (this.paneMode === "terminal") {
          this.terminal.mount(body);
          await this.openTerminal(body).catch((error) => this.reportError(error));
        }
        else {
          this.mountChat(body);
          await this.openResearchChat(body, false).catch((error) => this.reportError(error));
        }
      },
    });
    if (!paneID) throw new Error("无法注册 Zotkit 侧栏");
    this.registeredPaneID = paneID;
  }

  private registerReaderHooks(): void {
    Zotero.Reader.registerEventListener("renderToolbar", (event: any) => {
      const { doc, append } = event;
      this.installShortcutHandler(doc.defaultView);
      const button = doc.createElement("button");
      button.type = "button";
      button.title = "打开 Zotkit Research Chat（⌘I）";
      button.setAttribute("aria-label", button.title);
      button.style.cssText = "display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:8px;background:transparent;cursor:pointer;padding:5px";
      const icon = doc.createElement("img");
      // Reader documents use a resource:// origin and cannot load privileged
      // chrome:// images. Bundle this icon as a data URL so the toolbar button
      // remains visible without widening Reader content privileges.
      icon.src = readerToolbarIcon;
      icon.alt = "";
      icon.style.cssText = "width:22px;height:22px;border-radius:6px";
      button.appendChild(icon);
      button.addEventListener("click", () => {
        void this.acceptReaderHook(event).then(async () => {
          this.openSidebar();
          await this.openResearchChat(undefined, true);
        }).catch((error) => this.reportError(error));
      });
      append(button);
    }, PLUGIN_ID);

    Zotero.Reader.registerEventListener("renderTextSelectionPopup", (event: any) => {
      const { doc, append } = event;
      this.installShortcutHandler(doc.defaultView);
      // Capture selection immediately so Cursor-compatible ⌘L / ⌘⇧L shortcuts
      // work even when the popup button itself is not clicked.
      void this.acceptReaderHook(event).catch((error) => this.reportError(error));
      const group = doc.createElement("div");
      group.style.cssText = "display:flex;gap:5px;padding:5px 4px 2px";
      const ask = this.readerPopupButton(doc, "Ask in Zotkit", () => {
        void this.acceptReaderHook(event).then(async () => {
          this.openSidebar();
          await this.openChatWithSelection(false);
        }).catch((error) => this.reportError(error));
      });
      group.append(ask);
      append(group);
    }, PLUGIN_ID);
  }

  private registerPageObserver(): void {
    this.notifierID = Zotero.Notifier.registerObserver({
      notify: (
        event: string,
        type: string,
        ids: Array<string | number>,
        extraData?: Record<string, { type?: string }>,
      ) => {
        if (type === "file" && event === "pageChange") {
          if (!this.hasOpenSidebar()) return;
          if (this.paneMode === "terminal" && !this.terminal.isOpen) return;
          if (this.pageRefreshTimer) clearTimeout(this.pageRefreshTimer);
          this.pageRefreshTimer = setTimeout(() => {
            this.pageRefreshTimer = null;
            void this.refreshContext(true).catch(() => {});
          }, 800);
          return;
        }
        if (type !== "tab" || !["select", "load"].includes(event)) return;
        if (
          !this.terminal.hasLiveSessions
          && !this.terminalOpenPromise
          && !this.codex?.state.connected
          && !this.chatOpenPromise
        ) return;
        const tabID = String(ids?.[0] ?? "");
        if (!tabID || this.selectedTabID() !== tabID) return;
        const tabType = extraData?.[tabID]?.type || this.selectedTabType();
        this.scheduleTabRefresh(tabID, this.isReaderTabType(tabType), 0, 0);
      },
    }, ["file", "tab"], PLUGIN_ID, 40);
  }

  private hasOpenSidebar(): boolean {
    const body = this.activeSidebarBody();
    return Boolean(body?.closest("collapsible-section")?.hasAttribute("open"));
  }

  private signalReaderBodyReady(body: HTMLElement): void {
    if (
      !this.terminal.hasLiveSessions
      && !this.terminalOpenPromise
      && !this.codex?.state.connected
      && !this.chatOpenPromise
    ) return;
    if (!body.closest("collapsible-section")?.hasAttribute("open")) return;
    const tabID = this.sidebarTabID(body);
    if (!tabID || this.selectedTabID() !== tabID) return;
    this.scheduleTabRefresh(tabID, true, 0, 0);
  }

  private scheduleTabRefresh(
    tabID: string,
    isReader: boolean,
    attempt: number,
    delay: number,
  ): void {
    if (this.tabRefreshTimer) clearTimeout(this.tabRefreshTimer);
    this.tabRefreshTimer = setTimeout(() => {
      this.tabRefreshTimer = null;
      void this.refreshSelectedReaderTab(tabID, isReader, attempt)
        .catch((error) => this.reportError(error));
    }, delay);
  }

  private async refreshSelectedReaderTab(
    tabID: string,
    isReader = true,
    attempt = 0,
  ): Promise<void> {
    const pending = this.paneMode === "terminal"
      ? this.terminalOpenPromise
      : this.chatOpenPromise;
    if (pending) {
      try { await pending; }
      catch { return; }
    }
    if (this.destroyed || this.selectedTabID() !== tabID) return;
    if (!isReader) {
      this.terminal.setVisible(false);
      return;
    }
    const host = this.activeSidebarBody(tabID);
    if (!host) {
      if (attempt < 8) {
        this.scheduleTabRefresh(tabID, true, attempt + 1, 25 * (attempt + 1));
      }
      else {
        if (this.paneMode === "terminal") this.terminal.setVisible(false);
      }
      return;
    }
    if (!host?.closest("collapsible-section")?.hasAttribute("open")) {
      if (this.paneMode === "terminal") this.terminal.setVisible(false);
      return;
    }
    if (this.paneMode === "terminal") this.terminal.mount(host);
    else this.mountChat(host);
    await this.refreshContext(false, host);
  }

  private async acceptReaderHook(event: any): Promise<void> {
    const requestSequence = ++this.contextRequestSequence;
    try {
      const context = await this.readerContext.acceptReaderHook({
        reader: event.reader,
        item: event.item,
        params: event.params,
        selectionAnnotation: event.params?.annotation,
      } as ReaderHook);
      if (requestSequence !== this.contextRequestSequence || this.destroyed) return;
      await this.applyContext(context, requestSequence);
    }
    catch (error) {
      if (!isStaleReaderCaptureError(error)) throw error;
    }
  }

  private async refreshContext(pageChange = false, preferredHost?: HTMLElement): Promise<void> {
    if (pageChange) {
      const requestSequence = ++this.contextRequestSequence;
      const selectedTabID = this.selectedTabID();
      try {
        const context = await this.readerContext.refreshForPageChange();
        if (
          !context
          || this.destroyed
          || requestSequence !== this.contextRequestSequence
          || selectedTabID !== this.selectedTabID()
        ) return;
        await this.applyContext(context, requestSequence, preferredHost);
      }
      catch (error) {
        if (!isStaleReaderCaptureError(error)) throw error;
      }
      return;
    }
    const requestSequence = ++this.contextRequestSequence;
    try {
      const context = await this.readerContext.refresh();
      if (requestSequence !== this.contextRequestSequence || this.destroyed) return;
      await this.applyContext(context, requestSequence, preferredHost);
    }
    catch (error) {
      if (!isStaleReaderCaptureError(error)) throw error;
    }
  }

  private async refreshAndSwitch(): Promise<void> {
    await this.refreshContext();
    if (this.paneMode === "terminal") {
      await this.readerContext.ensureZotkitLibrarySnapshot(true);
      if (this.terminal.hasLiveSessions) await this.switchTerminalToContext();
    }
  }

  private async applyContext(
    context: ReaderContext,
    requestSequence: number,
    preferredHost?: HTMLElement,
  ): Promise<void> {
    if (requestSequence !== this.contextRequestSequence || this.destroyed) return;
    const previousLibraryID = this.context?.attachment.libraryID;
    this.context = context;
    this.mutations?.clearPaperReviews(context);
    this.updateInteractionContext();
    this.renderChatViews();
    if (this.codex?.state.connected && this.codex.isSignedIn()) {
      await this.codex.setPaper(context);
    }
    if (this.paneMode === "terminal" && this.terminal.hasLiveSessions) {
      await this.switchTerminalToContext(
        String(previousLibraryID ?? "") !== String(context.attachment.libraryID ?? ""),
        preferredHost,
        requestSequence,
      );
    }
  }

  private mountChat(body: HTMLElement): SidebarView {
    this.terminal.unmount(body);
    body.classList.add("zc-pane-host");
    let view = this.chatViews.get(body);
    if (view) return view;
    view = new SidebarView(body, {
      onSend: (text) => void this.sendChat(text).catch((error) => this.reportError(error)),
      onStop: () => void this.codex.interrupt().catch((error) => this.reportError(error)),
      onNewThread: () => void this.newChat().catch((error) => this.reportError(error)),
      onSelectThread: (threadID) => void this.codex.switchThread(threadID).catch((error) => this.reportError(error)),
      onLogin: () => void this.codex.login().catch((error) => this.reportError(error)),
      onLogout: () => void this.codex.logout().catch((error) => this.reportError(error)),
      onOpenTerminal: () => void this.openTerminal().then(() => this.terminal.focus()).catch((error) => this.reportError(error)),
      onRefreshContext: () => void this.retryResearchChat(body).catch((error) => this.reportError(error)),
      onInsertSelection: () => void this.attachSelection(false),
      onModelChange: (model) => {
        this.selectedModel = model;
        setPrefString("defaultModel", model);
        this.renderChatViews();
      },
      onEffortChange: (effort) => {
        this.selectedEffort = effort;
        setPrefString("reasoningEffort", effort);
        this.renderChatViews();
      },
      onModeChange: (mode) => void this.codex.setMode(mode).catch((error) => this.reportError(error)),
      onAddContext: (suggestion) => this.addInteractionContext(suggestion),
      onRemoveContext: (contextID) => this.removeInteractionContext(contextID),
      onReviewDecision: (reviewID, decision) => {
        void this.resolveMutationReview(reviewID, decision);
      },
      onApprovalDecision: (approvalID, decision) => {
        if (!this.codex.resolveApproval(approvalID, decision)) {
          this.reportError(new Error("这个审批请求已经过期"));
        }
      },
      onRestoreCheckpoint: (checkpointID) => {
        void this.restoreCheckpoint(checkpointID).catch((error) => this.reportError(error));
      },
    });
    this.chatViews.set(body, view);
    this.renderChatViews();
    return view;
  }

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

  private async retryResearchChat(body?: HTMLElement): Promise<void> {
    await this.refreshContext();
    await this.openResearchChat(body, true);
  }

  private async sendChat(text: string): Promise<void> {
    if (!this.codex.state.connected) await this.ensureChatSession();
    if (!this.codex.isSignedIn()) throw new Error("请先使用 ChatGPT 登录 Codex");
    this.chatPhase = "ready";
    await this.codex.send(text, this.selectedModel, this.selectedEffort);
  }

  private async newChat(): Promise<void> {
    await this.openResearchChat(undefined, false);
    if (!this.codex.isSignedIn()) throw new Error("请先使用 ChatGPT 登录 Codex");
    await this.codex.newThread();
    this.activeChatView()?.focusComposer();
  }

  private async openChatWithSelection(newThread: boolean): Promise<void> {
    await this.openResearchChat(undefined, false);
    if (newThread && this.codex.isSignedIn() && this.context) await this.codex.newThread();
    this.attachSelection(true);
  }

  private mountFloatPanel(
    win: Window,
  ): { host: HTMLElement; view: FloatPanelView; focusReturn: HTMLElement | null } {
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
      onModelChange: (model) => {
        this.selectedModel = model;
        setPrefString("defaultModel", model);
        this.renderChatViews();
      },
    });
    entry = { host, view, focusReturn: null };
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
    entry.focusReturn = active && active !== win.document.body
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
    if (this.codex.state.connected) {
      // Session already live: refresh context in the background without
      // flipping chatPhase, so the composer stays enabled and focused.
      void this.refreshContext()
        .then(() => this.renderChatViews())
        .catch(() => { /* stale reader capture is non-fatal here */ });
    }
    else {
      void this.ensureChatSession()
        .then(() => entry.view.focusComposer())
        .catch((error) => this.reportError(error));
    }
  }

  private hideFloatPanel(win: Window): void {
    const entry = this.floatPanels.get(win);
    if (!entry?.view.isVisible()) return;
    entry.view.hide();
    const target = entry.focusReturn;
    entry.focusReturn = null;
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
        models: this.codex.state.models,
        selectedModel: this.selectedModel,
        selection: this.addedContextIDs.has("current-selection") && context?.selection?.text
          ? {
            text: context.selection.text,
            pageNumber: context.selection.pageNumber ?? context.page.pageNumber,
          }
          : null,
        turnStartedAt: this.codex.state.running
          ? this.turnStartedAt.get(this.codex.state.activeThreadId ?? "") ?? null
          : null,
        turnDurations: this.turnDurationsForActiveThread(),
      });
    }
  }

  private attachSelection(focus: boolean): void {
    if (!this.context?.selection?.text) {
      this.chatError = "请先在 PDF 中选择文字";
      this.renderChatViews();
      if (focus) this.activeChatView()?.focusComposer();
      return;
    }
    this.addedContextIDs.add("current-selection");
    this.chatError = "";
    this.updateInteractionContext();
    this.renderChatViews();
    if (focus) this.activeChatView()?.focusComposer();
  }

  private addInteractionContext(suggestion: ResearchContextSuggestion): void {
    this.addedContextIDs.add(suggestion.id);
    this.updateInteractionContext();
    this.renderChatViews();
  }

  private removeInteractionContext(contextID: string): void {
    this.addedContextIDs.delete(contextID);
    this.updateInteractionContext();
    this.renderChatViews();
  }

  private updateInteractionContext(): void {
    const context = this.context;
    const interaction: Record<string, CodexInteractionContextEntry> = {};
    if (this.addedContextIDs.has("active-annotations")) {
      interaction["Requested Zotero annotations"] = {
        kind: "application",
        value: "The user attached this paper's annotations. Call zotero_list_annotations before answering when relevant.",
      };
    }
    if (this.addedContextIDs.has("zotero-library")) {
      interaction["Requested Zotero library"] = {
        kind: "application",
        value: "The user attached their Zotero library. Use the Zotero library search tools when useful.",
      };
    }
    if (this.addedContextIDs.has("current-selection") && context?.selection?.text) {
      interaction["Pinned Reader selection"] = {
        kind: "untrusted",
        value: context.selection.text.slice(0, 12_000),
      };
    }
    this.codex?.setInteractionContext(interaction);
  }

  turnDurationsForActiveThread(): Record<string, number> {
    const threadId = this.codex?.state.activeThreadId;
    const meta = threadId ? this.turnMeta.get(threadId) : undefined;
    const out: Record<string, number> = {};
    if (meta) for (const [id, value] of meta) out[id] = value.elapsedMs;
    return out;
  }

  /** Starts the clock when a turn begins running and records its duration once it stops. */
  private trackTurnTiming(): void {
    const threadId = this.codex?.state.activeThreadId;
    if (!threadId) return;
    const running = Boolean(this.codex?.state.running);
    const started = this.turnStartedAt.get(threadId);
    if (running && started === undefined) {
      this.turnStartedAt.set(threadId, Date.now());
      return;
    }
    if (!running) {
      if (started !== undefined) {
        const entries = this.codex?.getChatEntries() ?? [];
        let lastUserId: string | null = null;
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i]!.kind === "user") { lastUserId = entries[i]!.id; break; }
        }
        if (lastUserId) {
          const perThread = this.turnMeta.get(threadId) ?? new Map<string, TurnMeta>();
          perThread.set(lastUserId, {
            elapsedMs: Date.now() - started,
            completedAt: new Date().toISOString(),
            model: this.selectedModel,
          });
          this.turnMeta.set(threadId, perThread);
          this.onTurnCompleted(threadId);
        }
      }
      // `running` is service-wide: once nothing is running, every remaining start
      // timestamp (for threads other than the active one, or left over from an
      // interrupted switch) is stale by definition. Drop them all so reopening an
      // idle thread later can't fabricate a completed turn from a stale timer.
      this.turnStartedAt.clear();
    }
  }

  /** Auto-syncs the completed turn's Q&A into the paper's `zotkit-chat`-tagged note. */
  protected onTurnCompleted(threadId: string): void {
    if (!prefBool("noteSync", true)) return;
    const context = this.context;
    if (!context || threadId !== this.codex?.state.activeThreadId) return;
    const thread = this.codex.getThreadOptions().find((option) => option.active);
    const section: NoteThreadSection = {
      threadId,
      title: thread?.title || "对话",
      dateLabel: new Date().toISOString().slice(0, 10),
      exchanges: buildExchangesFromEntries(this.codex.getChatEntries(), this.turnMeta.get(threadId)),
    };
    if (!section.exchanges.length) return;
    void syncChatNote({
      zotero: Zotero,
      readerItem: this.readerContextItem(),
      paperTitle: paperTitle(context),
      section,
    }).catch(() => {});
  }

  /** Resolves the current reader attachment to a live Zotero item for note-sync writes. */
  private readerContextItem(): any {
    const attachment = this.context?.attachment;
    if (!attachment?.id) return null;
    return Zotero.Items?.get?.(attachment.id)
      ?? Zotero.Items?.getByLibraryAndKey?.(attachment.libraryID, attachment.key)
      ?? null;
  }

  private renderChatViews(): void {
    this.trackTurnTiming();
    if (!this.codex) return;
    const context = this.context;
    const plan = normalizePlan(this.codex.getActivePlan());
    const mutationReviews = this.mutations?.getReviews() || [];
    const workspaceDiffs: DiffReview[] = this.codex.getActiveDiffs().map((diff) => ({
      id: `workspace:${diff.turnId}`,
      title: "Agent workspace diff",
      summary: "Applied only inside Zotkit's private staging workspace. Zotero and the original PDF are unchanged until a separate reviewed Apply.",
      diff: diff.diff,
      state: "accepted",
    }));
    const pending = this.codex.getPendingApprovals()[0];
    const pendingApproval: PendingApproval | null = pending ? {
      id: pending.id,
      title: pending.title,
      description: formatPendingApprovalDescription(pending),
      command: pending.command,
      kind: pending.kind === "commandExecution" ? "command"
        : pending.kind === "permissions" ? "permission" : "tool",
      risk: pending.kind === "permissions" ? "high" : "medium",
    } : null;
    const conversationCheckpoints: CheckpointOption[] = this.codex.getCheckpoints().map((checkpoint) => ({
      id: `conversation:${checkpoint.id}`,
      label: `对话 · ${checkpoint.label}`,
      createdAt: checkpoint.createdAt,
    }));
    const checkpoints = [
      ...this.mutationCheckpoints.map((checkpoint) => ({ ...checkpoint, id: `zotero:${checkpoint.id}` })),
      ...conversationCheckpoints,
    ].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    for (const [body, view] of this.chatViews) {
      if (!body.isConnected) {
        view.destroy();
        this.chatViews.delete(body);
        continue;
      }
      view.setState({
        phase: this.chatPhase,
        accountLabel: this.codex.isSignedIn() ? this.codex.accountLabel() : undefined,
        error: this.chatError || this.codex.state.fallbackReason || undefined,
        context: context ? {
          key: `${context.attachment.libraryID ?? "0"}-${context.attachment.key}`,
          title: paperTitle(context),
          authors: contextCreators(context),
          pageLabel: context.page.pageLabel || String(context.page.pageNumber),
          pageIndex: context.page.pageIndex,
          pagesCount: context.page.pageCount,
          selectionText: context.selection?.text,
          pdfPath: context.pdfPath || undefined,
        } : null,
        entries: this.codex.getChatEntries(),
        models: this.codex.state.models,
        threads: this.codex.getThreadOptions().map((thread) => ({
          ...thread,
          status: thread.active && this.codex.state.running ? "running"
            : pendingApproval && thread.active ? "attention" : "idle",
        })),
        selectedModel: this.selectedModel,
        effort: this.selectedEffort,
        running: this.codex.state.running,
        threadTitle: context ? paperTitle(context) : "论文助手",
        mode: this.codex.state.mode,
        contextChips: this.contextChips(),
        contextSuggestions: this.contextSuggestions(),
        plan,
        reviews: [...mutationReviews, ...workspaceDiffs],
        pendingApproval,
        checkpoints,
        turnStartedAt: this.codex.state.running
          ? this.turnStartedAt.get(this.codex.state.activeThreadId ?? "") ?? null
          : null,
        turnDurations: this.turnDurationsForActiveThread(),
      });
    }
    this.renderFloatPanels();
  }

  private handleCodexState(): void {
    if (this.codex.state.connected) {
      this.chatPhase = this.codex.isSignedIn() ? "ready" : "signed-out";
      if (this.codex.isSignedIn()) this.chatError = "";
    }
    else if (this.chatPhase === "ready") {
      this.chatPhase = "error";
      this.chatError ||= "Codex 连接已断开，请重试；高级 Terminal 仍可使用。";
    }
    this.scheduleChatRender();
  }

  private scheduleChatRender(): void {
    if (this.chatRenderTimer || this.destroyed) return;
    this.chatRenderTimer = setTimeout(() => {
      this.chatRenderTimer = null;
      this.renderChatViews();
    }, 50);
  }

  private contextChips(): ResearchContextChip[] {
    const context = this.context;
    if (!context) return [];
    const chips: ResearchContextChip[] = [{
      id: "active-paper",
      kind: "paper",
      label: "当前论文",
      detail: paperTitle(context),
      removable: false,
    }, {
      id: "current-page",
      kind: "page",
      label: `第 ${context.page.pageLabel || context.page.pageNumber} 页`,
      detail: "自动随 Reader 更新",
      removable: false,
    }];
    if (context.selection?.text) chips.push({
      id: "current-selection",
      kind: "selection",
      label: `选区 · ${context.selection.text.length} 字`,
      detail: "自动随 Reader 选区更新",
      removable: false,
    });
    if (this.addedContextIDs.has("active-annotations")) chips.push({
      id: "active-annotations",
      kind: "annotation",
      label: "论文批注",
      removable: true,
    });
    if (this.addedContextIDs.has("zotero-library")) chips.push({
      id: "zotero-library",
      kind: "library",
      label: "Zotero 文库",
      removable: true,
    });
    return chips;
  }

  private contextSuggestions(): ResearchContextSuggestion[] {
    const context = this.context;
    return [{
      id: "active-paper",
      kind: "paper",
      label: "当前论文",
      detail: context ? paperTitle(context) : "请先打开 PDF",
      disabled: !context,
    }, {
      id: "current-page",
      kind: "page",
      label: "当前页",
      detail: context ? `PDF 第 ${context.page.pageNumber} 页` : "请先打开 PDF",
      disabled: !context,
    }, {
      id: "current-selection",
      kind: "selection",
      label: "当前选区",
      detail: context?.selection?.text ? `${context.selection.text.length} 字` : "请先选择 PDF 文本",
      disabled: !context?.selection?.text,
    }, {
      id: "active-annotations",
      kind: "annotation",
      label: "这篇论文的批注",
      detail: "高亮、评论与页码",
      disabled: !context || this.addedContextIDs.has("active-annotations"),
    }, {
      id: "zotero-library",
      kind: "library",
      label: "Zotero 文库",
      detail: "搜索其他论文、分类与标签",
      disabled: this.addedContextIDs.has("zotero-library"),
    }];
  }

  private async refreshMutationCheckpoints(): Promise<void> {
    if (!this.mutations) return;
    this.mutationCheckpoints = await this.mutations.getCheckpoints();
    this.renderChatViews();
  }

  private async restoreCheckpoint(checkpointID: string): Promise<void> {
    if (checkpointID.startsWith("zotero:")) {
      const result = await this.mutations.restoreCheckpoint(checkpointID.slice("zotero:".length));
      await this.refreshAfterMutation(result);
      return;
    }
    if (!checkpointID.startsWith("conversation:")) throw new Error("Unknown checkpoint");
    const result = await this.codex.restoreCheckpoint(checkpointID.slice("conversation:".length));
    if (!result.filesystemRestored && result.turnDiff) {
      this.chatError = "已恢复对话分支；Codex 协议不会自动回滚文件。需要恢复 Zotero/PDF 时，请使用对应的 Zotero Checkpoint。";
    }
    this.renderChatViews();
  }

  private async resolveMutationReview(
    reviewID: string,
    decision: "accept" | "reject",
  ): Promise<void> {
    try {
      const result = await this.mutations.resolveReview(reviewID, decision);
      if (result.decision === "accepted") await this.refreshAfterMutation(result);
    }
    catch (error) {
      if (error instanceof ZoteroMutationApplyError) {
        await this.refreshAfterMutation({
          decision: "accepted",
          effects: error.effects,
          checkpointID: error.checkpointID,
        }).catch((refreshError) => logError(refreshError));
      }
      this.reportError(error);
    }
  }

  private async refreshAfterMutation(result?: MutationResolution): Promise<void> {
    let reloadError: unknown = null;
    if (result?.effects.attachmentContentChanged) {
      await this.readerContext.invalidateAttachmentCaches({
        key: result.effects.attachmentKey,
        libraryID: result.effects.attachmentLibraryID,
      });
      try {
        await this.reloadReadersForAttachment(result.effects.attachmentID);
      }
      catch (error) {
        reloadError = error;
      }
    }
    await this.refreshContext();
    await this.readerContext.ensureZotkitLibrarySnapshot(true).catch(() => null);
    await this.refreshMutationCheckpoints();
    if (reloadError) throw reloadError;
  }

  private async reloadReadersForAttachment(attachmentID: number | string): Promise<void> {
    const readers = new Set<any>();
    const loaded = Zotero.Reader?._readers;
    if (Array.isArray(loaded)) {
      for (const reader of loaded) {
        if (String(reader?.itemID) === String(attachmentID)) readers.add(reader);
      }
    }
    const tabID = this.selectedTabID();
    const active = tabID ? Zotero.Reader?.getByTabID?.(tabID) : null;
    if (active && String(active.itemID) === String(attachmentID)) readers.add(active);
    const failures: string[] = [];
    for (const reader of readers) {
      try {
        await reader.reload?.();
      }
      catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length) {
      throw new Error(`PDF 已更新，但 ${failures.length} 个 Zotero Reader 视图重载失败：${failures[0]}`);
    }
  }

  private activeChatView(): SidebarView | null {
    const body = this.activeSidebarBody();
    return body ? this.chatViews.get(body) || null : null;
  }

  private openTerminal(body?: HTMLElement): Promise<void> {
    if (this.terminalOpenPromise) return this.terminalOpenPromise;
    const pending = this.openTerminalInternal(body);
    this.terminalOpenPromise = pending;
    const clearPending = () => {
      if (this.terminalOpenPromise === pending) this.terminalOpenPromise = null;
    };
    // Supplying both branches avoids the rejected promise returned by finally()
    // becoming an unhandled rejection after the original caller handles it.
    void pending.then(clearPending, clearPending);
    return pending;
  }

  private async openTerminalInternal(body?: HTMLElement): Promise<void> {
    const host = body || this.activeSidebarBody();
    if (!host) throw new Error("请先展开 Zotkit 侧栏");
    this.paneMode = "terminal";
    this.chatViews.get(host)?.destroy();
    this.chatViews.delete(host);
    this.terminal.mount(host);
    await this.refreshContext();
    await this.readerContext.ensureZotkitLibrarySnapshot();
    const options = await this.terminalOptions(host);
    await this.terminal.open(options);
  }

  private async switchTerminalToContext(
    ensureLibrarySnapshot = false,
    preferredHost?: HTMLElement,
    requestSequence = this.contextRequestSequence,
  ): Promise<void> {
    const host = preferredHost?.isConnected ? preferredHost : this.activeSidebarBody();
    if (!host || !this.context?.workspace) return;
    const tabID = this.sidebarTabID(host);
    if (ensureLibrarySnapshot) await this.readerContext.ensureZotkitLibrarySnapshot();
    if (
      requestSequence !== this.contextRequestSequence
      || this.destroyed
      || !host.isConnected
      || (tabID && this.selectedTabID() !== tabID)
    ) return;
    const options = await this.terminalOptions(host);
    if (
      requestSequence !== this.contextRequestSequence
      || this.destroyed
      || !host.isConnected
      || (tabID && this.selectedTabID() !== tabID)
    ) return;
    await this.terminal.switchPaper(options);
  }

  private async terminalOptions(host: HTMLElement): Promise<TerminalPaperOptions> {
    // Prepare a read-only whole-document source for the terminal MCP. This
    // references Zotero's existing index in place and only creates one bounded,
    // private fallback when that index is unavailable.
    await this.readerContext.ensureCurrentPdfTextReference();
    const context = this.context;
    if (!context?.workspace) throw new Error("请先打开一篇 PDF Reader");
    const preferredAgent = prefString("defaultAgent", this.settings.defaultAgent);
    return {
      host,
      paperKey: `${context.attachment.libraryID ?? "0"}-${context.attachment.key}`,
      paperTitle: paperTitle(context),
      workspace: context.workspace.root,
      workingDirectory: await resolveReaderWorkingDirectory(context),
      pdfPath: context.pdfPath,
      librarySnapshotPath:
        this.readerContext.getCachedZotkitLibrarySnapshotReference()?.path ?? null,
      pageLabel: context.page.pageLabel || String(context.page.pageNumber),
      agent: preferredAgent === "claude" ? preferredAgent : "codex",
    };
  }

  private async pasteSelectionToTerminal(): Promise<void> {
    try {
      this.openSidebar();
      await this.openTerminal();
      this.insertSelectionPrompt();
    }
    catch (error) {
      this.reportError(error);
    }
  }

  private insertSelectionPrompt(): void {
    const context = this.context;
    if (!context?.selection?.text) {
      this.terminal.showError("请先在 PDF 中选择文字");
      return;
    }
    this.terminal.insert(buildSelectionPrompt(context), false);
  }

  private openSidebar(): void {
    const win = Zotero.getMainWindow();
    try {
      if (win.ZoteroContextPane?.collapsed) win.ZoteroContextPane.togglePane();
    }
    catch { /* context pane API changed */ }
    const paneID = this.registeredPaneID || PANE_ID;
    const candidates = win.document.querySelectorAll(
      "item-pane-custom-section, item-pane-section, collapsible-section",
    );
    const section = Array.from(candidates).find(
      (candidate: any) => candidate.dataset?.pane === paneID,
    ) as any;
    if (section) {
      section.open = true;
      section.scrollIntoView({ block: "nearest" });
    }
  }

  private selectedTabID(): string | null {
    try {
      return String(Zotero.getMainWindow()?.Zotero_Tabs?.selectedID ?? "") || null;
    }
    catch { return null; }
  }

  private selectedTabType(): string {
    try {
      return String(Zotero.getMainWindow()?.Zotero_Tabs?.selectedType ?? "");
    }
    catch { return ""; }
  }

  private isReaderTabType(tabType: string): boolean {
    if (tabType === "reader") return true;
    try {
      return Zotero.getMainWindow()?.Zotero_Tabs?.parseTabType?.(tabType)?.tabContentType
        === "reader";
    }
    catch { return false; }
  }

  private sidebarTabID(body: HTMLElement): string | null {
    return body.closest("item-details")?.getAttribute("data-tab-id") || null;
  }

  private activeSidebarBody(tabID = this.selectedTabID()): HTMLElement | null {
    const connected = [...this.views].filter((body) => body.isConnected);
    const matching = tabID
      ? connected.filter(
        (body) => this.sidebarTabID(body) === tabID,
      )
      : connected;
    const open = matching.find(
      (body) => body.closest("collapsible-section")?.hasAttribute("open"),
    );
    return open || matching[0] || null;
  }

  private reportError(error: unknown): void {
    const value = error instanceof Error ? error : new Error(String(error));
    logError(value);
    if (this.paneMode === "terminal") this.terminal?.showError(value);
    else {
      this.chatError = value.message;
      if (this.chatPhase === "connecting") this.chatPhase = "error";
      this.renderChatViews();
    }
  }

  private injectWindowAssets(win: Window): void {
    const doc = win.document;
    if (!doc.getElementById("zotkit-styles")) {
      const link = doc.createElement("link");
      link.id = "zotkit-styles";
      link.rel = "stylesheet";
      link.href = "chrome://zotkit/content/zoterochat.css";
      doc.documentElement.appendChild(link);
    }
    try { win.MozXULElement?.insertFTLIfNeeded("zoterochat.ftl"); }
    catch { /* header falls back to l10n id */ }
  }

  private removeWindowAssets(win: Window): void {
    this.removeShortcutHandler(win);
    win.document.getElementById("zotkit-styles")?.remove();
  }

  private removeShortcutHandler(win: Window): void {
    const handler = (win as any).__zoteroChatKeyHandler;
    if (handler) win.removeEventListener("keydown", handler, true);
    delete (win as any).__zoteroChatKeyHandler;
    this.shortcutWindows.delete(win);
  }

  private readerPopupButton(doc: Document, label: string, callback: () => void): HTMLButtonElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.cssText = "min-height:28px;padding:4px 10px;border:1px solid rgba(0,122,255,.3);border-radius:8px;background:rgba(0,122,255,.12);color:inherit;font:600 11px -apple-system;cursor:pointer";
    button.addEventListener("click", callback);
    return button;
  }
}

export function formatPendingApprovalDescription(
  pending: Pick<CodexPendingApproval, "description" | "cwd" | "requestedPermissions">,
): string | undefined {
  const details = [pending.description || pending.cwd || ""];
  if (pending.requestedPermissions) {
    let rendered = "";
    try {
      rendered = JSON.stringify(pending.requestedPermissions);
    }
    catch {
      rendered = "(unable to display malformed permission request)";
    }
    const maximum = 6_000;
    details.push(`请求的权限：${rendered.length > maximum ? `${rendered.slice(0, maximum)}…` : rendered}`);
  }
  const value = details.filter(Boolean).join("\n");
  return value || undefined;
}

function normalizePlan(value: ReturnType<CodexService["getActivePlan"]>): ResearchPlan | null {
  if (!value) return null;
  return {
    id: value.turnId,
    title: "Research plan",
    explanation: value.explanation || undefined,
    steps: value.steps.map((step, index) => {
      const rawStatus = String(step.status || "pending").toLowerCase();
      const status = rawStatus === "completed" || rawStatus === "complete"
        ? "complete" as const
        : rawStatus === "in_progress" || rawStatus === "inprogress" || rawStatus === "running"
          ? "running" as const
          : rawStatus === "failed" ? "failed" as const : "pending" as const;
      return {
        id: String(step.id || `${value.turnId}:${index}`),
        title: String(step.step || step.title || `Step ${index + 1}`),
        status,
      };
    }),
  };
}

function contextCreators(context: ReaderContext): string {
  return (context.parent?.creators?.length ? context.parent.creators : context.attachment.creators)
    .map((creator) => creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(", ");
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  const element = target && (target as Node).nodeType === 1 ? target as Element : null;
  if (!element) return false;
  const localName = element.localName?.toLowerCase();
  if (["input", "textarea", "select"].includes(localName)) return true;
  return Boolean(element.closest?.('[contenteditable="true"], [contenteditable="plaintext-only"]'));
}

export function pdfDirectory(pdfPath: string | null | undefined): string | null {
  const path = pdfPath?.trim();
  if (!path?.startsWith("/")) return null;
  const slash = path.lastIndexOf("/");
  if (slash < 0) return null;
  return slash === 0 ? "/" : path.slice(0, slash);
}

export async function resolveReaderWorkingDirectory(context: ReaderContext): Promise<string> {
  const directory = pdfDirectory(context.pdfPath);
  if (directory) {
    try {
      const stat = await IOUtils.stat(directory);
      if (stat?.type === "directory") return directory;
    }
    catch { /* linked PDF may be temporarily unavailable */ }
  }
  if (!context.workspace?.root) throw new Error("Reader context workspace is unavailable");
  return context.workspace.root;
}

export function buildSelectionPrompt(context: ReaderContext): string {
  const parent = context.parent;
  const creators = parent?.creators?.length ? parent.creators : context.attachment.creators;
  const authors = creators
    .map((creator) => creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(", ");
  const page = context.selection?.pageNumber
    || context.page.pageNumber;
  const directory = pdfDirectory(context.pdfPath);
  const metadata = [
    `论文：${safeTerminalText(paperTitle(context))}`,
    authors ? `作者：${safeTerminalText(authors)}` : "",
    parent?.year ? `年份：${safeTerminalText(parent.year)}` : "",
    parent?.doi ? `DOI：${safeTerminalText(parent.doi)}` : "",
    context.pdfPath ? `PDF：${safeTerminalText(context.pdfPath)}` : "",
    directory ? `目录：${safeTerminalText(directory)}` : "",
    `PDF 页：${page}`,
  ].filter(Boolean).join("；");
  const rawSelection = safeTerminalText(context.selection?.text || "");
  const selection = rawSelection.length <= MAX_SELECTION_PROMPT_CHARACTERS
    ? rawSelection
    : `${rawSelection.slice(0, MAX_SELECTION_PROMPT_CHARACTERS)}… [选区过长；完整文本仍可通过 zotero_reader 获取]`;
  // There is deliberately no CR/LF in this value: it is visible in the TUI
  // and cannot submit itself. The user types the question and presses Enter.
  return `[Zotero Reader 上下文｜${metadata}] 选中文本：“${selection}” 问题：`;
}

function paperTitle(context: ReaderContext): string {
  return context.parent?.title
    || context.attachment.title
    || context.attachment.filename
    || "当前 PDF";
}

function safeTerminalText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
