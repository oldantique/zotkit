import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { NativeBridge } from "./native-bridge";
import { findExecutable, randomID, setPrefString } from "./platform";

export type TerminalAgent = "codex" | "claude";

export const MAX_TERMINAL_SESSIONS = 4;
export const TERMINAL_SESSION_IDLE_MS = 15 * 60 * 1000;
export const TERMINAL_SCROLLBACK_LINES = 5_000;
export const TERMINAL_READY_TIMEOUT_MS = 60_000;
export const MAX_PENDING_TERMINAL_INPUT = 128 * 1_024;
export const CODEX_READER_DEVELOPER_INSTRUCTIONS = [
  "You are the research assistant embedded in Zotero's PDF Reader by Zotkit.",
  "For ordinary questions about the open PDF, call zotero_reader.get_reader_context once; it returns the active-paper metadata, current page, and current selection together.",
  "Never call tools from the same zotero_reader MCP server concurrently or through Promise.all. Await any granular get_active_paper, get_current_page, get_current_selection, list_library_files, or search_library_files calls serially.",
  "The built-in zotkit_library MCP server exposes exactly four read-only tools: zotkit_find_items, zotkit_get_item, zotkit_list_collections, and zotkit_list_tags.",
  "A bundled read-only zotkit CLI with find, get, collections, and tags commands is also on PATH and its absolute path is in ZOTKIT_CLI; it needs no Python install, API key, or external configuration.",
  "Treat the original PDF and its containing directory as read-only. Never create, edit, rename, move, or delete files there.",
  "Never alter Zotero items, collections, tags, attachment links, annotations, notes, indexes, or storage. The bundled Zotkit and Reader tools are query-only.",
  "For references such as this, here, or the selected passage, consult zotero_reader before answering and cite the one-based PDF page.",
].join(" ");

export interface TerminalPaperOptions {
  host: HTMLElement;
  paperKey: string;
  paperTitle: string;
  workspace: string;
  workingDirectory: string;
  pdfPath?: string | null;
  librarySnapshotPath?: string | null;
  pageLabel?: string;
  agent?: TerminalAgent;
}

export interface TerminalPanelCallbacks {
  onPasteSelection?(): void;
  onRefreshContext?(): void;
}

interface TerminalSession {
  key: string;
  sessionId: string;
  agent: TerminalAgent;
  paperKey: string;
  paperTitle: string;
  workspace: string;
  workingDirectory: string;
  pdfPath: string | null;
  librarySnapshotPath: string | null;
  terminal: Terminal;
  fit: FitAddon;
  element: HTMLElement;
  started: boolean;
  ready: boolean;
  exited: boolean;
  disposed: boolean;
  startPromise: Promise<void> | null;
  readyTimer: ReturnType<typeof setTimeout> | null;
  startupOutput: string;
  pendingInput: string;
  zotkitAvailable: boolean | null;
  lastUsed: number;
}

/**
 * A real PTY-backed terminal mounted directly in Zotero's right Item Pane.
 *
 * `mount()` is intentionally presentation-only. The native helper and Codex
 * are not started until `open()` is called after the user expands the section.
 */
