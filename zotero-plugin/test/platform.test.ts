import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard, homePath } from "../src/platform";

describe("platform paths", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves the home directory through Gecko's directory service", () => {
    const nsIFile = Symbol("nsIFile");
    const get = vi.fn(() => ({ path: "/Users/researcher" }));
    vi.stubGlobal("Services", { dirsvc: { get } });
    vi.stubGlobal("Components", { interfaces: { nsIFile } });
    vi.stubGlobal("PathUtils", { join: (...parts: string[]) => parts.join("/") });

    expect(homePath("Documents", "papers")).toBe("/Users/researcher/Documents/papers");
    expect(get).toHaveBeenCalledWith("Home", nsIFile);
  });
});

describe("copyToClipboard", () => {
  afterEach(() => {
    delete (globalThis as any).Components;
    vi.unstubAllGlobals();
  });

  it("copies via nsIClipboardHelper and falls back to navigator.clipboard", () => {
    const copyString = vi.fn();
    (globalThis as any).Components = {
      classes: { "@mozilla.org/widget/clipboardhelper;1": { getService: () => ({ copyString }) } },
      interfaces: { nsIClipboardHelper: {} },
    };
    expect(copyToClipboard("hello")).toBe(true);
    expect(copyString).toHaveBeenCalledWith("hello");
    delete (globalThis as any).Components;
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(copyToClipboard("world")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("world");
    vi.unstubAllGlobals();
  });

  it("returns false when neither the privileged helper nor navigator.clipboard is available", () => {
    vi.stubGlobal("navigator", {});
    expect(copyToClipboard("nowhere")).toBe(false);
  });
});
