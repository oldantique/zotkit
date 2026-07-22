import type { BridgeEvent, NativeBridge } from "./native-bridge";
import type { WebSocketLike } from "./protocol";

type Listener = (event: any) => void;

/**
 * Adapts one authenticated helper pipe session to the WebSocket-like transport
 * expected by the Codex app-server client. No Codex listener is exposed on a
 * TCP port: app-server stays on stdio behind the helper's authenticated socket.
 */
export class NativeSessionSocket implements WebSocketLike {
  readyState = 0;

  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly decoder = new TextDecoder();
  private buffered = "";
  private unsubscribe: (() => void) | null;

  constructor(
    private readonly bridge: Pick<NativeBridge, "onEvent" | "input" | "closeSession">,
    private readonly sessionId: string
  ) {
    this.unsubscribe = bridge.onEvent((event) => this.onBridgeEvent(event));
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.dispatch("open", {});
    }, 0);
  }

  addEventListener(type: string, listener: Listener): void {
    let values = this.listeners.get(type);
    if (!values) {
      values = new Set();
      this.listeners.set(type, values);
    }
    values.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("Codex stdio transport is not open");
    const value = String(data);
    this.bridge.input(this.sessionId, value.endsWith("\n") ? value : value + "\n");
  }

  close(code = 1000, reason = "Client closed"): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.bridge.closeSession(this.sessionId);
    this.finish(code, reason);
  }

  private onBridgeEvent(event: BridgeEvent): void {
    if (event.type === "error") {
      this.dispatch("error", { message: event.message });
      return;
    }
    if (!("sessionId" in event) || event.sessionId !== this.sessionId) return;
    if (event.type === "output") {
      try {
        const binary = atob(event.data);
        const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
        this.buffered += this.decoder.decode(bytes, { stream: true });
        this.drainLines();
        if (this.buffered.length > 8 * 1024 * 1024) {
          this.dispatch("error", { message: "Codex app-server emitted an oversized JSONL frame" });
          this.close(1009, "JSONL frame too large");
        }
      }
      catch (error) {
        this.dispatch("error", error);
        this.close(1007, "Invalid app-server output");
      }
    }
    else if (event.type === "exit") {
      this.buffered += this.decoder.decode();
      this.drainLines();
      this.finish(event.exitCode === 0 ? 1000 : 1011,
        event.exitCode === 0 ? "Codex app-server exited" : "Codex app-server failed");
    }
  }

  private drainLines(): void {
    while (true) {
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) return;
      let line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) this.dispatch("message", { data: line });
    }
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.dispatch("close", { code, reason });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      try { listener(event); }
      catch { /* one transport listener must not break the others */ }
    }
  }
}