export class TerminalPanel {
  private root: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private surface: HTMLElement | null = null;
  private title: HTMLElement | null = null;
  private paperTitle: HTMLElement | null = null;
  private contextMeta: HTMLElement | null = null;
  private zotkitStatus: HTMLElement | null = null;
  private status: HTMLElement | null = null;
  private agentPicker: HTMLSelectElement | null = null;
  private current: TerminalSession | null = null;
  private sessions = new Map<string, TerminalSession>();
  private resizeObserver: ResizeObserver | null = null;
  private idleCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private activationSequence = 0;
  private visible = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly bridge: NativeBridge,
    _legacyDrawerHeight = 420,
    private readonly callbacks: TerminalPanelCallbacks = {},
  ) {
    this.unsubscribe = bridge.onEvent((event) => {
      if (event.type === "output") {
        const session = this.sessionByID(event.sessionId);
        if (session) {
          // Process redraws (notably spinners) are not user activity. Hidden
          // sessions are therefore still eligible for idle cleanup.
          const output = this.bridge.decodeOutput(event.sessionId, event.data);
          session.terminal.write(output);
          this.observeStartupOutput(session, output);
        }
      }
      else if (event.type === "exit") {
        const session = this.sessionByID(event.sessionId);
        if (session) {
          const remaining = this.bridge.flushOutput(event.sessionId);
          if (remaining) session.terminal.write(remaining);
          this.clearReadyTimer(session);
          session.pendingInput = "";
          session.exited = true;
          session.terminal.writeln(
            `\r\n\x1b[90m[process exited${event.exitCode === null ? "" : ` with code ${event.exitCode}`} ]\x1b[0m`,
          );
          this.scheduleIdleCleanup();
        }
      }
      else if (event.type === "error") {
        // Input and resize failures happen after spawn and must remain visible;
        // otherwise a rejected or truncated paste looks like a frozen terminal.
        this.showError(event.message);
      }
    });
  }

  get isOpen(): boolean {
    return this.visible
      && Boolean(this.root?.isConnected)
      && Boolean(this.current?.started)
      && !Boolean(this.current?.exited);
  }

  get hasLiveSessions(): boolean {
    return [...this.sessions.values()].some((session) => !session.exited);
  }

  /** Render the lightweight Mac-style frame without launching any process. */
  mount(host: HTMLElement): void {
    if (this.host === host && this.root?.isConnected) return;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.root?.remove();
    this.host = host;
    host.classList.add("zc-pane-host");
    const doc = host.ownerDocument;

    const root = doc.createElement("section");
    root.className = "zc-terminal-sidebar";

    const bar = doc.createElement("header");
    bar.className = "zc-terminal-titlebar";
    const traffic = doc.createElement("div");
    traffic.className = "zc-traffic-lights";
    const stop = this.trafficButton(doc, "close", "关闭当前会话", () => {
      if (!this.current) return;
      this.disposeSession(this.current, true);
      this.showStatus("会话已关闭。折叠并重新展开可启动新会话。");
    });
    const clear = this.trafficButton(doc, "minimize", "清屏", () => this.current?.terminal.clear());
    const focus = this.trafficButton(doc, "expand", "聚焦终端", () => this.focus());
    traffic.append(stop, clear, focus);

    this.title = doc.createElement("div");
    this.title.className = "zc-terminal-title";
    this.title.textContent = "Zotkit — Codex";

    this.agentPicker = doc.createElement("select");
    this.agentPicker.className = "zc-agent-picker";
    this.agentPicker.title = "选择本地 CLI";
    for (const [value, label] of [
      ["codex", "Codex"],
      ["claude", "Claude Code"],
    ] as const) {
      const option = doc.createElement("option");
      option.value = value;
      option.textContent = label;
      this.agentPicker.appendChild(option);
    }
    this.agentPicker.addEventListener("change", () => {
      if (!this.current || !this.host) return;
      const agent = this.agentPicker!.value as TerminalAgent;
      setPrefString("defaultAgent", agent);
      void this.activate({
        host: this.host,
        paperKey: this.current.paperKey,
        paperTitle: this.current.paperTitle,
        workspace: this.current.workspace,
        workingDirectory: this.current.workingDirectory,
        pdfPath: this.current.pdfPath,
        librarySnapshotPath: this.current.librarySnapshotPath,
        agent,
      }).catch((error) => this.showError(error));
    });
    bar.append(traffic, this.title, this.agentPicker);

    const context = doc.createElement("div");
    context.className = "zc-terminal-context";
    const contextCopy = doc.createElement("div");
    contextCopy.className = "zc-terminal-context-copy";
    this.paperTitle = doc.createElement("div");
    this.paperTitle.className = "zc-terminal-paper-title";
    this.paperTitle.textContent = "展开后连接当前 PDF";
    this.contextMeta = doc.createElement("div");
    this.contextMeta.className = "zc-terminal-context-meta";
    this.contextMeta.textContent = "真实 Codex CLI · 只读沙箱";
    contextCopy.append(this.paperTitle, this.contextMeta);
    this.zotkitStatus = doc.createElement("span");
    this.zotkitStatus.className = "zc-zotkit-status is-checking";
    this.zotkitStatus.textContent = "内置 Zotkit：准备中…";
    this.zotkitStatus.title = "XPI 内置只读 Zotkit CLI 与文库工具";
    const actions = doc.createElement("div");
    actions.className = "zc-terminal-context-actions";
    const paste = doc.createElement("button");
    paste.type = "button";
    paste.textContent = "粘贴选区";
    paste.title = "把当前 PDF 选区原文插入终端，不自动发送";
    paste.addEventListener("click", () => this.callbacks.onPasteSelection?.());
    const refresh = doc.createElement("button");
    refresh.type = "button";
    refresh.textContent = "刷新";
    refresh.title = "刷新当前论文、页码和选区";
    refresh.addEventListener("click", () => this.callbacks.onRefreshContext?.());
    actions.append(paste, refresh);
    context.append(contextCopy, this.zotkitStatus, actions);

    this.surface = doc.createElement("div");
    this.surface.className = "zc-terminal-surface";
    this.status = doc.createElement("div");
    this.status.className = "zc-terminal-status";
    this.status.textContent = "展开 Zotkit 后才会启动本地 Codex CLI";
    this.surface.appendChild(this.status);
    root.append(bar, context, this.surface);
    host.replaceChildren(root);
    this.root = root;

    const ResizeObserverConstructor = doc.defaultView?.ResizeObserver;
    if (ResizeObserverConstructor) {
      this.resizeObserver = new ResizeObserverConstructor(() => {
        if (this.visible) this.fitCurrent();
      });
      this.resizeObserver.observe(root);
    }
  }

  unmount(host: HTMLElement): void {
    if (this.host !== host) return;
    this.setVisible(false);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.root?.remove();
    this.root = null;
    this.surface = null;
    this.title = null;
    this.paperTitle = null;
    this.contextMeta = null;
    this.zotkitStatus = null;
    this.status = null;
    this.agentPicker = null;
    this.host = null;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.current && !this.current.disposed) {
      this.current.terminal.options.cursorBlink = visible;
    }
    if (visible) requestAnimationFrame(() => this.fitCurrent());
    this.scheduleIdleCleanup();
  }

  async open(options: TerminalPaperOptions): Promise<void> {
    this.mount(options.host);
    this.setVisible(true);
    this.setZotkitStatus("checking");
    this.showStatus("正在连接本地 CLI…");
    // This is the deliberate lazy-start boundary. `mount()` never gets here.
    if (!this.bridge.connected) await this.bridge.start();
    await this.activate(options);
  }

  async switchPaper(options: TerminalPaperOptions): Promise<void> {
    if (!this.hasLiveSessions) return;
    this.mount(options.host);
    this.setVisible(true);
    await this.activate({
      ...options,
      agent: (this.agentPicker?.value as TerminalAgent) || options.agent || "codex",
    });
  }

  /** Insert text into the live TUI. No carriage return is added by default. */
  insert(text: string, submit = false): void {
    if (!this.current || this.current.exited || !this.current.started) return;
    this.touchSession(this.current);
    const input = text + (submit ? "\r" : "");
    if (!this.current.ready) {
      const available = MAX_PENDING_TERMINAL_INPUT - this.current.pendingInput.length;
      if (available <= 0) {
        this.showError("CLI 启动期间等待插入的文本过长，请在终端就绪后重试");
        return;
      }
      this.current.pendingInput += input.slice(0, available);
      if (input.length > available) {
        this.showError("CLI 启动期间的插入文本已限制为 128 KiB");
      }
    }
    else this.bridge.input(this.current.sessionId, input);
    this.focus();
  }

  focus(): void {
    this.current?.terminal.focus();
  }

  showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.current?.started && !this.current.exited) {
      this.current.terminal.writeln(`\r\n\x1b[31m[Zotkit] ${message}\x1b[0m`);
      return;
    }
    this.showStatus(message, true);
  }

  destroy(): void {
    if (this.host) this.unmount(this.host);
    if (this.idleCleanupTimer) clearTimeout(this.idleCleanupTimer);
    this.idleCleanupTimer = null;
    for (const session of [...this.sessions.values()]) this.disposeSession(session, true);
    this.unsubscribe();
  }

  private async activate(options: TerminalPaperOptions): Promise<void> {
    const activationSequence = ++this.activationSequence;
    const agent = options.agent || "codex";
    const key = `${options.paperKey}:${agent}`;
    let session = this.sessions.get(key);
    if (
      session
      && (session.workspace !== options.workspace
        || session.workingDirectory !== options.workingDirectory
        || session.pdfPath !== (options.pdfPath || null)
        || session.librarySnapshotPath !== (options.librarySnapshotPath || null))
    ) {
      // A linked attachment can be relinked while Zotero remains open. Never
      // label an existing PTY with a cwd it does not actually have.
      this.disposeSession(session, true);
      session = undefined;
    }
    if (!session || session.exited) {
      if (session) {
        session.terminal.dispose();
        this.sessions.delete(key);
      }
      this.evictOldestSession();
      session = this.createSession(key, options, agent);
      this.sessions.set(key, session);
    }
    if (this.current && this.current !== session && !this.current.disposed) {
      this.current.terminal.options.cursorBlink = false;
    }
    session.lastUsed = Date.now();
    this.current = session;
    session.terminal.options.cursorBlink = this.visible;
    this.surface!.replaceChildren(session.element);
    this.agentPicker!.value = agent;
    this.updateHeader(options, agent);
    if (!session.started) await this.ensureSessionStarted(session);
    else this.setZotkitStatus(session.zotkitAvailable ? "enabled" : "missing");
    if (
      activationSequence !== this.activationSequence
      || this.current !== session
      || session.disposed
    ) return;
    this.scheduleIdleCleanup();
    requestAnimationFrame(() => {
      this.fitCurrent();
      session!.terminal.focus();
    });
  }

  private createSession(
    key: string,
    options: TerminalPaperOptions,
    agent: TerminalAgent,
  ): TerminalSession {
    const doc = this.root!.ownerDocument;
    const element = doc.createElement("div");
    element.className = "zc-terminal-instance";
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: this.visible,
      cursorStyle: "bar",
      fontFamily: '"SFMono-Regular", "SF Mono", Menlo, Monaco, monospace',
      fontSize: 12,
      lineHeight: 1.22,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      macOptionIsMeta: true,
      convertEol: false,
      theme: {
        background: "#151419",
        foreground: "#e9e7ed",
        cursor: "#9b8cff",
        selectionBackground: "#5f4ed866",
        black: "#25232a",
        red: "#ff6b67",
        green: "#61d887",
        yellow: "#f3c969",
        blue: "#7ba8ff",
        magenta: "#b792ff",
        cyan: "#66d9d0",
        white: "#e9e7ed",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon((_event, uri) => Zotero.launchURL(uri)));
    terminal.open(element);
    const session: TerminalSession = {
      key,
      sessionId: randomID("term").slice(0, 64),
      agent,
      paperKey: options.paperKey,
      paperTitle: options.paperTitle,
      workspace: options.workspace,
      workingDirectory: options.workingDirectory,
      pdfPath: options.pdfPath || null,
      librarySnapshotPath: options.librarySnapshotPath || null,
      terminal,
      fit,
      element,
      started: false,
      ready: false,
      exited: false,
      disposed: false,
      startPromise: null,
      readyTimer: null,
      startupOutput: "",
      pendingInput: "",
      zotkitAvailable: null,
      lastUsed: Date.now(),
    };
    terminal.onData((data) => {
      if (!session.disposed && !session.exited && session.started) {
        this.touchSession(session);
        this.bridge.input(session.sessionId, data);
      }
    });
    terminal.onResize(({ rows, cols }) => {
      if (!session.exited && session.started) this.bridge.resize(session.sessionId, rows, cols);
    });
    return session;
  }

  private async startSession(session: TerminalSession): Promise<void> {
    session.terminal.writeln("\x1b[90mConnecting to local CLI…\x1b[0m");
    session.zotkitAvailable = Boolean(session.librarySnapshotPath);
    this.setZotkitStatus(session.zotkitAvailable ? "enabled" : "missing");
    const readerServer = {
      command: this.bridge.helperPath,
      args: ["--mcp-stdio", "--context", session.workspace],
    };
    const zotkitServer = {
      command: this.bridge.helperPath,
      args: ["--zotkit-mcp", "--context", session.workspace],
    };
    const mcpServers: Record<string, { command: string; args: string[] }> = {
      zotero_reader: readerServer,
      zotkit_library: zotkitServer,
    };
    const mcpConfigPath = PathUtils.join(session.workspace, "zotkit-mcp.json");
    await IOUtils.writeUTF8(
      mcpConfigPath,
      JSON.stringify({ mcpServers }, null, 2) + "\n",
      { tmpPath: mcpConfigPath + ".tmp" },
    );
    await IOUtils.setPermissions?.(mcpConfigPath, 0o600, false);

    let executable: string | null;
    let argv: string[];
    if (session.agent === "codex") {
      executable = await findExecutable("codex");
      if (!executable) throw new Error("未找到 Codex CLI");
      argv = [
        executable,
        "--no-alt-screen",
        "--disable", "code_mode_host",
        "--sandbox", "read-only",
        "--ask-for-approval", "untrusted",
        "--cd", session.workingDirectory,
        "-c", `developer_instructions=${tomlString(CODEX_READER_DEVELOPER_INSTRUCTIONS)}`,
        ...codexMcpArguments("zotero_reader", readerServer),
        ...codexMcpArguments("zotkit_library", zotkitServer),
      ];
    }
    else {
      executable = await findExecutable("claude");
      if (!executable) throw new Error("未找到 Claude Code CLI");
      argv = [executable, "--permission-mode", "plan", "--mcp-config", mcpConfigPath];
    }
    await this.bridge.spawn(session.sessionId, {
      argv,
      cwd: session.workingDirectory,
      env: {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        PATH: prependExecutableDirectory(this.bridge.zotkitPath),
        ZOTKIT_PAPER_KEY: session.paperKey,
        ZOTKIT_CLI: this.bridge.zotkitPath,
        ZOTKIT_READER_CONTEXT: PathUtils.join(session.workspace, "context.json"),
        ZOTKIT_SNAPSHOT: session.librarySnapshotPath || "",
        ZOTKIT_PDF_PATH: session.pdfPath || "",
        // Compatibility for users who referenced the original variables.
        ZOTEROCHAT_PAPER_KEY: session.paperKey,
        ZOTEROCHAT_CONTEXT: PathUtils.join(session.workspace, "context.json"),
      },
      rows: session.terminal.rows || 24,
      cols: session.terminal.cols || 52,
    });
    session.started = true;
    if (session.disposed) {
      this.bridge.closeSession(session.sessionId);
      return;
    }
    if (session.ready) this.flushPendingInput(session);
    else if (session.agent === "claude") {
      // Codex has a stable `›` prompt marker, so never force queued paper text
      // into its startup stream. Claude gets a conservative compatibility
      // fallback in case a future release changes its prompt glyph.
      session.readyTimer = setTimeout(() => {
        session.readyTimer = null;
        this.markSessionReady(session);
      }, TERMINAL_READY_TIMEOUT_MS);
    }
  }

  private async ensureSessionStarted(session: TerminalSession): Promise<void> {
    if (session.started) return;
    if (!session.startPromise) {
      session.startPromise = (async () => {
        try {
          await this.startSession(session);
        }
        catch (error) {
          // Spawn can fail after the helper has accepted the ID. Close both the
          // native side and the local xterm state before allowing a retry.
          this.bridge.closeSession(session.sessionId);
          if (!session.disposed) this.disposeSession(session, false);
          throw error;
        }
        finally {
          session.startPromise = null;
        }
      })();
    }
    await session.startPromise;
  }

  private updateHeader(options: TerminalPaperOptions, agent: TerminalAgent): void {
    if (this.title) {
      const agentName = agent === "claude" ? "Claude Code" : "Codex";
      this.title.textContent = `Zotkit — ${agentName}`;
    }
    if (this.paperTitle) this.paperTitle.textContent = options.paperTitle;
    if (this.contextMeta) {
      const page = options.pageLabel ? `PDF ${options.pageLabel}` : "PDF";
      this.contextMeta.textContent = `${page} · cwd: ${options.workingDirectory}`;
      this.contextMeta.title = this.contextMeta.textContent;
    }
  }

  private setZotkitStatus(state: "checking" | "enabled" | "missing"): void {
    if (!this.zotkitStatus) return;
    this.zotkitStatus.classList.remove("is-checking", "is-enabled", "is-missing");
    this.zotkitStatus.classList.add(`is-${state}`);
    if (state === "enabled") {
      this.zotkitStatus.textContent = "内置 Zotkit：已启用";
      this.zotkitStatus.title = "XPI 内置只读 CLI 与 zotkit_library MCP；无需 Python、凭据或额外安装";
    }
    else if (state === "missing") {
      this.zotkitStatus.textContent = "内置 Zotkit：快照不可用";
      this.zotkitStatus.title = "当前文库元数据快照不可用；Reader MCP 仍可使用";
    }
    else {
      this.zotkitStatus.textContent = "内置 Zotkit：准备中…";
      this.zotkitStatus.title = "正在准备 XPI 内置只读文库工具";
    }
  }

  private showStatus(message: string, error = false): void {
    if (!this.surface || !this.status) return;
    if (!this.status.isConnected) this.surface.replaceChildren(this.status);
    this.status.textContent = message;
    this.status.classList.toggle("is-error", error);
  }

  private fitCurrent(): void {
    if (!this.current || this.current.disposed || !this.root?.isConnected) return;
    try { this.current.fit.fit(); }
    catch { /* the Item Pane may be between layout passes */ }
  }

  private sessionByID(sessionId: string): TerminalSession | undefined {
    return [...this.sessions.values()].find((item) => item.sessionId === sessionId);
  }

  private evictOldestSession(): void {
    if (this.sessions.size < MAX_TERMINAL_SESSIONS) return;
    const candidates = [...this.sessions.values()]
      .filter((session) => session !== this.current)
      .sort((left, right) => left.lastUsed - right.lastUsed);
    const oldest = candidates[0];
    if (oldest) this.disposeSession(oldest, true);
  }

  private touchSession(session: TerminalSession): void {
    session.lastUsed = Date.now();
    this.scheduleIdleCleanup();
  }

  private observeStartupOutput(session: TerminalSession, output: string): void {
    if (session.ready || session.disposed || session.exited) return;
    session.startupOutput = (session.startupOutput + output).slice(-8_192);
    const prompt = session.agent === "codex" ? "›" : "❯";
    if (session.startupOutput.includes(prompt)) this.markSessionReady(session);
  }

  private markSessionReady(session: TerminalSession): void {
    if (session.ready || session.disposed || session.exited) return;
    session.ready = true;
    session.startupOutput = "";
    this.clearReadyTimer(session);
    this.flushPendingInput(session);
  }

  private flushPendingInput(session: TerminalSession): void {
    if (!session.started || !session.ready || !session.pendingInput) return;
    const input = session.pendingInput;
    session.pendingInput = "";
    this.bridge.input(session.sessionId, input);
  }

  private clearReadyTimer(session: TerminalSession): void {
    if (session.readyTimer === null) return;
    clearTimeout(session.readyTimer);
    session.readyTimer = null;
  }

  private closeIdleSessions(now = Date.now()): void {
    for (const session of [...this.sessions.values()]) {
      const isVisible = this.visible && this.current === session && Boolean(this.root?.isConnected);
      if (isVisible || now - session.lastUsed < TERMINAL_SESSION_IDLE_MS) continue;
      this.disposeSession(session, true);
    }
  }

  private scheduleIdleCleanup(): void {
    if (this.idleCleanupTimer) clearTimeout(this.idleCleanupTimer);
    this.idleCleanupTimer = null;
    const candidates = [...this.sessions.values()].filter(
      (session) => !(this.visible && this.current === session && this.root?.isConnected),
    );
    if (!candidates.length) return;
    const nextExpiry = Math.min(
      ...candidates.map((session) => session.lastUsed + TERMINAL_SESSION_IDLE_MS),
    );
    this.idleCleanupTimer = setTimeout(() => {
      this.idleCleanupTimer = null;
      this.closeIdleSessions();
      this.scheduleIdleCleanup();
    }, Math.max(0, nextExpiry - Date.now()));
  }

  private disposeSession(session: TerminalSession, closeProcess: boolean): void {
    if (session.disposed) return;
    session.disposed = true;
    this.clearReadyTimer(session);
    session.pendingInput = "";
    if (closeProcess && session.started && !session.exited) {
      this.bridge.closeSession(session.sessionId);
    }
    session.exited = true;
    session.terminal.dispose();
    this.sessions.delete(session.key);
    if (this.current === session) this.current = null;
  }

  private trafficButton(
    doc: Document,
    className: string,
    title: string,
    callback: () => void,
  ): HTMLButtonElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = className;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", callback);
    return button;
  }
}

