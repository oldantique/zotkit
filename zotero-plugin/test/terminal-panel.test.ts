// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import type { NativeBridge } from "../src/native-bridge";
import {
  MAX_PENDING_TERMINAL_INPUT,
  MAX_MATH_PREVIEW_FORMULAS,
  MAX_TERMINAL_SESSIONS,
  MATH_PREVIEW_DEBOUNCE_MS,
  TERMINAL_READY_TIMEOUT_MS,
  TERMINAL_SESSION_IDLE_MS,
  TerminalPanel,
  extractTerminalMath,
  hasMathPreviewCandidate,
  prependExecutableDirectory,
} from "../src/terminal-panel";

function bridgeStub(): NativeBridge {
  return {
    connected: false,
    onEvent: vi.fn(() => () => undefined),
    start: vi.fn(async () => undefined),
    input: vi.fn(),
    closeSession: vi.fn(),
  } as unknown as NativeBridge;
}

function fakeSession(key: string, lastUsed: number, started = true) {
  return {
    key,
    sessionId: `session-${key}`,
    agent: "codex",
    paperKey: key,
    paperTitle: key,
    workspace: `/profile/${key}`,
    workingDirectory: `/papers/${key}`,
    pdfPath: `/papers/${key}/paper.pdf`,
    terminal: {
      dispose: vi.fn(),
      focus: vi.fn(),
      writeln: vi.fn(),
      options: {},
      buffer: {
        active: {
          length: 0,
          getLine: vi.fn(),
        },
      },
    },
    fit: { fit: vi.fn() },
    element: document.createElement("div"),
    started,
    ready: true,
    exited: false,
    disposed: false,
    readyTimer: null,
    startupOutput: "",
    pendingInput: "",
    zotkitAvailable: true,
    lastUsed,
    mathExpressions: [],
    mathFingerprint: "",
    mathDetectionTail: "",
    mathCandidatePending: false,
    mathPreviewCollapsed: false,
    mathPreviewDismissed: false,
    mathScanTimer: null,
  };
}

function setRenderedLines(
  session: any,
  lines: Array<string | { text: string; wrapped: boolean }>,
): void {
  session.terminal.buffer.active.length = lines.length;
  session.terminal.buffer.active.getLine = vi.fn((index: number) => {
    const line = lines[index];
    return {
      isWrapped: typeof line === "string" ? false : Boolean(line?.wrapped),
      translateToString: () => typeof line === "string" ? line : line?.text || "",
    };
  });
}

describe("terminal rich math extraction", () => {
  it("recognizes supported delimiters and standalone LaTeX brackets", () => {
    const formulas = extractTerminalMath(String.raw`
\(E=mc^2\)
\[
P_e\sim\left(\frac{\Omega}{\Delta}\right)^2
\]
$$\Gamma_{\rm sc}=\Gamma_e P_e$$
[
  V_{ij}=C_6/r_{ij}^6
]
`);

    expect(formulas).toHaveLength(MAX_MATH_PREVIEW_FORMULAS);
    expect(formulas[0]).toContain("P_e\\sim");
    expect(formulas[1]).toContain("\\Gamma_{\\rm sc}");
    expect(formulas[2]).toContain("V_{ij}");
    expect(extractTerminalMath(String.raw`The gap is \(E=mc^2\).`))
      .toEqual(["E=mc^2"]);
  });

  it("deduplicates redraws and ignores citations or terminal badges", () => {
    const formulas = extractTerminalMath(String.raw`
[6, 63–66]
[Zotkit] connected
$$E=\hbar\omega$$
$$E=\hbar\omega$$
`);

    expect(formulas).toEqual([String.raw`E=\hbar\omega`]);
    expect(hasMathPreviewCandidate("\u001b[32m[Zotkit] ready\u001b[0m")).toBe(false);
    expect(hasMathPreviewCandidate(String.raw`\[ P_e\sim 1 \]`)).toBe(true);
  });

  it("accepts ANSI-coloured Codex and Claude bullet prefixes without treating citations as math", () => {
    const codex = "\u001b[36m•\u001b[0m [\nP_e\\sim(\\Omega/\\Delta)^2\n]";
    const claude = "\u001b[35m⏺\u001b[0m [\n\\Gamma_{\\rm sc}=\\Gamma_e P_e\n]";

    expect(hasMathPreviewCandidate(codex)).toBe(true);
    expect(hasMathPreviewCandidate(claude)).toBe(true);
    expect(extractTerminalMath(`${codex}\n${claude}`)).toEqual([
      String.raw`P_e\sim(\Omega/\Delta)^2`,
      String.raw`\Gamma_{\rm sc}=\Gamma_e P_e`,
    ]);
    expect(extractTerminalMath("• [6, 63–66]\n⏺ [Methods]")).toEqual([]);
  });

  it("preserves a complete formula echoed after the user prompt", () => {
    expect(extractTerminalMath(String.raw`› Compare \(P_e=(\Omega/\Delta)^2\) with Eq. 4`))
      .toEqual([String.raw`P_e=(\Omega/\Delta)^2`]);
  });
});

