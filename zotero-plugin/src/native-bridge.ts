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
  | { type: "error"; sessionId?: string; message: string }
  | { type: "shutdownAck" }
  | { type: "pong" };

type BridgeListener = (event: BridgeEvent) => void;

export const NATIVE_INPUT_CHUNK_BYTES = 16 * 1024;
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;
const MAX_NATIVE_WEBSOCKET_MESSAGE = 1024 * 1024;
const MAX_NATIVE_HANDSHAKE = 16 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HELPER_GRACEFUL_SHUTDOWN_MS = 1800;
const HELPER_KILL_WAIT_MS = 250;

type SocketEventType = "open" | "message" | "error" | "close";
type SocketListener = (event: any) => void;

function joinBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (!left.length) return right.slice();
  if (!right.length) return left;
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

function websocketRandomBytes(length: number): Uint8Array {
  const generator = Components.classes["@mozilla.org/security/random-generator;1"]
    .getService(Components.interfaces.nsIRandomGenerator);
  return Uint8Array.from(generator.generateRandomBytes(length));
}

function bytesToBinary(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return value;
}

function sha1Digest(...chunks: Uint8Array[]): Uint8Array {
  const hash = Components.classes["@mozilla.org/security/hash;1"]
    .createInstance(Components.interfaces.nsICryptoHash);
  hash.init(hash.SHA1);
  for (const chunk of chunks) hash.update(chunk, chunk.length);
  const binary = hash.finish(false);
  return Uint8Array.from(binary, (character: string) => character.charCodeAt(0));
}

function sha1Base64(value: string): string {
  return btoa(bytesToBinary(sha1Digest(new TextEncoder().encode(value))));
}

function hmacSha1Base64(secret: string, value: string): string {
  let key = new TextEncoder().encode(secret);
  if (key.length > 64) key = new Uint8Array(sha1Digest(key));
  const inner = new Uint8Array(64);
  const outer = new Uint8Array(64);
  for (let index = 0; index < 64; index++) {
    const byte = key[index] || 0;
    inner[index] = byte ^ 0x36;
    outer[index] = byte ^ 0x5c;
  }
  const valueBytes = new TextEncoder().encode(value);
  const digest = sha1Digest(inner, valueBytes);
  return btoa(bytesToBinary(sha1Digest(outer, digest)));
}

function websocketKey(): string {
  return btoa(bytesToBinary(websocketRandomBytes(16)));
}

function headerEnd(bytes: Uint8Array): number {
  for (let index = 0; index + 3 < bytes.length; index++) {
    if (
      bytes[index] === 13 && bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 && bytes[index + 3] === 10
    ) return index + 4;
  }
  return -1;
}

export function nativeWebSocketUpgradeRequest(key: string, clientProof: string): string {
  return (
    "GET /ws HTTP/1.1\r\n" +
    "Host: localhost\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Key: ${key}\r\n` +
    "Sec-WebSocket-Version: 13\r\n" +
    `X-Zotkit-Client-Proof: ${clientProof}\r\n\r\n`
  );
}

export function validateNativeWebSocketUpgrade(
  response: string,
  expectedAccept: string,
  expectedServerProof: string,
): void {
  const lines = response.split("\r\n");
  if (!/^HTTP\/1\.1 101(?: |$)/.test(lines[0] || "")) {
    throw new Error("Native helper rejected the WebSocket handshake");
  }
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      headers.set(
        line.slice(0, separator).trim().toLowerCase(),
        line.slice(separator + 1).trim(),
      );
    }
  }
  if (headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      !headers.get("connection")?.split(",").some(
        (entry) => entry.trim().toLowerCase() === "upgrade",
      ) ||
      headers.get("sec-websocket-accept") !== expectedAccept ||
      headers.get("x-zotkit-server-proof") !== expectedServerProof) {
    throw new Error("Native helper returned an invalid authenticated handshake");
  }
}

