import { afterEach, describe, expect, it, vi } from "vitest";
import { binaryDigestToHex, sha256Bytes } from "../src/hashing";

afterEach(() => vi.unstubAllGlobals());

describe("hashing", () => {
  it("converts a binary digest to lowercase hex", () => {
    expect(binaryDigestToHex("\x00\xab\xff")).toBe("00abff");
  });

  it("drives nsICryptoHash for byte hashing", () => {
    const calls: string[] = [];
    const fakeHash = {
      SHA256: 4,
      init(algorithm: number) { calls.push(`init:${algorithm}`); },
      update(_bytes: Uint8Array, length: number) { calls.push(`update:${length}`); },
      finish(_b64: boolean) { calls.push("finish"); return "\x01\x02"; },
    };
    vi.stubGlobal("Components", {
      classes: { "@mozilla.org/security/hash;1": { createInstance: () => fakeHash } },
      interfaces: { nsICryptoHash: fakeHash },
    });
    expect(sha256Bytes(new Uint8Array([9, 9, 9]))).toBe("0102");
    expect(calls).toEqual(["init:4", "update:3", "finish"]);
  });
});
