import { afterEach, describe, expect, it, vi } from "vitest";
import { binaryDigestToHex, sha256Bytes, sha256File } from "../src/hashing";

afterEach(() => vi.unstubAllGlobals());

/**
 * Stubs the three XPCOM components `sha256File` drives:
 * "@mozilla.org/file/local;1" (via the private `makeLocalFile`),
 * "@mozilla.org/network/file-input-stream;1", and
 * "@mozilla.org/security/hash;1". Returns the ordered `calls` log plus the
 * fake stream/file instances so tests can assert identity (e.g. that the
 * stream was init'd with the exact file `makeLocalFile` produced).
 */
function stubFileHashingComponents(options: { finishThrows?: boolean } = {}) {
  const calls: string[] = [];
  const fakeFile = {
    initWithPath(path: string) { calls.push(`file.initWithPath:${path}`); },
  };
  const fakeStream = {
    init(file: unknown, flags: number, mode: number, behaviorFlags: number) {
      calls.push(`stream.init:${file === fakeFile}:${flags}:${mode}:${behaviorFlags}`);
    },
    close() { calls.push("stream.close"); },
  };
  const fakeHash = {
    SHA256: 4,
    init(algorithm: number) { calls.push(`hash.init:${algorithm}`); },
    updateFromStream(stream: unknown, size: number) {
      calls.push(`updateFromStream:${stream === fakeStream}:${size}`);
    },
    finish(_b64: boolean) {
      calls.push("finish");
      if (options.finishThrows) throw new Error("finish blew up");
      return "\x01\x02";
    },
  };
  vi.stubGlobal("Components", {
    classes: {
      "@mozilla.org/file/local;1": { createInstance: () => fakeFile },
      "@mozilla.org/network/file-input-stream;1": { createInstance: () => fakeStream },
      "@mozilla.org/security/hash;1": { createInstance: () => fakeHash },
    },
    interfaces: { nsIFile: {}, nsIFileInputStream: {}, nsICryptoHash: fakeHash },
  });
  return calls;
}

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

  it("drives nsIFileInputStream + nsICryptoHash for file hashing, via the private makeLocalFile path", () => {
    const calls = stubFileHashingComponents();
    expect(sha256File("/papers/paper.pdf", 128)).toBe("0102");
    expect(calls).toEqual([
      "file.initWithPath:/papers/paper.pdf",
      "stream.init:true:1:0:0",
      "hash.init:4",
      "updateFromStream:true:128",
      "finish",
      "stream.close",
    ]);
  });

  it("still closes the input stream when finish() throws (try/finally contract)", () => {
    const calls = stubFileHashingComponents({ finishThrows: true });
    expect(() => sha256File("/papers/paper.pdf", 128)).toThrow("finish blew up");
    expect(calls).toEqual([
      "file.initWithPath:/papers/paper.pdf",
      "stream.init:true:1:0:0",
      "hash.init:4",
      "updateFromStream:true:128",
      "finish",
      "stream.close",
    ]);
  });
});