export function encodeClientWebSocketFrame(
  opcode: number,
  payload: Uint8Array,
  mask = websocketRandomBytes(4),
): Uint8Array {
  if (mask.length !== 4) throw new Error("WebSocket mask must contain four bytes");
  if (payload.length > MAX_NATIVE_WEBSOCKET_MESSAGE) {
    throw new Error("Native helper message exceeds 1 MiB");
  }
  const lengthBytes = payload.length <= 125 ? 0 : payload.length <= 0xffff ? 2 : 8;
  const frame = new Uint8Array(2 + lengthBytes + 4 + payload.length);
  frame[0] = 0x80 | (opcode & 0x0f);
  let offset = 2;
  if (!lengthBytes) {
    frame[1] = 0x80 | payload.length;
  }
  else if (lengthBytes === 2) {
    frame[1] = 0x80 | 126;
    frame[2] = payload.length >>> 8;
    frame[3] = payload.length;
    offset = 4;
  }
  else {
    frame[1] = 0x80 | 127;
    const high = Math.floor(payload.length / 0x1_0000_0000);
    const low = payload.length >>> 0;
    frame[2] = 0;
    frame[3] = 0;
    frame[4] = 0;
    frame[5] = high;
    frame[6] = low >>> 24;
    frame[7] = low >>> 16;
    frame[8] = low >>> 8;
    frame[9] = low;
    offset = 10;
  }
  frame.set(mask, offset);
  offset += 4;
  for (let index = 0; index < payload.length; index++) {
    frame[offset + index] = payload[index]! ^ mask[index & 3]!;
  }
  return frame;
}

export interface NativeWebSocketFrame {
  opcode: number;
  payload: Uint8Array;
}

export class ServerWebSocketFrameDecoder {
  private pending = new Uint8Array();

  push(chunk: Uint8Array): NativeWebSocketFrame[] {
    this.pending = new Uint8Array(joinBytes(this.pending, chunk));
    const frames: NativeWebSocketFrame[] = [];
    while (this.pending.length >= 2) {
      const first = this.pending[0]!;
      const second = this.pending[1]!;
      if (!(first & 0x80) || (first & 0x70)) {
        throw new Error("Invalid native helper WebSocket frame flags");
      }
      if (second & 0x80) throw new Error("Native helper frames must not be masked");
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.pending.length < 4) break;
        length = this.pending[2]! * 256 + this.pending[3]!;
        if (length < 126) throw new Error("Non-canonical WebSocket frame length");
        offset = 4;
      }
      else if (length === 127) {
        if (this.pending.length < 10) break;
        if (this.pending.slice(2, 6).some((byte) => byte !== 0)) {
          throw new Error("Native helper WebSocket frame is too large");
        }
        length = (
          this.pending[6]! * 0x1_0000_00 +
          this.pending[7]! * 0x1_0000 +
          this.pending[8]! * 0x100 +
          this.pending[9]!
        );
        if (length <= 0xffff) throw new Error("Non-canonical WebSocket frame length");
        offset = 10;
      }
      if ((opcode & 8) && length > 125) {
        throw new Error("Invalid native helper WebSocket control frame");
      }
      if (length > MAX_NATIVE_WEBSOCKET_MESSAGE) {
        throw new Error("Native helper WebSocket message exceeds 1 MiB");
      }
      if (this.pending.length < offset + length) break;
      frames.push({ opcode, payload: this.pending.slice(offset, offset + length) });
      this.pending = this.pending.slice(offset + length);
    }
    return frames;
  }
}

/** Minimal WebSocket client carried by Gecko's Unix-domain socket transport. */
export class UnixWebSocket {
  readyState = SOCKET_CONNECTING;
  private readonly listeners = new Map<SocketEventType, Set<{
    listener: SocketListener;
    once: boolean;
  }>>();
  private readonly transport: any;
  private readonly input: any;
  private readonly output: any;
  private readonly pump: any;
  private readonly key = websocketKey();
  private readonly expectedAccept: string;
  private readonly clientProof: string;
  private readonly serverProof: string;
  private handshake = new Uint8Array();
  private upgraded = false;
  private frameDecoder = new ServerWebSocketFrameDecoder();
  private closed = false;

