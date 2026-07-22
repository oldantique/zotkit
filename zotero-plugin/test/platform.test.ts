import { afterEach, describe, expect, it, vi } from "vitest";
import { homePath } from "../src/platform";

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
