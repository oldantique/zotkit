// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/note-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/note-sync")>();
  return { ...actual, syncChatNote: vi.fn(async () => {}) };
});

import {
  MAX_SELECTION_PROMPT_CHARACTERS,
  ZoteroChatPlugin,
  buildSelectionPrompt,
  formatPendingApprovalDescription,
  pdfDirectory,
} from "../src/plugin";
import { syncChatNote } from "../src/note-sync";
import type { ReaderContext } from "../src/reader-context";

describe("Zotkit Reader terminal state", () => {
  it("shows exact requested permissions in the approval description", () => {
    const description = formatPendingApprovalDescription({
      description: "Stage a generated PDF",
      cwd: "/profile/papers/1-ATTACH",
      requestedPermissions: {
        network: { enabled: true },
        fileSystem: {
          entries: [{
            access: "write",
            path: { type: "path", path: "/profile/papers/1-ATTACH/staging" },
          }],
        },
      },
    });

    expect(description).toContain("Stage a generated PDF");
    expect(description).toContain('"network":{"enabled":true}');
    expect(description).toContain("/profile/papers/1-ATTACH/staging");
  });

  it("matches Cursor's Reader shortcuts while leaving editable controls alone", async () => {
    const plugin = new ZoteroChatPlugin() as any;
    plugin.openSidebar = vi.fn();
    plugin.openResearchChat = vi.fn(async () => {});
    plugin.openChatWithSelection = vi.fn(async () => {});
    plugin.openTerminal = vi.fn(async () => {});
    plugin.terminal = { focus: vi.fn() };
    plugin.installShortcutHandler(window);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", metaKey: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", metaKey: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "L", metaKey: true, shiftKey: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, shiftKey: true, bubbles: true }));
    await Promise.resolve();

    expect(plugin.openResearchChat).toHaveBeenCalledWith(undefined, true);
    expect(plugin.openChatWithSelection).toHaveBeenNthCalledWith(1, true);
    expect(plugin.openChatWithSelection).toHaveBeenNthCalledWith(2, false);
    expect(plugin.openTerminal).toHaveBeenCalledOnce();
    expect(plugin.terminal.focus).toHaveBeenCalledOnce();

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "i", metaKey: true, bubbles: true }));
    expect(plugin.openResearchChat).toHaveBeenCalledOnce();
    plugin.removeShortcutHandler(window);
    input.remove();
  });

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
    plugin.codex = { setInteractionContext: vi.fn(), state: { connected: false } };
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
    plugin.codex = { setInteractionContext: vi.fn(), state: { connected: false } };
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

  it("renderFloatPanels pushes the latest exchange, running state, and selection chip into the panel", () => {
    const previousZotero = (globalThis as any).Zotero;
    (globalThis as any).Zotero = { getMainWindow: () => window };
    const plugin = new ZoteroChatPlugin() as any;
    plugin.codex = {
      setInteractionContext: vi.fn(),
      state: {
        running: true,
        fallbackReason: null,
        models: [{ id: "gpt-5", label: "GPT-5" }, { id: "gpt-5-codex", label: "GPT-5 Codex" }],
      },
      getChatEntries: () => [
        { id: "u1", kind: "user", text: "old question" },
        { id: "a1", kind: "assistant", text: "old answer" },
        { id: "u2", kind: "user", text: "latest question" },
        { id: "a2", kind: "assistant", text: "latest answer" },
      ],
    };
    plugin.selectedModel = "gpt-5-codex";
    plugin.context = {
      selection: { text: "chosen theorem", pageNumber: 3 },
      page: { pageNumber: 3 },
      attachment: { title: "A Test Paper", creators: [] },
    };
    plugin.addedContextIDs.add("current-selection");
    plugin.chatPhase = "ready";
    const entry = plugin.mountFloatPanel(window);
    entry.view.show();

    plugin.renderFloatPanels();

    const root = document.querySelector<HTMLElement>(".zc-float")!;
    expect(root.textContent).toContain("latest question");
    expect(root.textContent).not.toContain("old question");
    expect(root.textContent).toContain("已选 14 字");
    expect(root.querySelector<HTMLElement>(".zc-float-stop")!.hidden).toBe(false);
    expect(root.querySelector(".zc-float-title")?.textContent).toBe("A Test Paper");
    const modelSelect = root.querySelector<HTMLSelectElement>(".zc-float-model")!;
    expect(modelSelect.hidden).toBe(false);
    expect(modelSelect.value).toBe("gpt-5-codex");

    entry.view.destroy();
    entry.host.remove();
    plugin.floatPanels.clear();
    (globalThis as any).Zotero = previousZotero;
  });

  describe("float panel size persistence", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
      // Defensive: a mid-assertion failure would otherwise skip the inline
      // `entry.host.remove()` cleanup below and leave a stale `.zc-float`
      // node in `document`, corrupting the next test's querySelector.
      document.querySelectorAll(".zc-float-host").forEach((node) => node.remove());
    });

    it("restores the persisted floatSize onto the panel as an inline style when mounting", () => {
      vi.stubGlobal("Services", {
        prefs: {
          getStringPref: (key: string, fallback: string) =>
            key === "extensions.zotkit.floatSize" ? "540x480" : fallback,
          setStringPref: () => {},
        },
      });

      const plugin = new ZoteroChatPlugin() as any;
      const entry = plugin.mountFloatPanel(window);
      const root = document.querySelector<HTMLElement>(".zc-float")!;

      expect(root.style.width).toBe("540px");
      expect(root.style.height).toBe("480px");

      entry.view.destroy();
      entry.host.remove();
      plugin.floatPanels.clear();
    });

    it("ignores an unparsable persisted floatSize", () => {
      vi.stubGlobal("Services", {
        prefs: {
          getStringPref: (key: string, fallback: string) =>
            key === "extensions.zotkit.floatSize" ? "not-a-size" : fallback,
          setStringPref: () => {},
        },
      });

      const plugin = new ZoteroChatPlugin() as any;
      const entry = plugin.mountFloatPanel(window);
      const root = document.querySelector<HTMLElement>(".zc-float")!;

      expect(root.style.width).toBe("");
      expect(root.style.height).toBe("");

      entry.view.destroy();
      entry.host.remove();
      plugin.floatPanels.clear();
    });

    it("persists the debounced panel size from onPanelResize, skipping the initial observation", () => {
      vi.useFakeTimers();
      const setStringPref = vi.fn();
      vi.stubGlobal("Services", {
        prefs: {
          getStringPref: (_key: string, fallback: string) => fallback,
          setStringPref,
        },
      });

      let observedCallback: ResizeObserverCallback | null = null;
      class FakeResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          observedCallback = callback;
        }
        observe(): void {}
        disconnect(): void {}
      }
      vi.stubGlobal("ResizeObserver", FakeResizeObserver);

      const plugin = new ZoteroChatPlugin() as any;
      const entry = plugin.mountFloatPanel(window);
      expect(observedCallback).not.toBeNull();

      // The first ResizeObserver notification reflects the panel's initial
      // (possibly pref-restored) size, not a user drag, so it must not be
      // persisted.
      observedCallback!([{ contentRect: { width: 620, height: 400 } } as ResizeObserverEntry], {} as ResizeObserver);
      expect(setStringPref).not.toHaveBeenCalled();

      // A subsequent notification is a real user resize.
      observedCallback!([{ contentRect: { width: 700, height: 500 } } as ResizeObserverEntry], {} as ResizeObserver);
      expect(setStringPref).not.toHaveBeenCalled();
      vi.advanceTimersByTime(499);
      expect(setStringPref).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(setStringPref).toHaveBeenCalledWith("extensions.zotkit.floatSize", "700x500");

      entry.view.destroy();
      entry.host.remove();
      plugin.floatPanels.clear();
    });
  });

  it("records turn duration keyed by the opening user entry when running flips off", () => {
    vi.useFakeTimers();
    try {
      const plugin = new ZoteroChatPlugin() as any;
      plugin.codex = {
        setInteractionContext: vi.fn(),
        state: {
          activeThreadId: "th1",
          running: true,
          fallbackReason: null,
          models: [],
          mode: "ask",
        },
        getChatEntries: () => [
          { id: "u1", kind: "user", text: "问" },
          { id: "a1", kind: "assistant", text: "答" },
        ],
        getActivePlan: () => null,
        getActiveDiffs: () => [],
        getPendingApprovals: () => [],
        getCheckpoints: () => [],
        getThreadOptions: () => [],
        isSignedIn: () => false,
      };

      vi.setSystemTime(new Date("2026-07-23T10:00:00Z"));
      plugin.renderChatViews();

      vi.setSystemTime(new Date("2026-07-23T10:00:28Z"));
      plugin.codex.state.running = false;
      plugin.renderChatViews();

      expect(plugin.turnDurationsForActiveThread()).toEqual({ u1: 28_000 });
    }
    finally {
      vi.useRealTimers();
    }
  });

  it("clears stale turn timers for other threads once the service goes idle", () => {
    vi.useFakeTimers();
    try {
      const plugin = new ZoteroChatPlugin() as any;
      plugin.onTurnCompleted = vi.fn();
      plugin.codex = {
        setInteractionContext: vi.fn(),
        state: {
          activeThreadId: "A",
          running: true,
          fallbackReason: null,
          models: [],
          mode: "ask",
        },
        getChatEntries: () => [
          { id: "u1", kind: "user", text: "问 A" },
        ],
        getActivePlan: () => null,
        getActiveDiffs: () => [],
        getPendingApprovals: () => [],
        getCheckpoints: () => [],
        getThreadOptions: () => [],
        isSignedIn: () => false,
      };

      vi.setSystemTime(new Date("2026-07-23T10:00:00Z"));
      plugin.renderChatViews(); // Thread A starts running.

      // The user switches to thread B mid-turn; the service interrupts A and goes idle on B.
      vi.setSystemTime(new Date("2026-07-23T10:05:00Z"));
      plugin.codex.state.activeThreadId = "B";
      plugin.codex.state.running = false;
      plugin.codex.getChatEntries = () => [];
      plugin.renderChatViews();

      expect(plugin.turnDurationsForActiveThread()).toEqual({});
      expect(plugin.onTurnCompleted).not.toHaveBeenCalled();

      // Reopening A while idle must not fabricate a completed turn from the stale start time.
      plugin.codex.state.activeThreadId = "A";
      plugin.codex.getChatEntries = () => [
        { id: "u1", kind: "user", text: "问 A" },
      ];
      plugin.renderChatViews();

      expect(plugin.turnDurationsForActiveThread()).toEqual({});
      expect(plugin.onTurnCompleted).not.toHaveBeenCalled();
    }
    finally {
      vi.useRealTimers();
    }
  });

  it("onMainWindowUnload destroys the window's float panel", async () => {
    const previousZotero = (globalThis as any).Zotero;
    (globalThis as any).Zotero = { getMainWindow: () => window };
    const plugin = new ZoteroChatPlugin() as any;
    plugin.codex = { setInteractionContext: vi.fn(), state: { connected: false } };
    plugin.context = null;
    plugin.ensureChatSession = vi.fn(async () => {});
    plugin.renderChatViews = vi.fn();

    await plugin.toggleFloatPanel();
    expect(document.querySelector(".zc-float")).not.toBeNull();

    await plugin.onMainWindowUnload(window);
    expect(document.querySelector(".zc-float")).toBeNull();
    expect(plugin.floatPanels.size).toBe(0);

    (globalThis as any).Zotero = previousZotero;
  });

  it("Escape closes the float panel from anywhere and restores focus", async () => {
    const previousZotero = (globalThis as any).Zotero;
    (globalThis as any).Zotero = { getMainWindow: () => window };
    const plugin = new ZoteroChatPlugin() as any;
    plugin.codex = { setInteractionContext: vi.fn(), state: { connected: false } };
    plugin.context = null;
    plugin.ensureChatSession = vi.fn(async () => {});
    plugin.renderChatViews = vi.fn();

    await plugin.toggleFloatPanel();
    const root = document.querySelector<HTMLElement>(".zc-float")!;
    expect(root.hidden).toBe(false);

    plugin.installShortcutHandler(window);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.hidden).toBe(true);

    plugin.removeShortcutHandler(window);
    plugin.floatPanels.get(window)?.view.destroy();
    plugin.floatPanels.get(window)?.host.remove();
    plugin.floatPanels.clear();
    (globalThis as any).Zotero = previousZotero;
  });

  it("treats only an expanded, connected custom section as active", () => {
    const plugin = new ZoteroChatPlugin() as any;
    const collapsed = document.createElement("collapsible-section");
    const body = document.createElement("div");
    collapsed.appendChild(body);
    document.body.appendChild(collapsed);
    plugin.views = new Set([body]);

    expect(plugin.hasOpenSidebar()).toBe(false);
    collapsed.setAttribute("open", "");
    expect(plugin.hasOpenSidebar()).toBe(true);
    collapsed.remove();
    expect(plugin.hasOpenSidebar()).toBe(false);
  });

  it("coalesces concurrent first expansion into one lazy terminal startup", async () => {
    let release!: () => void;
    const startup = new Promise<void>((resolve) => { release = resolve; });
    const plugin = new ZoteroChatPlugin() as any;
    plugin.openTerminalInternal = vi.fn(() => startup);

    const first = plugin.openTerminal();
    const second = plugin.openTerminal();
    expect(plugin.openTerminalInternal).toHaveBeenCalledOnce();

    release();
    await Promise.all([first, second]);
    expect(plugin.terminalOpenPromise).toBeNull();
  });

  it("clears a failed lazy startup without creating an unhandled finally rejection", async () => {
    const plugin = new ZoteroChatPlugin() as any;
    plugin.openTerminalInternal = vi.fn(async () => { throw new Error("startup failed"); });

    await expect(plugin.openTerminal()).rejects.toThrow("startup failed");
    await Promise.resolve();

    expect(plugin.terminalOpenPromise).toBeNull();
  });

  it("captures context before the first terminal open can start the helper", async () => {
    const plugin = new ZoteroChatPlugin() as any;
    const host = document.createElement("div");
    const calls: string[] = [];
    plugin.terminal = {
      mount: vi.fn(() => calls.push("mount")),
      open: vi.fn(async () => { calls.push("open"); }),
    };
    plugin.refreshContext = vi.fn(async () => { calls.push("context"); });
    plugin.readerContext = {
      ensureZotkitLibrarySnapshot: vi.fn(async () => { calls.push("snapshot"); }),
    };
    plugin.terminalOptions = vi.fn(async () => {
      calls.push("options");
      return { host };
    });

    await plugin.openTerminalInternal(host);

    expect(calls).toEqual(["mount", "context", "snapshot", "options", "open"]);
  });

  it("invalidates Reader text caches and reloads every matching Reader after a PDF mutation", async () => {
    const originalZotero = (globalThis as any).Zotero;
    const matchingA = { itemID: 7, reload: vi.fn(async () => {}) };
    const matchingB = { itemID: 7, reload: vi.fn(async () => {}) };
    const unrelated = { itemID: 8, reload: vi.fn(async () => {}) };
    (globalThis as any).Zotero = {
      Reader: {
        _readers: [matchingA, unrelated, matchingB],
        getByTabID: vi.fn(() => matchingA),
      },
    };
    const plugin = new ZoteroChatPlugin() as any;
    plugin.readerContext = {
      invalidateAttachmentCaches: vi.fn(async () => {}),
      ensureZotkitLibrarySnapshot: vi.fn(async () => null),
    };
    plugin.selectedTabID = vi.fn(() => "reader-a");
    plugin.refreshContext = vi.fn(async () => {});
    plugin.refreshMutationCheckpoints = vi.fn(async () => {});

    try {
      await plugin.refreshAfterMutation({
        decision: "accepted",
        effects: {
          attachmentID: 7,
          attachmentKey: "ATTACH",
          attachmentLibraryID: 1,
          attachmentContentChanged: true,
          attachmentRelinked: false,
          pdfReplaced: true,
        },
      });

      expect(plugin.readerContext.invalidateAttachmentCaches).toHaveBeenCalledWith({
        key: "ATTACH",
        libraryID: 1,
      });
      expect(matchingA.reload).toHaveBeenCalledOnce();
      expect(matchingB.reload).toHaveBeenCalledOnce();
      expect(unrelated.reload).not.toHaveBeenCalled();
      expect(plugin.refreshContext).toHaveBeenCalledOnce();
    }
    finally {
      if (originalZotero === undefined) delete (globalThis as any).Zotero;
      else (globalThis as any).Zotero = originalZotero;
    }
  });

  it("mounts and switches the terminal on the selected Reader body across A to B to A", async () => {
    const originalZotero = (globalThis as any).Zotero;
    let selectedID = "reader-a";
    (globalThis as any).Zotero = {
      getMainWindow: () => ({ Zotero_Tabs: { selectedID } }),
    };

    const createReaderBody = (tabID: string): HTMLElement => {
      const details = document.createElement("item-details");
      details.setAttribute("data-tab-id", tabID);
      const section = document.createElement("collapsible-section");
      section.setAttribute("open", "");
      const body = document.createElement("div");
      section.append(body);
      details.append(section);
      document.body.append(details);
      return body;
    };

    const bodyA = createReaderBody("reader-a");
    const bodyB = createReaderBody("reader-b");
    const plugin = new ZoteroChatPlugin() as any;
    plugin.paneMode = "terminal";
    plugin.views = new Set([bodyB, bodyA]);
    plugin.context = { workspace: { root: "/profile/zotkit/a" } };
    plugin.terminal = {
      isOpen: true,
      hasLiveSessions: true,
      mount: vi.fn(),
      setVisible: vi.fn(),
      switchPaper: vi.fn(async () => {}),
    };
    plugin.terminalOptions = vi.fn(async (host: HTMLElement) => ({ host }));
    plugin.refreshContext = vi.fn(async (_pageChange: boolean, host: HTMLElement) => {
      await plugin.switchTerminalToContext(false, host);
    });

    try {
      for (const [tabID, body] of [
        ["reader-a", bodyA],
        ["reader-b", bodyB],
        ["reader-a", bodyA],
      ] as const) {
        selectedID = tabID;
        expect(plugin.activeSidebarBody()).toBe(body);
        await plugin.refreshSelectedReaderTab(tabID);
      }

      expect(plugin.terminal.mount.mock.calls.map(([host]: [HTMLElement]) => host))
        .toEqual([bodyA, bodyB, bodyA]);
      expect(plugin.terminal.switchPaper.mock.calls.map(([options]: [{ host: HTMLElement }]) => options.host))
        .toEqual([bodyA, bodyB, bodyA]);
    }
    finally {
      bodyA.closest("item-details")?.remove();
      bodyB.closest("item-details")?.remove();
      if (originalZotero === undefined) delete (globalThis as any).Zotero;
      else (globalThis as any).Zotero = originalZotero;
    }
  });

  it("restores a live Reader terminal after visiting the library tab", async () => {
    const originalZotero = (globalThis as any).Zotero;
    let selectedID = "reader-a";
    (globalThis as any).Zotero = {
      getMainWindow: () => ({ Zotero_Tabs: { selectedID } }),
    };
    const details = document.createElement("item-details");
    details.setAttribute("data-tab-id", "reader-a");
    const section = document.createElement("collapsible-section");
    section.setAttribute("open", "");
    const body = document.createElement("div");
    section.append(body);
    details.append(section);
    document.body.append(details);

    const plugin = new ZoteroChatPlugin() as any;
    plugin.paneMode = "terminal";
    plugin.views = new Set([body]);
    plugin.terminal = {
      isOpen: false,
      hasLiveSessions: true,
      mount: vi.fn(),
      setVisible: vi.fn(),
    };
    plugin.refreshContext = vi.fn(async () => {});

    try {
      selectedID = "zotero-pane";
      await plugin.refreshSelectedReaderTab("zotero-pane", false);
      expect(plugin.terminal.setVisible).toHaveBeenCalledWith(false);

      selectedID = "reader-a";
      await plugin.refreshSelectedReaderTab("reader-a", true);
      expect(plugin.terminal.mount).toHaveBeenCalledWith(body);
      expect(plugin.refreshContext).toHaveBeenCalledWith(false, body);
    }
    finally {
      details.remove();
      if (originalZotero === undefined) delete (globalThis as any).Zotero;
      else (globalThis as any).Zotero = originalZotero;
    }
  });

  it("drops an older tab switch when terminal options finish after a newer switch", async () => {
    const originalZotero = (globalThis as any).Zotero;
    let selectedID = "reader-b";
    (globalThis as any).Zotero = {
      getMainWindow: () => ({ Zotero_Tabs: { selectedID } }),
    };
    const makeBody = (tabID: string): HTMLElement => {
      const details = document.createElement("item-details");
      details.setAttribute("data-tab-id", tabID);
      const body = document.createElement("div");
      details.append(body);
      document.body.append(details);
      return body;
    };
    const bodyA = makeBody("reader-a");
    const bodyB = makeBody("reader-b");
    let releaseB!: (options: { host: HTMLElement; paperKey: string }) => void;
    const optionsB = new Promise<{ host: HTMLElement; paperKey: string }>((resolve) => {
      releaseB = resolve;
    });
    const plugin = new ZoteroChatPlugin() as any;
    plugin.destroyed = false;
    plugin.context = { workspace: { root: "/profile/zotkit" } };
    plugin.terminal = {
      hasLiveSessions: true,
      switchPaper: vi.fn(async () => {}),
    };
    plugin.readerContext = { ensureZotkitLibrarySnapshot: vi.fn(async () => {}) };
    plugin.terminalOptions = vi.fn((host: HTMLElement) => (
      host === bodyB ? optionsB : Promise.resolve({ host, paperKey: "A" })
    ));

    try {
      plugin.contextRequestSequence = 1;
      const stale = plugin.switchTerminalToContext(false, bodyB, 1);
      await Promise.resolve();

      selectedID = "reader-a";
      plugin.contextRequestSequence = 2;
      await plugin.switchTerminalToContext(false, bodyA, 2);
      releaseB({ host: bodyB, paperKey: "B" });
      await stale;

      expect(plugin.terminal.switchPaper).toHaveBeenCalledOnce();
      expect(plugin.terminal.switchPaper).toHaveBeenCalledWith(
        expect.objectContaining({ host: bodyA, paperKey: "A" }),
      );
    }
    finally {
      bodyA.closest("item-details")?.remove();
      bodyB.closest("item-details")?.remove();
      if (originalZotero === undefined) delete (globalThis as any).Zotero;
      else (globalThis as any).Zotero = originalZotero;
    }
  });

  it("does not let an older page refresh overwrite a newer Reader tab context", async () => {
    const originalZotero = (globalThis as any).Zotero;
    let selectedID = "reader-a";
    (globalThis as any).Zotero = {
      getMainWindow: () => ({ Zotero_Tabs: { selectedID } }),
    };
    const contextA = {
      attachment: { key: "A", libraryID: 1 },
      workspace: { root: "/profile/a" },
    };
    const contextB = {
      attachment: { key: "B", libraryID: 1 },
      workspace: { root: "/profile/b" },
    };
    let releasePageA!: (context: typeof contextA) => void;
    const pageA = new Promise<typeof contextA>((resolve) => { releasePageA = resolve; });
    const plugin = new ZoteroChatPlugin() as any;
    plugin.destroyed = false;
    plugin.terminal = { hasLiveSessions: false };
    plugin.readerContext = {
      refreshForPageChange: vi.fn(() => pageA),
      refresh: vi.fn(async () => contextB),
    };

    try {
      const stalePageRefresh = plugin.refreshContext(true);
      await Promise.resolve();
      selectedID = "reader-b";
      await plugin.refreshContext(false);
      releasePageA(contextA);
      await stalePageRefresh;

      expect(plugin.context).toBe(contextB);
      expect(plugin.context.attachment.key).toBe("B");
    }
    finally {
      if (originalZotero === undefined) delete (globalThis as any).Zotero;
      else (globalThis as any).Zotero = originalZotero;
    }
  });
});