  constructor(path: string, token: string) {
    this.expectedAccept = sha1Base64(this.key + WEBSOCKET_GUID);
    this.clientProof = hmacSha1Base64(token, `client:${this.key}`);
    this.serverProof = hmacSha1Base64(token, `server:${this.key}`);
    const service = Components.classes["@mozilla.org/network/socket-transport-service;1"]
      .getService(Components.interfaces.nsISocketTransportService);
    this.transport = service.createUnixDomainTransport(makeLocalFile(path));
    this.output = this.transport.openOutputStream(0, 0, 0);
    this.input = this.transport.openInputStream(0, 0, 0);
    this.pump = Components.classes["@mozilla.org/network/input-stream-pump;1"]
      .createInstance(Components.interfaces.nsIInputStreamPump);
    this.pump.init(this.input, 0, 0, true);
    this.pump.asyncRead({
      onStartRequest: () => {},
      onDataAvailable: (_request: unknown, stream: any, _offset: number, count: number) => {
        try {
          const binary = Components.classes["@mozilla.org/binaryinputstream;1"]
            .createInstance(Components.interfaces.nsIBinaryInputStream);
          binary.setInputStream(stream);
          this.receive(Uint8Array.from(binary.readByteArray(count)));
        }
        catch (error) {
          this.fail(error);
        }
      },
      onStopRequest: (_request: unknown, status: number) => {
        if (!this.closed && !Components.isSuccessCode(status)) {
          this.emit("error", { error: new Error(`Native socket closed (${status})`) });
        }
        this.finishClose();
      },
      QueryInterface: ChromeUtils.generateQI([
        "nsIStreamListener",
        "nsIRequestObserver",
      ]),
    }, null);
    // Gecko's Unix-domain transport does not signal the input pump's
    // onStartRequest when the connection becomes writable. Waiting for that
    // callback deadlocks with an HTTP server that cannot send until it receives
    // this upgrade request; on Zotero 9 it only fires after the server closes
    // its idle handshake. The output stream is already available here, so send
    // the request immediately after installing the input listener.
    try {
      this.writeBinary(new TextEncoder().encode(
        nativeWebSocketUpgradeRequest(this.key, this.clientProof),
      ));
    }
    catch (error) {
      this.finishClose(1006, "Native socket write failed");
      throw error;
    }
  }

  addEventListener(
    type: SocketEventType,
    listener: SocketListener,
    options?: { once?: boolean },
  ): void {
    let entries = this.listeners.get(type);
    if (!entries) {
      entries = new Set();
      this.listeners.set(type, entries);
    }
    entries.add({ listener, once: Boolean(options?.once) });
  }

