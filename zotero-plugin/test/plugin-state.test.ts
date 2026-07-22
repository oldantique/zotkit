// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import {
  MAX_SELECTION_PROMPT_CHARACTERS,
  ZoteroChatPlugin,
  buildSelectionPrompt,
  pdfDirectory,
} from "../src/plugin";
import type { ReaderContext } from "../src/reader-context";

describe("Zotkit Reader terminal state", () => {
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
});
