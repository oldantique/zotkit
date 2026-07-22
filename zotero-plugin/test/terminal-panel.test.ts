// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import type { NativeBridge } from "../src/native-bridge";
import {
  MAX_PENDING_TERMINAL_INPUT,
  MAX_TERMINAL_SESSIONS,
  TERMINAL_READY_TIMEOUT_MS,
  TERMINAL_SESSION_IDLE_MS,
  TerminalPanel,
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
    terminal: { dispose: vi.fn(), focus: vi.fn(), writeln: vi.fn(), options: {} },
    fit: { fit: vi.fn() },
    element: document.createElement("div"),
    started,
    ready: true,
    exited: false,
    disposed: false,
    readyTimer: null,
    startupOutput: "",
    pendingInput: "",
    lastUsed,
  };
}

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
    expect(session.terminal.write).toHaveBeenCalledWith("progress");
  });
});