function codexMcpArguments(
  name: string,
  server: { command: string; args: string[] },
): string[] {
  return [
    "-c", `mcp_servers.${name}.command=${tomlString(server.command)}`,
    "-c", `mcp_servers.${name}.args=[${server.args.map(tomlString).join(",")}]`,
    "-c", `mcp_servers.${name}.enabled=true`,
    // Both XPI-bundled servers expose query-only tools. Approve only these two
    // servers up front so Codex 0.145 does not hide an MCP approval request
    // inside unified exec; shell commands and the user's other MCPs retain the
    // global untrusted approval policy.
    "-c", `mcp_servers.${name}.default_tools_approval_mode=${tomlString("approve")}`,
    "-c", `mcp_servers.${name}.tool_timeout_sec=10`,
  ];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function prependExecutableDirectory(executable: string): string {
  const separator = executable.lastIndexOf("/");
  const directory = separator > 0 ? executable.slice(0, separator) : executable;
  let inherited = "";
  try { inherited = Services.env.get("PATH") || ""; }
  catch { /* use the minimal macOS path below */ }
  const fallback = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  // Finder-launched GUI apps often inherit a non-empty but incomplete PATH
  // such as /usr/bin:/bin. Always add the standard Homebrew/local locations
  // so the user's existing Codex MCP commands (for example `node`) still work.
  return [...new Set(
    [directory, ...inherited.split(":"), ...fallback.split(":")].filter(Boolean),
  )].join(":");
}
