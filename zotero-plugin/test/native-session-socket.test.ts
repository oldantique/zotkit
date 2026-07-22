import { describe, expect, it, vi } from "vitest";

import type { BridgeEvent } from "../src/native-bridge";
import { NativeSessionSocket } from "../src/native-session-socket";

class MockBridge {
  readonly inputs: Array<{ sessionId: string; data: string }> = [];
  readonly closed: string[] = [];
  private readonly listeners = new Set<(event: BridgeEvent) => void>();

  onEvent(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  input(sessionId: string, data: string): void {
    this.inputs.push({ sessionId, data });
  }

  closeSession(sessionId: string): void {
    this.closed.push(sessionId);
  }

  emit(event: BridgeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function encoded(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

describe("NativeSessionSocket", () => {
  it("frames JSONL over one authenticated pipe session and preserves split UTF-8", async () => {
    const bridge = new MockBridge();
    const socket = new NativeSessionSocket(bridge as any, "appserver-1");
    const opened = vi.fn();
    const messages = vi.fn();
    const closed = vi.fn();
    socket.addEventListener("open", opened);
    socket.addEventListener("message", messages);
    socket.addEventListener("close", closed);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(1);

    socket.send('{"id":1,"method":"initialize"}');
    expect(bridge.inputs).toEqual([{
      sessionId: "appserver-1",
      data: '{"id":1,"method":"initialize"}\n'
    }]);

    const bytes = new TextEncoder().encode('{"result":"中文"}\n');
    const split = bytes.indexOf(0xe6) + 1;
    bridge.emit({
      type: "output",
      sessionId: "appserver-1",
      encoding: "base64",
      data: encoded(bytes.slice(0, split))
    });
    bridge.emit({
      type: "output",
      sessionId: "appserver-1",
      encoding: "base64",
      data: encoded(bytes.slice(split))
    });
    expect(messages).toHaveBeenCalledWith({ data: '{"result":"中文"}' });

    bridge.emit({
      type: "exit",
      sessionId: "appserver-1",
      exitCode: 0,
      signal: null
    });
    expect(socket.readyState).toBe(3);
    expect(closed).toHaveBeenCalledWith({ code: 1000, reason: "Codex app-server exited" });
  });

  it("closes only its own helper session", async () => {
    const bridge = new MockBridge();
    const socket = new NativeSessionSocket(bridge as any, "appserver-2");
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.close(1000, "done");
    socket.close(1000, "again");
    expect(bridge.closed).toEqual(["appserver-2"]);
  });
});
