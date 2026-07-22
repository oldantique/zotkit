import {
  debug,
  makeLocalFile,
  profilePath,
  randomID,
  sleep
} from "./platform";

export interface SpawnOptions {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  rows?: number;
  cols?: number;
}

export type BridgeEvent =
  | { type: "spawned"; sessionId: string; pid: number }
  | { type: "output"; sessionId: string; encoding: "base64"; data: string }
  | { type: "closing"; sessionId: string }
  | { type: "exit"; sessionId: string; exitCode: number | null; signal: number | null }
  | { type: "error"; message: string }
  | { type: "pong" };

type BridgeListener = (event: BridgeEvent) => void;

export const NATIVE_INPUT_CHUNK_BYTES = 16 * 1024;

export function encodeTerminalInputChunks(data: string): string[] {
  const bytes = new TextEncoder().encode(data);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += NATIVE_INPUT_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + NATIVE_INPUT_CHUNK_BYTES);
    let binary = "";
    for (const value of chunk) binary += String.fromCharCode(value);
    chunks.push(btoa(binary));
  }
  return chunks;
}

export class NativeBridge {
  private process: any | null = null;
  private socket: WebSocket | null = null;
  private connectingSocket: WebSocket | null = null;
  private port = 0;
  private token = "";
  private helperPathValue = "";
  private zotkitPathValue = "";
  private stopping = false;
  private lifecycle = 0;
  private startPromise: Promise<void> | null = null;
  private listeners = new Set<BridgeListener>();
  private outputDecoders = new Map<string, TextDecoder>();
  private pendingSpawns = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private readonly bundledRootURI: string,
    private readonly version: string
  ) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get helperPath(): string {
    if (!this.helperPathValue) throw new Error("Native helper has not been installed yet");
    return this.helperPathValue;
  }

  /** The same verified bundled binary exposed under a user-facing read-only CLI name. */
  get zotkitPath(): string {
    if (!this.zotkitPathValue) throw new Error("Built-in Zotkit CLI has not been installed yet");
    return this.zotkitPathValue;
  }

  onEvent(listener: BridgeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    const lifecycle = ++this.lifecycle;
    this.startPromise = this.startInternal(lifecycle).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startInternal(lifecycle: number): Promise<void> {
    if (this.socket) {
      try { this.socket.close(1000, "helper restart"); }
      catch { /* stale socket */ }
      this.socket = null;
    }
    this.killProcess();
    const { helperPath, zotkitPath } = await this.installHelper();
    this.assertStarting(lifecycle);
    this.helperPathValue = helperPath;
    this.zotkitPathValue = zotkitPath;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      this.assertStarting(lifecycle);
      this.port = 32000 + Math.floor(Math.random() * 24000);
      this.token = `${randomID("token")}${randomID("")}`;
      const tokenPath = await this.createTokenFile(this.token);
      try {
        this.launchProcess(helperPath, ["--port", String(this.port), "--token-file", tokenPath]);
        await this.waitForHealth(lifecycle);
        await this.openSocket(lifecycle);
        this.assertStarting(lifecycle);
        this.token = "";
        debug("Native helper ready", { port: this.port });
        return;
      }
      catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        try { await IOUtils.remove(tokenPath, { ignoreAbsent: true }); }
        catch { /* helper may already have consumed it */ }
        this.killProcess();
        this.assertStarting(lifecycle);
        await sleep(25);
      }
    }
    throw lastError || new Error("Could not start the Zotkit Reader helper");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.lifecycle += 1;
    for (const [sessionId] of this.pendingSpawns) {
      this.rejectSpawn(sessionId, new Error("Native helper stopped"));
    }
    if (this.socket) {
      try { this.socket.close(1000, "plugin shutdown"); }
      catch { /* already closed */ }
      this.socket = null;
    }
    if (this.connectingSocket) {
      try { this.connectingSocket.close(1000, "plugin shutdown"); }
      catch { /* connection is already closing */ }
      this.connectingSocket = null;
    }
    this.killProcess();
    const pendingStart = this.startPromise;
    if (pendingStart) await pendingStart.catch(() => {});
    this.killProcess();
    this.outputDecoders.clear();
    this.listeners.clear();
  }

  async spawn(sessionId: string, options: SpawnOptions): Promise<void> {
    return this.spawnWithType("spawn", sessionId, options);
  }

  async spawnPipe(sessionId: string, options: SpawnOptions): Promise<void> {
    return this.spawnWithType("spawnPipe", sessionId, options);
  }

  private async spawnWithType(
    type: "spawn" | "spawnPipe",
    sessionId: string,
    options: SpawnOptions
  ): Promise<void> {
    this.requireSocket();
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(sessionId)) {
      throw new Error("Invalid terminal session id");
    }
    if (!options.argv.length || !options.argv[0]?.startsWith("/")) {
      throw new Error("Terminal command must use an absolute executable path");
    }
    this.outputDecoders.set(sessionId, new TextDecoder());
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSpawns.delete(sessionId);
        this.outputDecoders.delete(sessionId);
        reject(new Error("Timed out while starting the local process"));
      }, 10_000);
      this.pendingSpawns.set(sessionId, { resolve, reject, timer });
    });
    try {
      this.send({
        type,
        sessionId,
        argv: options.argv,
        cwd: options.cwd,
        env: options.env || {},
        rows: options.rows || 24,
        cols: options.cols || 90
      });
    }
    catch (error) {
      this.rejectSpawn(
        sessionId,
        error instanceof Error ? error : new Error(String(error))
      );
    }
    return promise;
  }

  input(sessionId: string, data: string): void {
    for (const chunk of encodeTerminalInputChunks(data)) {
      this.send({ type: "input", sessionId, encoding: "base64", data: chunk });
    }
  }

  resize(sessionId: string, rows: number, cols: number): void {
    this.send({
      type: "resize",
      sessionId,
      rows: Math.max(2, Math.min(500, Math.round(rows))),
      cols: Math.max(2, Math.min(500, Math.round(cols)))
    });
  }

  closeSession(sessionId: string): void {
    if (this.connected) this.send({ type: "close", sessionId });
  }

  decodeOutput(sessionId: string, data: string): string {
    const binary = atob(data);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    let decoder = this.outputDecoders.get(sessionId);
    if (!decoder) {
      decoder = new TextDecoder();
      this.outputDecoders.set(sessionId, decoder);
    }
    return decoder.decode(bytes, { stream: true });
  }

  flushOutput(sessionId: string): string {
    const decoder = this.outputDecoders.get(sessionId);
    this.outputDecoders.delete(sessionId);
    return decoder?.decode() || "";
  }

  private async installHelper(): Promise<{ helperPath: string; zotkitPath: string }> {
    const directory = profilePath("bin", this.version);
    const helperPath = PathUtils.join(directory, "zoterochat-helper");
    const zotkitPath = PathUtils.join(directory, "zotkit");
    await IOUtils.makeDirectory(directory, {
      createAncestors: true,
      ignoreExisting: true,
      permissions: 0o700
    });
    const bytes = await this.readBundledHelper();
    for (const target of [helperPath, zotkitPath]) {
      await IOUtils.write(target, bytes, { tmpPath: target + ".tmp" });
      const chmod = Components.classes["@mozilla.org/process/util;1"]
        .createInstance(Components.interfaces.nsIProcess);
      chmod.init(makeLocalFile("/bin/chmod"));
      chmod.run(true, ["0700", target], 2);
    }
    return { helperPath, zotkitPath };
  }

  private async createTokenFile(token: string): Promise<string> {
    const directory = profilePath("runtime");
    await IOUtils.makeDirectory(directory, {
      createAncestors: true,
      ignoreExisting: true,
      permissions: 0o700
    });
    const path = PathUtils.join(directory, `${randomID("helper-token")}.secret`);
    await IOUtils.writeUTF8(path, token + "\n", { tmpPath: path + ".tmp" });
    const chmod = Components.classes["@mozilla.org/process/util;1"]
      .createInstance(Components.interfaces.nsIProcess);
    chmod.init(makeLocalFile("/bin/chmod"));
    chmod.run(true, ["0600", path], 2);
    return path;
  }

  private async readBundledHelper(): Promise<Uint8Array> {
    const uri = this.bundledRootURI + "native/zoterochat-helper";
    try {
      const response = await fetch(uri);
      if (response.ok || response.status === 0) {
        return new Uint8Array(await response.arrayBuffer());
      }
    }
    catch { /* jar: fetch is unavailable on some Zotero builds */ }

    return new Promise<Uint8Array>((resolve, reject) => {
      try {
        const channel = NetUtil.newChannel({
          uri: Services.io.newURI(uri),
          loadUsingSystemPrincipal: true
        });
        NetUtil.asyncFetch(channel, (stream: any, status: number) => {
          if (!Components.isSuccessCode(status)) {
            reject(new Error(`Could not read bundled helper (${status})`));
            return;
          }
          try {
            const binary = Components.classes["@mozilla.org/binaryinputstream;1"]
              .createInstance(Components.interfaces.nsIBinaryInputStream);
            binary.setInputStream(stream);
            resolve(Uint8Array.from(binary.readByteArray(binary.available())));
          }
          catch (error) {
            reject(error);
          }
        });
      }
      catch (error) {
        reject(error);
      }
    });
  }

  private launchProcess(executable: string, args: string[]): void {
    const process = Components.classes["@mozilla.org/process/util;1"]
      .createInstance(Components.interfaces.nsIProcess);
    process.init(makeLocalFile(executable));
    this.process = process;
    process.runAsync(args, args.length, {
      observe: (_subject: unknown, topic: string) => {
        if (!this.stopping && topic === "process-finished") {
          debug("Native helper exited");
        }
      }
    }, false);
  }

  private killProcess(): void {
    if (!this.process) return;
    try {
      if (this.process.isRunning) this.process.kill();
    }
    catch { /* process already exited */ }
    this.process = null;
  }

  private async waitForHealth(lifecycle: number): Promise<void> {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      this.assertStarting(lifecycle);
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`, {
          headers: { Authorization: `Bearer ${this.token}` },
          cache: "no-store"
        });
        if (response.ok) return;
      }
      catch { /* daemon is still starting */ }
      await sleep(40);
    }
    throw new Error("Native helper did not become ready");
  }

  private openSocket(lifecycle: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${this.port}/ws?token=${encodeURIComponent(this.token)}`
      );
      this.connectingSocket = socket;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.connectingSocket === socket) this.connectingSocket = null;
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        try { socket.close(); }
        catch { /* ignored */ }
        finish(new Error("Timed out while connecting to native helper"));
      }, 5000);
      socket.addEventListener("open", () => {
        if (this.stopping || lifecycle !== this.lifecycle) {
          try { socket.close(1000, "start cancelled"); }
          catch { /* ignored */ }
          finish(new Error("Native helper start was cancelled"));
          return;
        }
        this.socket = socket;
        finish();
      }, { once: true });
      socket.addEventListener("error", () => {
        finish(new Error("Could not connect to native helper"));
      }, { once: true });
      socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
      socket.addEventListener("close", () => {
        if (this.socket === socket) this.socket = null;
        if (!settled) finish(new Error("Native helper connection closed during startup"));
      });
    });
  }

  private assertStarting(lifecycle: number): void {
    if (this.stopping || lifecycle !== this.lifecycle) {
      throw new Error("Native helper start was cancelled");
    }
  }

  private onMessage(data: string): void {
    let event: BridgeEvent;
    try {
      event = JSON.parse(data) as BridgeEvent;
    }
    catch {
      return;
    }
    if (event.type === "spawned") {
      const pending = this.pendingSpawns.get(event.sessionId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingSpawns.delete(event.sessionId);
        pending.resolve();
      }
    }
    else if (event.type === "error") {
      for (const sessionId of this.pendingSpawns.keys()) {
        this.rejectSpawn(sessionId, new Error(event.message));
      }
    }
    for (const listener of this.listeners) listener(event);
    if (event.type === "exit") this.outputDecoders.delete(event.sessionId);
  }

  private rejectSpawn(sessionId: string, error: Error): void {
    const pending = this.pendingSpawns.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSpawns.delete(sessionId);
    this.outputDecoders.delete(sessionId);
    pending.reject(error);
  }

  private requireSocket(): WebSocket {
    if (!this.connected || !this.socket) throw new Error("Native helper is not connected");
    return this.socket;
  }

  private send(value: unknown): void {
    this.requireSocket().send(JSON.stringify(value));
  }
}