describe("TerminalPanel right-sidebar lifecycle", () => {
  it("adds Homebrew paths even when a Finder-launched Zotero has a non-empty PATH", () => {
    vi.stubGlobal("Services", { env: { get: () => "/usr/bin:/bin" } });

    const path = prependExecutableDirectory("/profile/zotkit/bin/zotkit").split(":");

    expect(path[0]).toBe("/profile/zotkit/bin");
    expect(path).toContain("/opt/homebrew/bin");
    expect(path).toContain("/usr/local/bin");
    expect(path.filter((entry) => entry === "/usr/bin")).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("mounts a lightweight terminal frame without starting the helper", () => {
    const bridge = bridgeStub();
    const panel = new TerminalPanel(bridge, 420);
    const host = document.createElement("div");
    document.body.appendChild(host);

    panel.mount(host);

    expect(host.querySelector(".zc-terminal-sidebar")).not.toBeNull();
    expect(host.textContent).toContain("展开 Zotkit 后才会启动");
    expect(host.querySelector(".zc-zotkit-status")?.textContent).toContain("准备中");
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it("attaches the xterm host to the flexible surface before renderer setup", () => {
    vi.stubGlobal("Services", {
      uuid: { generateUUID: () => "{12345678-1234-1234-1234-123456789abc}" },
    });
    const panel = new TerminalPanel(bridgeStub(), 420) as any;
    const host = document.createElement("div");
    document.body.appendChild(host);
    panel.mount(host);

    const session = panel.createSession("paper:codex", {
      paperKey: "paper",
      paperTitle: "Paper",
      workspace: "/profile/paper",
      workingDirectory: "/papers/paper",
      pdfPath: "/papers/paper.pdf",
      librarySnapshotPath: "/profile/library.jsonl",
    }, "codex");

    expect(session.element.parentElement).toBe(host.querySelector(".zc-terminal-surface"));
    expect(session.element.querySelector(".xterm")).not.toBeNull();
    session.terminal.dispose();
    vi.unstubAllGlobals();
  });

  it("debounces candidate output, then renders KaTeX from the xterm buffer", () => {
    vi.useFakeTimers();
    const panel = new TerminalPanel(bridgeStub(), 420) as any;
    const host = document.createElement("div");
    document.body.appendChild(host);
    panel.mount(host);
    panel.visible = true;
    const session: any = fakeSession("paper", Date.now());
    setRenderedLines(session, [
      "The scattering rate is",
      "[",
      String.raw`P_e\sim\left(\frac{\Omega}{\Delta}\right)^2,`,
      String.raw`\Gamma_{\rm sc}\sim\Gamma_e P_e.`,
      "]",
    ]);
    panel.current = session;
    panel.sessions.set(session.key, session);

    panel.observeMathOutput(session, String.raw`[ P_e\sim`);
    vi.advanceTimersByTime(Math.floor(MATH_PREVIEW_DEBOUNCE_MS / 2));
    panel.observeMathOutput(session, String.raw`\Gamma_{\rm sc}`);
    vi.advanceTimersByTime(Math.ceil(MATH_PREVIEW_DEBOUNCE_MS / 2));
    expect(host.querySelector(".zc-math-preview")?.hasAttribute("hidden")).toBe(true);
    vi.advanceTimersByTime(Math.floor(MATH_PREVIEW_DEBOUNCE_MS / 2));

    expect(host.querySelector(".zc-math-preview")?.hasAttribute("hidden")).toBe(false);
    expect(host.querySelectorAll(".zc-math-preview-card")).toHaveLength(1);
    expect(host.querySelector(".zc-math-preview-formula .katex")).not.toBeNull();
    expect(host.querySelector(".zc-math-preview-formula a")).toBeNull();
    vi.useRealTimers();
  });

  it("waits for xterm's write callback before scheduling a rendered-buffer scan", () => {
    vi.useFakeTimers();
    let listener!: (event: any) => void;
    let writeComplete!: () => void;
    const bridge = {
      ...bridgeStub(),
      onEvent: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      }),
      decodeOutput: vi.fn((_sessionId, data) => data),
    } as unknown as NativeBridge;
    const panel = new TerminalPanel(bridge, 420) as any;
    const host = document.createElement("div");
    document.body.appendChild(host);
    panel.mount(host);
    panel.visible = true;
    const session: any = fakeSession("paper", Date.now());
    session.terminal.write = vi.fn((_output: string, callback: () => void) => {
      writeComplete = callback;
    });
    panel.current = session;
    panel.sessions.set(session.key, session);

    listener({
      type: "output",
      sessionId: session.sessionId,
      data: "\u001b[36m•\u001b[0m [\nP_e\\sim(\\Omega/\\Delta)^2\n]",
    });
    vi.advanceTimersByTime(MATH_PREVIEW_DEBOUNCE_MS * 2);
    expect(session.terminal.buffer.active.getLine).not.toHaveBeenCalled();
    expect(host.querySelector(".zc-math-preview")?.hasAttribute("hidden")).toBe(true);

    setRenderedLines(session, ["• [", String.raw`P_e\sim(\Omega/\Delta)^2`, "]"]);
    writeComplete();
    vi.advanceTimersByTime(MATH_PREVIEW_DEBOUNCE_MS);

    expect(session.terminal.buffer.active.getLine).toHaveBeenCalled();
    expect(host.querySelector(".zc-math-preview-formula .katex")).not.toBeNull();
    vi.useRealTimers();
  });

  it("joins wrapped xterm rows before extracting a formula", () => {
    const panel = new TerminalPanel(bridgeStub(), 420) as any;
    const session: any = fakeSession("paper", Date.now());
    setRenderedLines(session, [
      String.raw`\[`,
      { text: String.raw`P_e\sim\frac{\Om`, wrapped: false },
      { text: String.raw`ega}{\Delta}`, wrapped: true },
      String.raw`\]`,
    ]);

    const rendered = panel.readRenderedTerminalBuffer(session);

    expect(rendered).toContain(String.raw`\frac{\Omega}{\Delta}`);
    expect(extractTerminalMath(rendered)).toEqual([
      String.raw`P_e\sim\frac{\Omega}{\Delta}`,
    ]);
  });

  it("does no buffer scan for ordinary output or while the session is hidden", () => {
    vi.useFakeTimers();
    const panel = new TerminalPanel(bridgeStub(), 420) as any;
    const host = document.createElement("div");
    document.body.appendChild(host);
    panel.mount(host);
    const session: any = fakeSession("paper", Date.now());
    panel.current = session;
    panel.sessions.set(session.key, session);
    const scan = vi.spyOn(panel, "scanMathPreview");

    panel.visible = true;
    panel.observeMathOutput(session, "Working (42s) • esc to interrupt");
    vi.advanceTimersByTime(MATH_PREVIEW_DEBOUNCE_MS * 2);
    expect(scan).not.toHaveBeenCalled();

    panel.visible = false;
    panel.observeMathOutput(session, String.raw`\[E=mc^2\]`);
    vi.advanceTimersByTime(MATH_PREVIEW_DEBOUNCE_MS * 2);
    expect(scan).not.toHaveBeenCalled();
    expect(session.mathCandidatePending).toBe(true);
    vi.useRealTimers();
  });

  it("lets the formula rail collapse, close, and reopen without covering xterm", () => {
    const panel = new TerminalPanel(bridgeStub(), 420) as any;
    const host = document.createElement("div");
    document.body.appendChild(host);
    panel.mount(host);
    const session: any = fakeSession("paper", Date.now());
    session.mathExpressions = [String.raw`E=\hbar\omega`];
    panel.current = session;
    panel.renderMathPreview(session);

    const preview = host.querySelector(".zc-math-preview") as HTMLElement;
    const surface = host.querySelector(".zc-terminal-surface") as HTMLElement;
    expect(preview.nextElementSibling).toBe(surface);
    expect(preview.contains(surface)).toBe(false);

    (preview.querySelector(".zc-math-preview-actions button") as HTMLButtonElement).click();
    expect(preview.classList.contains("is-collapsed")).toBe(true);
    (preview.querySelector(".zc-math-preview-close") as HTMLButtonElement).click();
    expect(preview.hidden).toBe(true);
    (host.querySelector(".zc-math-preview-toggle") as HTMLButtonElement).click();
    expect(preview.hidden).toBe(false);
    expect(preview.classList.contains("is-collapsed")).toBe(false);
  });

  it("keeps KaTeX trust disabled in rich preview", () => {
    const panel = new TerminalPanel(bridgeStub(), 420) as any;
    const host = document.createElement("div");
    document.body.appendChild(host);
    panel.mount(host);
    const session: any = fakeSession("paper", Date.now());
    session.mathExpressions = [String.raw`\href{javascript:alert(1)}{unsafe}`];
    panel.current = session;

    panel.renderMathPreview(session);

    expect(host.querySelector(".zc-math-preview-formula a")).toBeNull();
    expect(host.querySelector(".zc-math-preview-formula [href]")).toBeNull();
    expect(host.querySelector(".zc-math-preview-formula .katex")).not.toBeNull();
  });

  it("shows explicit enabled and unavailable built-in Zotkit states", () => {
    const panel = new TerminalPanel(bridgeStub(), 420) as any;
    const host = document.createElement("div");
    document.body.appendChild(host);
    panel.mount(host);

    panel.setZotkitStatus("enabled");
    expect(host.querySelector(".zc-zotkit-status")?.textContent).toContain("已启用");
    expect(host.querySelector(".zc-zotkit-status")?.classList.contains("is-enabled")).toBe(true);

    panel.setZotkitStatus("missing");
    expect(host.querySelector(".zc-zotkit-status")?.textContent).toContain("快照不可用");
    expect(host.querySelector(".zc-zotkit-status")?.getAttribute("title"))
      .toContain("Reader MCP 仍可使用");
  });

  it("inserts terminal text without an implicit carriage return", () => {
    const bridge = bridgeStub();
    const panel = new TerminalPanel(bridge, 420) as any;
    panel.current = fakeSession("paper", Date.now());

    panel.insert("literal selection", false);

    expect(bridge.input).toHaveBeenCalledWith("session-paper", "literal selection");
  });

  it("queues a selection until the Codex prompt is ready, then flushes it once", () => {
    let listener!: (event: any) => void;
    const bridge = {
      ...bridgeStub(),
      onEvent: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      }),
      decodeOutput: vi.fn((_sessionId, data) => data),
    } as unknown as NativeBridge;
    const panel = new TerminalPanel(bridge, 420) as any;
    const session: any = fakeSession("paper", Date.now());
    session.ready = false;
    session.terminal = { ...session.terminal, write: vi.fn() };
    panel.current = session;
    panel.sessions.set(session.key, session);

    panel.insert("selected passage", false);
    expect(bridge.input).not.toHaveBeenCalled();

    listener({ type: "output", sessionId: session.sessionId, data: "Codex is loading\r\n› " });
    expect(bridge.input).toHaveBeenCalledOnce();
    expect(bridge.input).toHaveBeenCalledWith("session-paper", "selected passage");

    listener({ type: "output", sessionId: session.sessionId, data: "\r\n› " });
    expect(bridge.input).toHaveBeenCalledOnce();
  });

  it("flushes queued input after the startup timeout and clears the timer on disposal", () => {
    vi.useFakeTimers();
    const bridge = bridgeStub();
    const panel = new TerminalPanel(bridge, 420) as any;
    const session: any = fakeSession("paper", Date.now());
    session.agent = "claude";
    session.ready = false;
    session.pendingInput = "selected passage";
    session.readyTimer = setTimeout(() => {
      session.readyTimer = null;
      panel.markSessionReady(session);
    }, TERMINAL_READY_TIMEOUT_MS);
    panel.current = session;
    panel.sessions.set(session.key, session);

    vi.advanceTimersByTime(TERMINAL_READY_TIMEOUT_MS);
    expect(bridge.input).toHaveBeenCalledWith("session-paper", "selected passage");

    session.ready = false;
    session.readyTimer = setTimeout(vi.fn(), TERMINAL_READY_TIMEOUT_MS);
    panel.disposeSession(session, true);
    expect(session.readyTimer).toBeNull();
    vi.useRealTimers();
  });

  it("does not force a Codex selection into startup output and bounds the queue", () => {
    vi.useFakeTimers();
    const bridge = bridgeStub();
    const panel = new TerminalPanel(bridge, 420) as any;
    const session: any = fakeSession("paper", Date.now());
    session.ready = false;
    session.pendingInput = "x".repeat(MAX_PENDING_TERMINAL_INPUT - 2);
    panel.current = session;

    panel.insert("abcd", false);
    vi.advanceTimersByTime(TERMINAL_READY_TIMEOUT_MS * 2);

    expect(session.pendingInput).toHaveLength(MAX_PENDING_TERMINAL_INPUT);
    expect(bridge.input).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("surfaces native input errors instead of failing silently", () => {
    let listener!: (event: any) => void;
    const bridge = {
      onEvent: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      }),
    } as unknown as NativeBridge;
    const panel = new TerminalPanel(bridge, 420) as any;
    const session: any = fakeSession("paper", Date.now());
    session.terminal = { ...session.terminal, writeln: vi.fn() };
    panel.current = session;
    panel.sessions.set(session.key, session);

    listener({ type: "error", message: "PTY input queue exceeds 256 KiB" });

    expect(session.terminal.writeln).toHaveBeenCalledWith(
      expect.stringContaining("PTY input queue exceeds 256 KiB"),
    );
  });

  it("routes a hidden session error to that paper without contaminating the current one", () => {
    let listener!: (event: any) => void;
    const bridge = {
      onEvent: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      }),
    } as unknown as NativeBridge;
    const panel = new TerminalPanel(bridge, 420) as any;
    const hiddenA: any = fakeSession("paper-a", Date.now());
    const currentB: any = fakeSession("paper-b", Date.now());
    panel.sessions.set(hiddenA.key, hiddenA);
    panel.sessions.set(currentB.key, currentB);
    panel.current = currentB;

    listener({
      type: "error",
      sessionId: hiddenA.sessionId,
      message: "paper A PTY input failed",
    });

    expect(hiddenA.terminal.writeln).toHaveBeenCalledWith(
      expect.stringContaining("paper A PTY input failed"),
    );
    expect(currentB.terminal.writeln).not.toHaveBeenCalled();

    listener({
      type: "error",
      sessionId: "session-already-removed",
      message: "stale session error",
    });
    expect(currentB.terminal.writeln).not.toHaveBeenCalled();
  });

  it("marks every paper terminal exited when the bridge reports helper loss", () => {
    let listener!: (event: any) => void;
    const bridge = {
      onEvent: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      }),
      flushOutput: vi.fn(() => ""),
    } as unknown as NativeBridge;
    const panel = new TerminalPanel(bridge, 420) as any;
    const paperA: any = fakeSession("paper-a", Date.now());
    const paperB: any = fakeSession("paper-b", Date.now());
    panel.sessions.set(paperA.key, paperA);
    panel.sessions.set(paperB.key, paperB);
    panel.current = paperB;

    listener({
      type: "exit",
      sessionId: paperA.sessionId,
      exitCode: null,
      signal: null,
    });
    listener({
      type: "exit",
      sessionId: paperB.sessionId,
      exitCode: null,
      signal: null,
    });

    expect(paperA.exited).toBe(true);
    expect(paperB.exited).toBe(true);
    expect(panel.hasLiveSessions).toBe(false);
  });

  it("restores a hidden live session when switching back to its Reader", async () => {
    const panel = new TerminalPanel(bridgeStub(), 420) as any;
    const host = document.createElement("div");
    document.body.append(host);
    panel.mount(host);
    const session = fakeSession("paper:codex", Date.now());
    panel.sessions.set(session.key, session);
    panel.visible = false;
    panel.activate = vi.fn(async () => {});

    await panel.switchPaper({ host, paperKey: "paper" });

    expect(panel.visible).toBe(true);
    expect(panel.activate).toHaveBeenCalledOnce();
  });

  it("does not focus an older activation after a newer paper becomes current", async () => {
    const requestFrame = vi.spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    const panel = new TerminalPanel(bridgeStub(), 420) as any;
    const host = document.createElement("div");
    document.body.append(host);
    panel.mount(host);
    panel.setVisible(true);

    const sessions = new Map<string, any>();
    panel.createSession = vi.fn((key: string) => {
      const session: any = fakeSession(key, Date.now(), false);
      sessions.set(key, session);
      return session;
    });
    let releaseB!: () => void;
    const waitForB = new Promise<void>((resolve) => { releaseB = resolve; });
    panel.startSession = vi.fn(async (session: any) => {
      if (session.key.startsWith("paper-b:")) await waitForB;
      session.started = true;
    });
    const options = (paperKey: string) => ({
      host,
      paperKey,
      paperTitle: paperKey,
      workspace: `/profile/${paperKey}`,
      workingDirectory: `/papers/${paperKey}`,
      pdfPath: `/papers/${paperKey}.pdf`,
      librarySnapshotPath: "/profile/library.jsonl",
      agent: "codex" as const,
    });

    const older = panel.activate(options("paper-b"));
    await Promise.resolve();
    await panel.activate(options("paper-a"));
    releaseB();
    await older;

    const oldSession = sessions.get("paper-b:codex");
    const currentSession = sessions.get("paper-a:codex");
    expect(panel.current).toBe(currentSession);
    expect(oldSession.terminal.focus).not.toHaveBeenCalled();
    expect(currentSession.terminal.focus).toHaveBeenCalledOnce();
    requestFrame.mockRestore();
  });

  it("coalesces concurrent activation of one paper into one native spawn", async () => {
    const panel = new TerminalPanel(bridgeStub(), 420) as any;
    const host = document.createElement("div");
    document.body.append(host);
    panel.mount(host);
    panel.setVisible(true);
    panel.createSession = vi.fn((key: string, sessionOptions: any, agent: string) => ({
      ...fakeSession(key, Date.now(), false),
      agent,
      paperKey: sessionOptions.paperKey,
      paperTitle: sessionOptions.paperTitle,
      workspace: sessionOptions.workspace,
      workingDirectory: sessionOptions.workingDirectory,
      pdfPath: sessionOptions.pdfPath || null,
      librarySnapshotPath: sessionOptions.librarySnapshotPath || null,
      startPromise: null,
      zotkitAvailable: null,
    }));
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    panel.startSession = vi.fn(async (session: any) => {
      await startGate;
      session.started = true;
    });
    const options = {
      host,
      paperKey: "same-paper",
      paperTitle: "Same paper",
      workspace: "/profile/same-paper",
      workingDirectory: "/papers/same-paper",
      pdfPath: "/papers/same-paper.pdf",
      librarySnapshotPath: "/profile/library.jsonl",
      agent: "codex" as const,
    };

    const first = panel.activate(options);
    const second = panel.activate(options);
    await Promise.resolve();
    expect(panel.startSession).toHaveBeenCalledOnce();
    releaseStart();
    await Promise.all([first, second]);

    expect(panel.sessions.size).toBe(1);
    expect(panel.current.started).toBe(true);
  });

  it("cleans up a failed native start before a later retry", async () => {
    const bridge = bridgeStub();
    const panel = new TerminalPanel(bridge, 420) as any;
    const host = document.createElement("div");
    document.body.append(host);
    panel.mount(host);
    panel.setVisible(true);
    panel.createSession = vi.fn((key: string, sessionOptions: any, agent: string) => ({
      ...fakeSession(key, Date.now(), false),
      agent,
      paperKey: sessionOptions.paperKey,
      paperTitle: sessionOptions.paperTitle,
      workspace: sessionOptions.workspace,
      workingDirectory: sessionOptions.workingDirectory,
      pdfPath: sessionOptions.pdfPath || null,
      librarySnapshotPath: sessionOptions.librarySnapshotPath || null,
      startPromise: null,
      zotkitAvailable: null,
    }));
    panel.startSession = vi.fn(async () => { throw new Error("spawn failed"); });
    const options = {
      host,
      paperKey: "failed-paper",
      paperTitle: "Failed paper",
      workspace: "/profile/failed-paper",
      workingDirectory: "/papers/failed-paper",
      agent: "codex" as const,
    };

    await expect(panel.activate(options)).rejects.toThrow("spawn failed");

    expect(panel.sessions.size).toBe(0);
    expect(panel.current).toBeNull();
    expect(bridge.closeSession).toHaveBeenCalledOnce();
  });
});