describe("Reader context copied into the terminal", () => {
  it("uses the original PDF directory when the path is absolute", () => {
    expect(pdfDirectory("/Users/chance/Documents/papers/example.pdf"))
      .toBe("/Users/chance/Documents/papers");
    expect(pdfDirectory("relative/example.pdf")).toBeNull();
    expect(pdfDirectory(null)).toBeNull();
  });

  it("inserts metadata, page, path, and literal selection without submitting", () => {
    const context = {
      schemaVersion: 1,
      attachment: {
        id: 2,
        key: "PDFKEY",
        title: "Attachment",
        creators: [],
        tags: [],
      },
      parent: {
        id: 1,
        key: "ITEMKEY",
        title: "Quantum Control",
        creators: [{ firstName: "Ada", lastName: "Lovelace" }],
        year: "2026",
        doi: "10.1/example",
        tags: [],
      },
      pdfPath: "/Users/chance/Documents/papers/quantum.pdf",
      page: {
        pageIndex: 6,
        pageNumber: 7,
        text: "page",
        source: "pdfjs",
        warnings: [],
      },
      selection: {
        text: "first line\nsecond line\u001b[31m",
        pageNumber: 7,
        capturedAt: "2026-07-22T00:00:00Z",
      },
      fullText: { source: "deferred", characters: 0 },
      capturedAt: "2026-07-22T00:00:00Z",
      warnings: [],
    } as ReaderContext;

    const prompt = buildSelectionPrompt(context);
    expect(prompt).toContain("Quantum Control");
    expect(prompt).toContain("Ada Lovelace");
    expect(prompt).toContain("10.1/example");
    expect(prompt).toContain("/Users/chance/Documents/papers/quantum.pdf");
    expect(prompt).toContain("PDF 页：7");
    expect(prompt).toContain("first line second line [31m");
    expect(prompt).toMatch(/问题：$/);
    expect(prompt).not.toMatch(/[\r\n\u001b]/);
  });

  it("bounds a pasted selection while leaving the complete live MCP copy available", () => {
    const context = {
      schemaVersion: 1,
      attachment: { id: 2, key: "PDFKEY", creators: [], tags: [] },
      parent: null,
      pdfPath: "/papers/long.pdf",
      page: { pageIndex: 0, pageNumber: 1, text: "", source: "none", warnings: [] },
      selection: {
        text: "x".repeat(MAX_SELECTION_PROMPT_CHARACTERS + 500),
        pageNumber: 1,
        capturedAt: "2026-07-22T00:00:00Z",
      },
      fullText: { source: "deferred", characters: 0 },
      capturedAt: "2026-07-22T00:00:00Z",
      warnings: [],
    } as ReaderContext;

    const prompt = buildSelectionPrompt(context);
    expect(prompt).toContain("完整文本仍可通过 zotero_reader 获取");
    expect(prompt.length).toBeLessThan(MAX_SELECTION_PROMPT_CHARACTERS + 500);
  });

  describe("onTurnCompleted note sync", () => {
    beforeEach(() => vi.mocked(syncChatNote).mockClear());

    function pluginWithCompletedTurn() {
      const plugin = new ZoteroChatPlugin() as any;
      plugin.context = {
        attachment: { id: 7, key: "ATTACH", libraryID: 1, title: "paper.pdf", creators: [], tags: [] },
        parent: null,
      } as unknown as ReaderContext;
      plugin.codex = {
        state: { activeThreadId: "th1", running: false },
        getChatEntries: () => [
          { id: "u1", kind: "user", text: "问" },
          { id: "a1", kind: "assistant", text: "答", state: "complete" },
        ],
        getThreadOptions: () => [{ id: "th1", title: "主线程", active: true }],
      };
      return plugin;
    }

    it("syncs the completed turn into the note when noteSync is on", () => {
      const previousZotero = (globalThis as any).Zotero;
      (globalThis as any).Zotero = { Items: { get: () => null } };
      vi.stubGlobal("Services", { prefs: { getBoolPref: (_key: string, fallback: boolean) => fallback } });

      const plugin = pluginWithCompletedTurn();
      plugin.onTurnCompleted("th1");

      expect(syncChatNote).toHaveBeenCalledOnce();
      const call = vi.mocked(syncChatNote).mock.calls[0]![0];
      expect(call.paperTitle).toBe("paper.pdf");
      expect(call.section).toMatchObject({
        threadId: "th1",
        title: "主线程",
        exchanges: [{ question: "问", answerMarkdown: "答" }],
      });

      vi.unstubAllGlobals();
      (globalThis as any).Zotero = previousZotero;
    });

    it("does not sync when the noteSync pref is off", () => {
      vi.stubGlobal("Services", { prefs: { getBoolPref: () => false } });

      const plugin = pluginWithCompletedTurn();
      plugin.onTurnCompleted("th1");

      expect(syncChatNote).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it("does not sync when the completed turn produced no Q&A pairs", () => {
      const previousZotero = (globalThis as any).Zotero;
      (globalThis as any).Zotero = { Items: { get: () => null } };
      vi.stubGlobal("Services", { prefs: { getBoolPref: (_key: string, fallback: boolean) => fallback } });

      const plugin = pluginWithCompletedTurn();
      plugin.codex.getChatEntries = () => [];
      plugin.onTurnCompleted("th1");

      expect(syncChatNote).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
      (globalThis as any).Zotero = previousZotero;
    });

    it("does not throw when getThreadOptions throws; note-sync must never break chat", () => {
      const previousZotero = (globalThis as any).Zotero;
      const debug = vi.fn();
      (globalThis as any).Zotero = { Items: { get: () => null }, debug };
      vi.stubGlobal("Services", { prefs: { getBoolPref: (_key: string, fallback: boolean) => fallback } });

      const plugin = pluginWithCompletedTurn();
      plugin.codex.getThreadOptions = vi.fn(() => { throw new Error("thread options failed"); });

      expect(() => {
        plugin.onTurnCompleted("th1");
      }).not.toThrow();

      // M2: the catch block must actually log, not just claim to in a comment.
      expect(debug).toHaveBeenCalledOnce();
      expect(debug.mock.calls[0]?.[0]).toContain("thread options failed");

      vi.unstubAllGlobals();
      (globalThis as any).Zotero = previousZotero;
    });

    it("does not throw when Zotero.debug itself is unavailable (M2 must stay failure-proof)", () => {
      const previousZotero = (globalThis as any).Zotero;
      (globalThis as any).Zotero = { Items: { get: () => null } };
      vi.stubGlobal("Services", { prefs: { getBoolPref: (_key: string, fallback: boolean) => fallback } });

      const plugin = pluginWithCompletedTurn();
      plugin.codex.getThreadOptions = vi.fn(() => { throw new Error("thread options failed"); });

      expect(() => {
        plugin.onTurnCompleted("th1");
      }).not.toThrow();

      vi.unstubAllGlobals();
      (globalThis as any).Zotero = previousZotero;
    });
  });
});