  send(value: string): void {
    if (this.readyState !== SOCKET_OPEN) throw new Error("Native socket is not open");
    this.writeFrame(1, new TextEncoder().encode(value));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === SOCKET_CLOSED || this.readyState === SOCKET_CLOSING) return;
    this.readyState = SOCKET_CLOSING;
    if (this.upgraded) {
      const reasonBytes = new TextEncoder().encode(reason).slice(0, 123);
      const payload = new Uint8Array(2 + reasonBytes.length);
      payload[0] = code >>> 8;
      payload[1] = code;
      payload.set(reasonBytes, 2);
      try { this.writeFrame(8, payload); }
      catch { /* transport is already gone */ }
    }
    this.finishClose(code, reason);
  }

  private receive(chunk: Uint8Array): void {
    if (!this.upgraded) {
      this.handshake = new Uint8Array(joinBytes(this.handshake, chunk));
      if (this.handshake.length > MAX_NATIVE_HANDSHAKE) {
        throw new Error("Native helper handshake is too large");
      }
      const end = headerEnd(this.handshake);
      if (end < 0) return;
      const response = new TextDecoder().decode(this.handshake.slice(0, end));
      validateNativeWebSocketUpgrade(response, this.expectedAccept, this.serverProof);
      const remainder = this.handshake.slice(end);
      this.handshake = new Uint8Array();
      this.upgraded = true;
      this.readyState = SOCKET_OPEN;
      this.emit("open", {});
      if (remainder.length) this.receiveFrames(remainder);
      return;
    }
    this.receiveFrames(chunk);
  }

  private receiveFrames(chunk: Uint8Array): void {
    for (const frame of this.frameDecoder.push(chunk)) {
      if (frame.opcode === 1) {
        const data = new TextDecoder("utf-8", { fatal: true }).decode(frame.payload);
        this.emit("message", { data });
      }
      else if (frame.opcode === 8) {
        const code = frame.payload.length >= 2
          ? frame.payload[0]! * 256 + frame.payload[1]!
          : 1000;
        const reason = frame.payload.length > 2
          ? new TextDecoder("utf-8", { fatal: true }).decode(frame.payload.slice(2))
          : "";
        this.finishClose(code, reason);
      }
      else if (frame.opcode === 9) {
        this.writeFrame(10, frame.payload);
      }
      else if (frame.opcode !== 10) {
        throw new Error(`Unsupported native helper WebSocket opcode ${frame.opcode}`);
      }
    }
  }

  private writeFrame(opcode: number, payload: Uint8Array): void {
    this.writeBinary(encodeClientWebSocketFrame(opcode, payload));
  }

  private writeBinary(bytes: Uint8Array): void {
    const value = bytesToBinary(bytes);
    let offset = 0;
    while (offset < value.length) {
      const written = this.output.write(value.slice(offset), value.length - offset);
      if (written <= 0) throw new Error("Native socket write failed");
      offset += written;
    }
    this.output.flush?.();
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.emit("error", {
      error: error instanceof Error ? error : new Error(String(error)),
    });
    this.finishClose(1006, "Native socket failure");
  }

  private finishClose(code = 1006, reason = "Native helper disconnected"): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = SOCKET_CLOSED;
    try { this.input.close(); }
    catch { /* already closed */ }
    try { this.output.close(); }
    catch { /* already closed */ }
    try { this.transport.close(Components.results.NS_OK); }
    catch { /* already closed */ }
    this.emit("close", { code, reason });
  }

  private emit(type: SocketEventType, event: unknown): void {
    const entries = this.listeners.get(type);
    if (!entries) return;
    for (const entry of [...entries]) {
      if (entry.once) entries.delete(entry);
      try { entry.listener(event); }
      catch { /* one consumer must not break the socket */ }
    }
  }
}

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
  private socket: UnixWebSocket | null = null;
  private connectingSocket: UnixWebSocket | null = null;
  private socketPath = "";
  private token = "";
  private helperPathValue = "";
  private zotkitPathValue = "";
  private processExited = false;
  private helperStopping = false;
  private stopping = false;
  private lifecycle = 0;
  private startPromise: Promise<void> | null = null;
  private listeners = new Set<BridgeListener>();
  /** Sessions acknowledged by the helper and not yet followed by an exit. */
  private liveSessions = new Set<string>();
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
    return this.socket?.readyState === SOCKET_OPEN;
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
    await this.stopHelperProcess("helper restart");
    const { helperPath, zotkitPath } = await this.installHelper();
    this.assertStarting(lifecycle);
    this.helperPathValue = helperPath;
    this.zotkitPathValue = zotkitPath;

    const runtimeDirectory = await this.secureRuntimeDirectory();
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      this.assertStarting(lifecycle);
      this.token = `${randomID("token")}${randomID("")}`;
      const suffix = randomID("").replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
      this.socketPath = PathUtils.join(runtimeDirectory, `b-${suffix}.sock`);
      if (new TextEncoder().encode(this.socketPath).length >= 104) {
        throw new Error("Zotero profile path is too long for a macOS Unix socket");
      }
      await IOUtils.remove(this.socketPath, { ignoreAbsent: true });
      const tokenPath = await this.createTokenFile(runtimeDirectory, this.token);
      try {
        this.launchProcess(helperPath, [
          "--socket",
          this.socketPath,
          "--token-file",
          tokenPath,
        ]);
        await this.waitForSocket(lifecycle);
        this.assertStarting(lifecycle);
        this.token = "";
        debug("Native helper ready", { transport: "unix" });
        return;
      }
      catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        try { await IOUtils.remove(tokenPath, { ignoreAbsent: true }); }
        catch { /* helper may already have consumed it */ }
        await this.stopHelperProcess("helper retry");
        try { await IOUtils.remove(this.socketPath, { ignoreAbsent: true }); }
        catch { /* helper may still be cleaning up */ }
        this.socketPath = "";
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
    if (this.connectingSocket) {
      try { this.connectingSocket.close(1000, "plugin shutdown"); }
      catch { /* connection is already closing */ }
      this.connectingSocket = null;
    }
    await this.stopHelperProcess("plugin shutdown");
    const socketPath = this.socketPath;
    this.socketPath = "";
    if (socketPath) {
      try { await IOUtils.remove(socketPath, { ignoreAbsent: true }); }
      catch { /* helper may already have removed it */ }
    }
    const pendingStart = this.startPromise;
    if (pendingStart) await pendingStart.catch(() => {});
    await this.stopHelperProcess("plugin shutdown");
    // A process observer or transport implementation may report shutdown after
    // the socket reference has already gone away. Keep the public lifecycle
    // deterministic even in that ordering.
    this.finishLiveSessions(false);
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
    if (this.pendingSpawns.has(sessionId) || this.liveSessions.has(sessionId)) {
      throw new Error("Terminal session id is already in use");
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

  private async secureRuntimeDirectory(): Promise<string> {
    const directory = profilePath("run");
    await IOUtils.makeDirectory(directory, {
      createAncestors: true,
      ignoreExisting: true,
      permissions: 0o700
    });
    const chmod = Components.classes["@mozilla.org/process/util;1"]
      .createInstance(Components.interfaces.nsIProcess);
    chmod.init(makeLocalFile("/bin/chmod"));
    chmod.run(true, ["0700", directory], 2);
    return directory;
  }

  private async createTokenFile(directory: string, token: string): Promise<string> {
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
    this.processExited = false;
    process.runAsync(args, args.length, {
      observe: (_subject: unknown, topic: string) => {
        const exited = topic === "process-finished" || topic === "process-failed";
        if (this.process === process && exited) {
          this.processExited = true;
          const socket = this.socket;
          if (socket && socket.readyState !== SOCKET_CLOSED) {
            // nsIProcess can report first; close locally so established pipe and
            // PTY consumers do not wait for a later stream-pump notification.
            socket.close(1011, "Native helper exited");
          }
          else if (this.liveSessions.size || this.outputDecoders.size) {
            this.finishLiveSessions(!this.stopping && !this.helperStopping);
          }
        }
        if (!this.stopping && !this.helperStopping && exited) {
          debug("Native helper exited");
        }
      }
    }, false);
  }

  private processIsRunning(process: any): boolean {
    try {
      return Boolean(process?.isRunning);
    }
    catch {
      return false;
    }
  }

  private async stopHelperProcess(reason: string): Promise<void> {
    const process = this.process;
    const socket = this.socket;
    if (!process && !socket) return;
    this.helperStopping = true;
    try {
      const authenticated = socket?.readyState === SOCKET_OPEN;
      if (authenticated) {
        try { socket.send(JSON.stringify({ type: "shutdown" })); }
        catch { /* transport already failed */ }
      }

      if (process && authenticated) {
        const deadline = Date.now() + HELPER_GRACEFUL_SHUTDOWN_MS;
        while (Date.now() < deadline && this.processIsRunning(process)) {
          await sleep(25);
        }
      }
      if (process && this.processIsRunning(process)) {
        try { process.kill(); }
        catch { /* process exited between the check and kill */ }
        const deadline = Date.now() + HELPER_KILL_WAIT_MS;
        while (Date.now() < deadline && this.processIsRunning(process)) {
          await sleep(20);
        }
      }

      if (socket && socket.readyState !== SOCKET_CLOSED) {
        try { socket.close(1000, reason); }
        catch { /* socket already closed */ }
      }
      if (this.socket === socket) this.socket = null;
      if (this.process === process) {
        this.process = null;
        this.processExited = true;
      }
      this.finishLiveSessions(false);
    }
    finally {
      this.helperStopping = false;
    }
  }

  private async waitForSocket(lifecycle: number): Promise<void> {
    const deadline = Date.now() + 4000;
    let lastError: Error | null = null;
    while (Date.now() < deadline) {
      this.assertStarting(lifecycle);
      if (this.processExited || !this.process?.isRunning) {
        throw new Error("Native helper exited before creating its private socket");
      }
      if (!await IOUtils.exists(this.socketPath)) {
        await sleep(40);
        continue;
      }
      // Let an early bind failure reach the process observer before any
      // authentication material is written to a socket at this path.
      await sleep(25);
      this.assertStarting(lifecycle);
      if (this.processExited || !this.process?.isRunning ||
          !await IOUtils.exists(this.socketPath)) {
        throw new Error("Native helper did not retain its private socket");
      }
      try {
        await this.openSocket(lifecycle);
        return;
      }
      catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      await sleep(40);
    }
    throw lastError || new Error("Native helper did not create its private socket");
  }

  private openSocket(lifecycle: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new UnixWebSocket(this.socketPath, this.token);
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
      }, 750);
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
      socket.addEventListener("error", (event) => {
        const error = event?.error instanceof Error
          ? event.error
          : new Error("Could not connect to native helper");
        finish(error);
      }, { once: true });
      socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
      socket.addEventListener("close", () => {
        this.handleSocketClosed(socket);
        if (!settled) finish(new Error("Native helper connection closed during startup"));
      });
    });
  }

  private assertStarting(lifecycle: number): void {
    if (this.stopping || lifecycle !== this.lifecycle) {
      throw new Error("Native helper start was cancelled");
    }
  }

  private handleSocketClosed(socket: UnixWebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    for (const sessionId of [...this.pendingSpawns.keys()]) {
      this.rejectSpawn(sessionId, new Error("Native helper disconnected"));
    }
    this.finishLiveSessions(!this.stopping && !this.helperStopping);
  }

  private finishLiveSessions(emitDisconnectError: boolean): void {
    // outputDecoders is included for compatibility with a session whose
    // acknowledgement raced an older bridge implementation. pending spawns
    // have already had their decoder removed by rejectSpawn().
    const sessionIds = new Set([
      ...this.liveSessions,
      ...this.outputDecoders.keys(),
    ]);
    this.liveSessions.clear();
    for (const sessionId of sessionIds) {
      this.emit({
        type: "exit",
        sessionId,
        exitCode: null,
        signal: null,
      });
      this.outputDecoders.delete(sessionId);
    }
    if (emitDisconnectError) {
      this.emit({ type: "error", message: "Native helper disconnected" });
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
        this.liveSessions.add(event.sessionId);
        pending.resolve();
      }
      else if (!this.liveSessions.has(event.sessionId)) {
        // The caller may have timed out just before the acknowledgement. Do
        // not leave the process orphaned in the helper.
        try { this.send({ type: "close", sessionId: event.sessionId }); }
        catch { /* the transport is already closing */ }
      }
    }
    else if (event.type === "error") {
      if (event.sessionId) {
        this.rejectSpawn(event.sessionId, new Error(event.message));
      }
      // An unscoped protocol error is informational. Rejecting every pending
      // spawn here can make a healthy, unrelated process look as if it failed;
      // a transport-wide failure is handled by handleSocketClosed instead.
    }
    this.emit(event);
    if (event.type === "exit") {
      this.liveSessions.delete(event.sessionId);
      this.outputDecoders.delete(event.sessionId);
    }
  }

  private emit(event: BridgeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private rejectSpawn(sessionId: string, error: Error): void {
    const pending = this.pendingSpawns.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSpawns.delete(sessionId);
    this.outputDecoders.delete(sessionId);
    pending.reject(error);
  }

  private requireSocket(): UnixWebSocket {
    if (!this.connected || !this.socket) throw new Error("Native helper is not connected");
    return this.socket;
  }

  private send(value: unknown): void {
    this.requireSocket().send(JSON.stringify(value));
  }
}