describe("TerminalPanel resource bounds", () => {
  it("evicts the least-recently-used background PTY at the session cap", () => {
    const bridge = bridgeStub();
    const panel = new TerminalPanel(bridge, 420) as any;
    const sessions = Array.from(
      { length: MAX_TERMINAL_SESSIONS },
      (_, index) => fakeSession(`paper-${index}`, index),
    );
    for (const session of sessions) panel.sessions.set(session.key, session);
    panel.current = sessions.at(-1);

    panel.evictOldestSession();

    expect(panel.sessions.size).toBe(MAX_TERMINAL_SESSIONS - 1);
    expect(panel.sessions.has("paper-0")).toBe(false);
    expect(bridge.closeSession).toHaveBeenCalledWith("session-paper-0");
    expect(sessions[0]!.terminal.dispose).toHaveBeenCalledOnce();
  });

  it("closes idle hidden sessions while preserving the visible terminal", () => {
    const bridge = bridgeStub();
    const panel = new TerminalPanel(bridge, 420) as any;
    const now = 1_000_000;
    const visible = fakeSession("visible", now - TERMINAL_SESSION_IDLE_MS - 1);
    const hidden = fakeSession("hidden", now - TERMINAL_SESSION_IDLE_MS - 1);
    panel.sessions.set(visible.key, visible);
    panel.sessions.set(hidden.key, hidden);
    panel.current = visible;
    panel.visible = true;
    panel.root = document.createElement("section");
    document.body.appendChild(panel.root);

    panel.closeIdleSessions(now);

    expect(panel.sessions.has("visible")).toBe(true);
    expect(panel.sessions.has("hidden")).toBe(false);
    expect(bridge.closeSession).toHaveBeenCalledTimes(1);
    expect(bridge.closeSession).toHaveBeenCalledWith("session-hidden");
  });

  it("does not treat background process output as user activity", () => {
    let listener!: (event: unknown) => void;
    const bridge = {
      onEvent: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      }),
      decodeOutput: vi.fn(() => "progress"),
      closeSession: vi.fn(),
    } as unknown as NativeBridge;
    const panel = new TerminalPanel(bridge, 420) as any;
    const session: any = fakeSession("background", 123);
    session.terminal = { ...session.terminal, write: vi.fn() };
    panel.sessions.set(session.key, session);

    listener({ type: "output", sessionId: session.sessionId, data: "cHJvZ3Jlc3M=" });

    expect(session.lastUsed).toBe(123);
    expect(session.terminal.write).toHaveBeenCalledWith("progress", expect.any(Function));
  });
});
