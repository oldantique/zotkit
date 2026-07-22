import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  NATIVE_INPUT_CHUNK_BYTES,
  NativeBridge,
  ServerWebSocketFrameDecoder,
  UnixWebSocket,
  encodeClientWebSocketFrame,
  encodeTerminalInputChunks,
  nativeWebSocketUpgradeRequest,
  validateNativeWebSocketUpgrade,
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

describe("NativeBridge helper lifecycle", () => {
  it("reports established sessions as exited when the helper dies", () => {
    const bridge = new NativeBridge("file:///unused/", "test") as any;
    const socket = {};
    const events: any[] = [];
    bridge.socket = socket;
    bridge.outputDecoders.set("paper-a", new TextDecoder());
    bridge.outputDecoders.set("paper-b", new TextDecoder());
    bridge.onEvent((event: any) => events.push(event));

    bridge.handleSocketClosed(socket);

    expect(events.slice(0, 2)).toEqual([
      { type: "exit", sessionId: "paper-a", exitCode: null, signal: null },
      { type: "exit", sessionId: "paper-b", exitCode: null, signal: null },
    ]);
    expect(events[2]).toEqual({ type: "error", message: "Native helper disconnected" });
    expect(bridge.outputDecoders.size).toBe(0);
  });

  it("rejects only the pending spawn named by a session error", () => {
    const bridge = new NativeBridge("file:///unused/", "test") as any;
    const rejected: string[] = [];
    const timerA = setTimeout(() => {}, 10_000);
    const timerB = setTimeout(() => {}, 10_000);
    bridge.pendingSpawns.set("paper-a", {
      resolve() {},
      reject() { rejected.push("paper-a"); },
      timer: timerA,
    });
    bridge.pendingSpawns.set("paper-b", {
      resolve() {},
      reject() { rejected.push("paper-b"); },
      timer: timerB,
    });

    bridge.onMessage(JSON.stringify({
      type: "error",
      sessionId: "paper-a",
      message: "invalid spawn",
    }));

    expect(rejected).toEqual(["paper-a"]);
    expect(bridge.pendingSpawns.has("paper-a")).toBe(false);
    expect(bridge.pendingSpawns.has("paper-b")).toBe(true);
    clearTimeout(timerB);
  });

  it("requests authenticated shutdown and waits before closing the socket", async () => {
    const bridge = new NativeBridge("file:///unused/", "test") as any;
    const order: string[] = [];
    let running = true;
    const process = {
      get isRunning() { return running; },
      kill() { order.push("kill"); running = false; },
    };
    const socket = {
      readyState: 1,
      send(value: string) {
        order.push(`send:${value}`);
        setTimeout(() => { running = false; }, 20);
      },
      close() {
        order.push("close");
        this.readyState = 3;
      },
    };
    bridge.process = process;
    bridge.processExited = false;
    bridge.socket = socket;

    await bridge.stop();

    expect(order[0]).toBe('send:{"type":"shutdown"}');
    expect(order).toContain("close");
    expect(order).not.toContain("kill");
    expect(order.indexOf("close")).toBeGreaterThan(0);
  });
});

