import { describe, expect, it } from "vitest";

import {
  NATIVE_INPUT_CHUNK_BYTES,
  NativeBridge,
  encodeTerminalInputChunks,
} from "../src/native-bridge";

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

describe("NativeBridge terminal decoding", () => {
  it("preserves a UTF-8 character split across WebSocket output frames", () => {
    const bridge = new NativeBridge("file:///unused/", "test");
    const bytes = new TextEncoder().encode("A你B");

    expect(bridge.decodeOutput("paper-a", base64(bytes.slice(0, 2)))).toBe("A");
    expect(bridge.decodeOutput("paper-a", base64(bytes.slice(2)))).toBe("你B");
    expect(bridge.flushOutput("paper-a")).toBe("");
  });

  it("keeps decoder state isolated between terminal sessions", () => {
    const bridge = new NativeBridge("file:///unused/", "test");
    const chinese = new TextEncoder().encode("文");

    expect(bridge.decodeOutput("paper-a", base64(chinese.slice(0, 1)))).toBe("");
    expect(bridge.decodeOutput("paper-b", base64(new TextEncoder().encode("ok")))).toBe("ok");
    expect(bridge.decodeOutput("paper-a", base64(chinese.slice(1)))).toBe("文");
  });
});

describe("NativeBridge terminal input framing", () => {
  it("splits large multibyte input below the helper frame limit without losing bytes", () => {
    const value = `prefix-${"选".repeat(32_000)}-suffix`;
    const expected = new TextEncoder().encode(value);
    const chunks = encodeTerminalInputChunks(value);
    const decoded = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, "base64")));

    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => Buffer.from(chunk, "base64").length)))
      .toBeLessThanOrEqual(NATIVE_INPUT_CHUNK_BYTES);
    expect(decoded).toEqual(Buffer.from(expected));
  });
});
