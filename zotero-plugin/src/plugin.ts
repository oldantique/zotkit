import { NativeBridge } from "./native-bridge";
import {
  ReaderContextService,
  createGeckoProfileAdapter,
  createZotero9ReadAdapter,
  isStaleReaderCaptureError,
  type ReaderContext,
  type ReaderHook,
} from "./reader-context";
import { TerminalPanel, type TerminalPaperOptions } from "./terminal-panel";
import { loadSettings, type ZoteroChatSettings } from "./settings";
import {
  debug,
  logError,
  PANE_ID,
  PLUGIN_ID,
  prefString,
  profilePath,
} from "./platform";

interface PluginStartupData {
  id: string;
  version: string;
  rootURI: string;
}

export const MAX_SELECTION_PROMPT_CHARACTERS = 32_000;

/** Keep the historical class name as a source-level compatibility shim. */
export class ZoteroChatPlugin {
  private settings!: ZoteroChatSettings;
  private readerContext!: ReaderContextService;
  private bridge!: NativeBridge;
  private terminal!: TerminalPanel;
  private views = new Set<HTMLElement>();
  private context: ReaderContext | null = null;
  private notifierID: string | null = null;
  private registeredPaneID: string | null = null;
  private pageRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private tabRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalOpenPromise: Promise<void> | null = null;
  private contextRequestSequence = 0;
  private destroyed = false;

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
      onPasteSelection: () => void this.pasteCurrentSelection(),
      onRefreshContext: () => void this.refreshAndSwitch().catch((error) => this.reportError(error)),
    });

    for (const win of Zotero.getMainWindows()) await this.onMainWindowLoad(win);
    this.registerSection();
    this.registerReaderHooks();
    this.registerPageObserver();
    debug("Zotkit Reader terminal startup complete", { version: data.version });
  }

  async shutdown(): Promise<void> {
    this.destroyed = true;
    this.contextRequestSequence += 1;
    if (this.pageRefreshTimer) clearTimeout(this.pageRefreshTimer);
    this.pageRefreshTimer = null;
    if (this.tabRefreshTimer) clearTimeout(this.tabRefreshTimer);
    this.tabRefreshTimer = null;
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = null;
    }
    this.views.clear();
    this.terminal?.destroy();
    await this.bridge?.stop();
    try {
      if (this.registeredPaneID) {
        Zotero.ItemPaneManager.unregisterSection(this.registeredPaneID);
        this.registeredPaneID = null;
      }
    }
    catch { /* automatically removed by plugin ID */ }
    for (const win of Zotero.getMainWindows()) this.removeWindowAssets(win);
    debug("Zotkit Reader terminal shutdown complete");
  }

  async onMainWindowLoad(win: Window): Promise<void> {
    if (this.destroyed) return;
    this.injectWindowAssets(win);
    const previousHandler = (win as any).__zoteroChatKeyHandler;
    if (previousHandler) win.removeEventListener("keydown", previousHandler, true);
    const keyHandler = (event: KeyboardEvent) => {
      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        this.openSidebar();
        void this.openTerminal().catch((error) => this.reportError(error));
      }
    };
    (win as any).__zoteroChatKeyHandler = keyHandler;
    win.addEventListener("keydown", keyHandler, true);
  }

  async onMainWindowUnload(win: Window): Promise<void> {
    this.removeWindowAssets(win);
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
          onClick: () => void this.pasteCurrentSelection(),
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
        // This creates only DOM. It does not install/start the helper or Codex.
        if (!this.terminal.isOpen || body.closest("collapsible-section")?.hasAttribute("open")) {
          this.terminal.mount(body);
        }
        this.signalReaderBodyReady(body);
      },
      onToggle: ({ body, event }: { body: HTMLElement; event: Event }) => {
        const expanded = Boolean((event.target as HTMLElement | null)?.hasAttribute("open"));
        if (!expanded) {
          this.terminal.setVisible(false);
          return;
        }
        this.views.add(body);
        this.terminal.mount(body);
        void this.openTerminal(body).catch((error) => this.reportError(error));
      },
      onAsyncRender: async ({ body }: { body: HTMLElement }) => {
        // Zotero may render collapsed sections while scrolling the Item Pane.
        // Keep this branch process-free unless the user has expanded it.
        if (!body.closest("collapsible-section")?.hasAttribute("open")) return;
        this.views.add(body);
        this.terminal.mount(body);
        await this.openTerminal(body).catch((error) => this.reportError(error));
      },
    });
    if (!paneID) throw new Error("无法注册 Zotkit 侧栏");
    this.registeredPaneID = paneID;
  }

  private registerReaderHooks(): void {
    Zotero.Reader.registerEventListener("renderToolbar", (event: any) => {
      const { doc, append } = event;
      const button = doc.createElement("button");
      button.type = "button";
      button.title = "打开 Zotkit Agent 终端（⌘⇧J）";
      button.setAttribute("aria-label", button.title);
      button.style.cssText = "display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:6px;background:transparent;cursor:pointer;padding:5px";
      const icon = doc.createElement("img");
      icon.src = "chrome://zotkit/content/icons/icon.svg";
      icon.alt = "";
      icon.style.cssText = "width:22px;height:22px;border-radius:6px";
      button.appendChild(icon);
      button.addEventListener("click", () => {
        void this.acceptReaderHook(event).then(async () => {
          this.openSidebar();
          await this.openTerminal();
          this.terminal.focus();
        }).catch((error) => this.reportError(error));
      });
      append(button);
    }, PLUGIN_ID);

    Zotero.Reader.registerEventListener("renderTextSelectionPopup", (event: any) => {
      const { doc, append } = event;
      const group = doc.createElement("div");
      group.style.cssText = "display:flex;gap:5px;padding:5px 4px 2px";
      const ask = this.readerPopupButton(doc, "Ask in Zotkit", () => {
        void this.acceptReaderHook(event).then(async () => {
          this.openSidebar();
          await this.openTerminal();
          this.insertSelectionPrompt();
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
          if (!this.hasOpenSidebar() || !this.terminal.isOpen) return;
          if (this.pageRefreshTimer) clearTimeout(this.pageRefreshTimer);
          this.pageRefreshTimer = setTimeout(() => {
            this.pageRefreshTimer = null;
            void this.refreshContext(true).catch(() => {});
          }, 800);
          return;
        }
        if (type !== "tab" || !["select", "load"].includes(event)) return;
        if (!this.terminal.hasLiveSessions && !this.terminalOpenPromise) return;
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
    if (!this.terminal.hasLiveSessions && !this.terminalOpenPromise) return;
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
    const pending = this.terminalOpenPromise;
    if (pending) {
      try { await pending; }
      catch { return; }
    }
    if (this.destroyed || !this.terminal.hasLiveSessions || this.selectedTabID() !== tabID) return;
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
        this.terminal.setVisible(false);
      }
      return;
    }
    if (!host?.closest("collapsible-section")?.hasAttribute("open")) {
      this.terminal.setVisible(false);
      return;
    }
    this.terminal.mount(host);
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
    await this.readerContext.ensureZotkitLibrarySnapshot(true);
    if (this.terminal.hasLiveSessions) await this.switchTerminalToContext();
  }

  private async applyContext(
    context: ReaderContext,
    requestSequence: number,
    preferredHost?: HTMLElement,
  ): Promise<void> {
    if (requestSequence !== this.contextRequestSequence || this.destroyed) return;
    const previousLibraryID = this.context?.attachment.libraryID;
    this.context = context;
    if (this.terminal.hasLiveSessions) {
      await this.switchTerminalToContext(
        String(previousLibraryID ?? "") !== String(context.attachment.libraryID ?? ""),
        preferredHost,
        requestSequence,
      );
    }
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

  private async pasteCurrentSelection(): Promise<void> {
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
    this.terminal?.showError(value);
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
    const handler = (win as any).__zoteroChatKeyHandler;
    if (handler) win.removeEventListener("keydown", handler, true);
    delete (win as any).__zoteroChatKeyHandler;
    win.document.getElementById("zotkit-styles")?.remove();
  }

  private readerPopupButton(doc: Document, label: string, callback: () => void): HTMLButtonElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.cssText = "min-height:28px;padding:4px 9px;border:1px solid rgba(120,110,160,.25);border-radius:7px;background:rgba(108,92,231,.11);color:inherit;font:600 11px -apple-system;cursor:pointer";
    button.addEventListener("click", callback);
    return button;
  }
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