describe("NativeBridge Unix WebSocket framing", () => {
  it("fails closed against a pre-bound squatter without writing the token", () => {
    const globals = globalThis as any;
    const previousComponents = globals.Components;
    const previousChromeUtils = globals.ChromeUtils;
    let listener: any;
    let written = "";
    let binarySource: any;
    class MockHash {
      readonly SHA1 = 1;
      private chunks: Buffer[] = [];
      init(): void { this.chunks = []; }
      update(value: Uint8Array, length: number): void {
        this.chunks.push(Buffer.from(value.slice(0, length)));
      }
      finish(base64Output: boolean): string {
        const digest = createHash("sha1").update(Buffer.concat(this.chunks)).digest();
        return base64Output ? digest.toString("base64") : digest.toString("latin1");
      }
    }
    try {
      globals.ChromeUtils = { generateQI: () => () => ({}) };
      globals.Components = {
        interfaces: {
          nsIRandomGenerator: {},
          nsICryptoHash: {},
          nsISocketTransportService: {},
          nsIInputStreamPump: {},
          nsIBinaryInputStream: {},
          nsIFile: {},
        },
        results: { NS_OK: 0 },
        isSuccessCode: (status: number) => status === 0,
        classes: {
          "@mozilla.org/security/random-generator;1": {
            getService: () => ({ generateRandomBytes: (length: number) => Array(length).fill(7) }),
          },
          "@mozilla.org/security/hash;1": {
            createInstance: () => new MockHash(),
          },
          "@mozilla.org/file/local;1": {
            createInstance: () => ({ path: "", initWithPath(path: string) { this.path = path; } }),
          },
          "@mozilla.org/network/socket-transport-service;1": {
            getService: () => ({
              createUnixDomainTransport: () => ({
                openOutputStream: () => ({
                  write(value: string, length: number) {
                    written += value.slice(0, length);
                    return length;
                  },
                  flush() {},
                  close() {},
                }),
                openInputStream: () => ({ close() {} }),
                close() {},
              }),
            }),
          },
          "@mozilla.org/network/input-stream-pump;1": {
            createInstance: () => ({
              init() {},
              asyncRead(value: any) { listener = value; },
            }),
          },
          "@mozilla.org/binaryinputstream;1": {
            createInstance: () => ({
              setInputStream(value: any) { binarySource = value; },
              readByteArray(length: number) { return [...binarySource.bytes.slice(0, length)]; },
            }),
          },
        },
      };

      const token = "squatter-must-never-see-this-token";
      const socket = new UnixWebSocket("/private/profile/run/prebound.sock", token);
      const errors: unknown[] = [];
      socket.addEventListener("error", (event) => errors.push(event.error));
      listener.onStartRequest();

      expect(written).not.toContain(token);
      expect(written).not.toContain("X-ZoteroChat-Token");
      const key = /Sec-WebSocket-Key: ([^\r\n]+)/.exec(written)?.[1];
      expect(key).toBeTruthy();
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      const spoof = new TextEncoder().encode(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      listener.onDataAvailable({}, { bytes: spoof }, 0, spoof.length);

      expect(errors).toHaveLength(1);
      expect(socket.readyState).toBe(3);
    }
    finally {
      if (previousComponents === undefined) delete globals.Components;
      else globals.Components = previousComponents;
      if (previousChromeUtils === undefined) delete globals.ChromeUtils;
      else globals.ChromeUtils = previousChromeUtils;
    }
  });

  it("does not disclose the token to a socket squatter and rejects its spoofed upgrade", () => {
    const token = "one-time-native-token-that-must-stay-secret";
    const request = nativeWebSocketUpgradeRequest(
      "random-websocket-key",
      "opaque-client-hmac",
    );

    expect(request).not.toContain(token);
    expect(request).not.toContain("X-ZoteroChat-Token");
    expect(request).not.toContain("?token=");
    const squatterResponse =
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: expected-accept\r\n\r\n";
    expect(() => validateNativeWebSocketUpgrade(
      squatterResponse,
      "expected-accept",
      "unforgeable-server-hmac",
    )).toThrow(/authenticated handshake/);
  });

  it("accepts an upgrade only when both WebSocket and server proofs match", () => {
    const response =
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: keep-alive, Upgrade\r\n" +
      "Sec-WebSocket-Accept: expected-accept\r\n" +
      "X-Zotkit-Server-Proof: expected-proof\r\n\r\n";
    expect(() => validateNativeWebSocketUpgrade(
      response,
      "expected-accept",
      "expected-proof",
    )).not.toThrow();
  });

  it("masks every client frame and preserves its UTF-8 payload", () => {
    const payload = new TextEncoder().encode("读论文");
    const mask = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
    const frame = encodeClientWebSocketFrame(1, payload, mask);

    expect(frame[0]).toBe(0x81);
    expect(frame[1]! & 0x80).toBe(0x80);
    const offset = 6;
    const decoded = frame.slice(offset).map((byte, index) => byte ^ mask[index & 3]!);
    expect(decoded).toEqual(payload);
  });

  it("decodes coalesced and split unmasked server frames", () => {
    const small = new TextEncoder().encode('{"type":"pong"}');
    const large = new TextEncoder().encode("x".repeat(130));
    const first = Uint8Array.from([0x81, small.length, ...small]);
    const second = Uint8Array.from([
      0x81,
      126,
      large.length >>> 8,
      large.length,
      ...large,
    ]);
    const combined = Uint8Array.from([...first, ...second]);
    const decoder = new ServerWebSocketFrameDecoder();

    expect(decoder.push(combined.slice(0, first.length + 3))).toEqual([
      { opcode: 1, payload: small },
    ]);
    expect(decoder.push(combined.slice(first.length + 3))).toEqual([
      { opcode: 1, payload: large },
    ]);
  });

  it("rejects masked server frames and non-canonical lengths", () => {
    const decoder = new ServerWebSocketFrameDecoder();
    expect(() => decoder.push(Uint8Array.from([0x81, 0x80, 0, 0, 0, 0])))
      .toThrow(/must not be masked/);

    const nonCanonical = new ServerWebSocketFrameDecoder();
    expect(() => nonCanonical.push(Uint8Array.from([0x81, 126, 0, 1, 0x61])))
      .toThrow(/Non-canonical/);
  });
});
