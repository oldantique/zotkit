# 内置 Agent 引擎 + AgentClient 双后端 + 远程 SSH Codex 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Zotero Research Chat 不依赖 codex 订阅——插件内置直连 OpenAI/Anthropic 兼容 API 的 agent 引擎，与 codex 后端并列共存，另支持 SSH 连接远端已登录的 codex。

**Architecture:** 在 `CodexAppServerClient` 的高度萃取 `AgentClient` 接口；新增 `EngineClient` 并列实现该接口——它合成与 codex 相同的通知词汇（`turn/started`、`item/agentMessage/delta`、`turn/completed`、`turn/failed`…）喂给同一个 `ThreadStore`，因此 entries 渲染、`runUtilityTurn`、留痕/Noting 全部零改动。SSH 远程 codex 只是 codex 后端的传输变体（helper `spawnPipe` 拉起 `ssh` 而非本地 `codex`）。

**Tech Stack:** TypeScript + esbuild 单 IIFE、vitest + happy-dom、Zotero 9 Gecko 运行时（fetch/IOUtils/Services.logins）、零 npm 运行时依赖。

**Base spec:** `docs/superpowers/specs/2026-07-26-builtin-agent-engine-design.md`（已批准）。

## Global Constraints

- 全部工作在 worktree `/home/chance/zotkit/.worktrees/zotero-reader` 的 `zotero-plugin/` 内；命令均在 `zotero-plugin/` 目录执行。
- 现有 365 个 vitest 测试全程保持绿；`npm run check`（tsc）全程通过。`npm run build` 在 Linux 上会因 macOS xcrun 步骤失败——**不要**用 build 验证，用 `npm run check && npx vitest run`。
- 零 npm 运行时依赖：一切新代码只用 Web/Gecko 平台 API（fetch、TextDecoder、IOUtils、Services.logins、XMLHttpRequest）。
- **确定性写入保证**：模型（任何 provider）拿到的工具清单永远不含 Zotero 写工具；引擎在 Ask 语义下运行，`setMode("agent")` 在引擎后端必须以可读错误拒绝。
- **turn 失败必须 reject**：引擎任何失败路径都发 `turn/failed` 通知，绝不把半截流当成功（沿用 codex 路径既有铁律）。
- API key / SSH 密码只存 Zotero Login Manager；不进 prefs、不进日志、错误消息不回显。
- 精确数值：token 估算 `Math.ceil(chars / 3)`；默认 contextWindow `131072`；输出预留 `8192`；单轮最多 `8` 次工具调用迭代；引擎模型 id 格式 `engine:<providerId>:<modelId>`。
- 新 prefs（全部要加进 `prefs.js`）：`extensions.zotkit.backend`（默认 `""`）、`extensions.zotkit.providers`（默认 `"[]"`）、`extensions.zotkit.codexTarget`（默认 `"local"`）、`extensions.zotkit.sshProfiles`（默认 `"[]"`）。`platform.ts` 的 `prefString("backend")` 自动带 `extensions.zotkit.` 前缀。
- 用户可见文案用中文，与现有文案风格一致（如"请先打开一篇 PDF"）。
- 提交信息用英文 conventional commits（`feat:`/`refactor:`/`test:`），每个任务至少一次提交。

## 测试环境 Gecko stub（新测试文件的公共前置）

vitest 环境没有 `Services`/`PathUtils`/`Zotero` 全局（现有测试按需局部 stub，见 `test/zotero-mutations.test.ts` 的模式）。本计划多数新测试触碰 pref、`randomID`（`Services.uuid`）或 `profilePath`，统一用一个共享 stub。**Task 4 的 Step 1 先创建** `test/gecko-stubs.ts`：

```ts
/** Minimal Gecko globals for tests that touch prefs, uuids or profile paths. */
const prefsStore = new Map<string, string>();

export function installGeckoStubs(): void {
  const globals = globalThis as Record<string, any>;
  globals.Services = {
    ...globals.Services,
    prefs: {
      getStringPref: (name: string, fallback = "") => prefsStore.get(name) ?? fallback,
      setStringPref: (name: string, value: string) => { prefsStore.set(name, value); },
      getIntPref: (_name: string, fallback: number) => fallback,
      getBoolPref: (_name: string, fallback: boolean) => fallback,
      setIntPref: () => {},
    },
    uuid: globals.Services?.uuid ?? {
      generateUUID: () => `{${Math.random().toString(16).slice(2)}0000000000}`,
    },
  };
  globals.PathUtils = globals.PathUtils ?? { join: (...parts: string[]) => parts.join("/") };
  globals.Zotero = globals.Zotero ?? { Profile: { dir: "/profile" } };
}
```

Task 4/6/7/12 的测试文件（以及任何新测试只要 import 了 `providers`/`secrets`、构造 `EngineClient`、或走 `service.start()`）在 import 区之后立即调用：

```ts
import { installGeckoStubs } from "./gecko-stubs";

installGeckoStubs();
```

`prefsStore` 在同一文件内跨用例共享——需要复位的 pref 用 `setPrefString` 显式写回（Task 4 的 afterEach 已示范）。vitest 默认按文件隔离 worker，不会污染其他测试文件。

## 文件结构总览

| 文件 | 职责 |
|---|---|
| `src/agent-client.ts`（新） | `AgentClient` 接口、`AgentCapabilities`、两组能力常量 |
| `src/http-stream.ts`（新） | `streamRequest`：fetch ReadableStream 流式 + XHR onprogress 回退 |
| `src/wire.ts`（新） | wire 层共享类型：`WireMessage`/`WireToolCall`/`WireEvent`/`WireAdapter`/`WireParser` |
| `src/wire-openai.ts`（新） | OpenAI 兼容请求构造 + SSE 增量解析 |
| `src/wire-anthropic.ts`（新） | Anthropic 兼容请求构造 + 事件流解析 |
| `src/secrets.ts`（新） | Login Manager 存取（Components 缺失时内存回退）、`maskSecret` |
| `src/providers.ts`（新） | `ProviderProfile` 模型、pref 持久化、预设模板、连通性测试 |
| `src/engine-messages.ts`（新） | 纯函数：消息组装、截断、`resolveEngineModel` |
| `src/engine-client.ts`（新） | `EngineClient`：agent loop、通知合成、转录持久化、`importThread` |
| `src/ssh-codex.ts`（新） | `SshCodexProfile`、`buildSshLaunch`（argv/env 构造） |
| `src/model-menu.ts`（新） | sidebar/float 共用的两级模型菜单渲染 |
| `src/provider-settings.ts`（新） | 设置卡 DOM 组件：provider 列表/表单/预设/SSH 配置 |
| `src/codex-service.ts`（改） | client 字段类型换 `AgentClient`；capability 守卫；双后端启动；`switchBackend` 迁移；远程 codex |
| `src/codex-app-server.ts`（改） | `agentCapabilities` 字段（接口符合性） |
| `src/sidebar.ts` / `src/float-panel.ts`（改） | 两级菜单、引导卡、切换确认卡、capability 隐藏 |
| `src/plugin.ts`（改） | 后端切换流程、设置卡挂载、账户标签 |
| `prefs.js`（改） | 四个新 pref |

任务顺序即依赖顺序；Task 13–14（SSH）只依赖 Task 1，可在最后独立完成。

---

### Task 1: AgentClient 接口萃取 + capability 守卫

**Files:**
- Create: `src/agent-client.ts`
- Modify: `src/codex-app-server.ts`（`CodexAppServerClient` 加 `agentCapabilities` 字段）
- Modify: `src/codex-service.ts`（`client` 字段类型、`state.capabilities`、steer/login/checkpoint/mode 守卫）
- Test: `test/agent-client.test.ts`

**Interfaces:**
- Produces: `AgentClient`、`AgentCapabilities`、`CODEX_CAPABILITIES`、`ENGINE_CAPABILITIES`（后续所有任务消费）；`CodexServiceState.capabilities: AgentCapabilities`。
- 背景：`CodexService` 今天只调用 client 的这些方法——`connect/close/accountRead/accountLoginStart/accountLogout/modelList/threadStart/threadResume/threadRead/threadSetName/threadFork/threadRollback/turnStart/turnSteer/turnInterrupt`。接口就是这个清单，codex 专属的四个（steer/login×2/fork/rollback）声明为可选并用 capability 守卫。

- [ ] **Step 1: 写 `src/agent-client.ts`**

```ts
import type {
  AccountLoginParams,
  AccountLoginResponse,
  AccountReadResponse,
  ModelListParams,
  ModelListResponse,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadRollbackParams,
  ThreadRollbackResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from "./codex-app-server";

/** Backend feature flags resolved when a backend starts; UI reads them from service state. */
export interface AgentCapabilities {
  supportsAgentMode: boolean;
  supportsSteering: boolean;
  supportsLogin: boolean;
  supportsCheckpoints: boolean;
}

/**
 * The narrow client surface CodexService actually consumes. Extracted from
 * CodexAppServerClient's call sites, not invented: EngineClient implements the
 * same contract in-process, feeding the same ThreadStore with the same
 * notification vocabulary.
 */
export interface AgentClient {
  readonly agentCapabilities: AgentCapabilities;
  connect(): Promise<unknown>;
  close(code?: number, reason?: string): void;
  accountRead(params?: { refreshToken?: boolean }): Promise<AccountReadResponse>;
  modelList(params?: ModelListParams): Promise<ModelListResponse>;
  threadStart(params?: ThreadStartParams): Promise<ThreadStartResponse>;
  threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse>;
  threadRead(threadId: string, includeTurns?: boolean): Promise<ThreadReadResponse>;
  threadSetName(threadId: string, name: string): Promise<Record<string, never>>;
  turnStart(params: TurnStartParams): Promise<TurnStartResponse>;
  turnInterrupt(params: TurnInterruptParams): Promise<Record<string, never>>;
  // Codex-only surfaces. Call sites must gate on agentCapabilities.
  turnSteer?(params: TurnSteerParams): Promise<TurnSteerResponse>;
  accountLoginStart?(params: AccountLoginParams): Promise<AccountLoginResponse>;
  accountLogout?(): Promise<Record<string, never>>;
  threadFork?(params: ThreadForkParams): Promise<ThreadForkResponse>;
  threadRollback?(params: ThreadRollbackParams): Promise<ThreadRollbackResponse>;
}

export const CODEX_CAPABILITIES: AgentCapabilities = Object.freeze({
  supportsAgentMode: true,
  supportsSteering: true,
  supportsLogin: true,
  supportsCheckpoints: true,
});

export const ENGINE_CAPABILITIES: AgentCapabilities = Object.freeze({
  supportsAgentMode: false,
  supportsSteering: false,
  supportsLogin: false,
  supportsCheckpoints: false,
});
```

注意：`import type` 保证与 `codex-app-server.ts` 之间没有运行时环依赖。若个别类型名（如 `ModelListParams`）在 `codex-app-server.ts` 未 re-export，从 `./protocol` 导入即可（先看 `codex-app-server.ts` 头部的 re-export 列表）。

- [ ] **Step 2: `CodexAppServerClient` 加能力字段**

在 `src/codex-app-server.ts` 的 `CodexAppServerClient` 类体开头（`readonly store: ThreadStore;` 旁）加：

```ts
readonly agentCapabilities = CODEX_CAPABILITIES;
```

并在文件顶部加 `import { CODEX_CAPABILITIES } from "./agent-client";`（值导入方向是 codex-app-server → agent-client，agent-client 对 codex-app-server 只有 type 导入，无环）。

- [ ] **Step 3: 写失败测试 `test/agent-client.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import type { AgentClient } from "../src/agent-client";
import { ENGINE_CAPABILITIES } from "../src/agent-client";
import { CodexAppServerClient } from "../src/codex-app-server";
import { CodexService } from "../src/codex-service";
import type { NativeBridge } from "../src/native-bridge";
import type { ReaderContextService } from "../src/reader-context";

describe("agent-client contract", () => {
  it("CodexAppServerClient conforms to AgentClient", () => {
    const client: AgentClient = new CodexAppServerClient({ url: "ws://unused" });
    expect(client.agentCapabilities.supportsSteering).toBe(true);
  });
});

function engineLikeService(client: Partial<AgentClient>) {
  const callbacks = { onState: vi.fn(), onError: vi.fn() };
  const service = new CodexService(
    {} as NativeBridge,
    { tools: [] } as unknown as ReaderContextService,
    "test",
    callbacks,
  );
  const internal = service as any;
  internal.client = client;
  internal.activePaperKey = "1-ATTACH";
  internal.activeContext = {
    attachment: { key: "ATTACH", libraryID: 1, title: "P", filename: "p.pdf", creators: [], tags: [] },
    page: { pageIndex: 0, pageNumber: 1, text: "", source: "pdfjs", warnings: [] },
    workspace: { root: "/w" },
    warnings: [],
  };
  internal.threadPaperKeys.set("thread-a", "1-ATTACH");
  service.state.connected = true;
  service.state.activeThreadId = "thread-a";
  service.state.capabilities = ENGINE_CAPABILITIES;
  return { service, callbacks };
}

describe("capability guards", () => {
  it("rejects steering when the backend does not support it", async () => {
    const { service } = engineLikeService({});
    service.state.running = true;
    service.state.activeTurnId = "turn-1";
    await expect(service.send("追问", "engine:p:m", "medium"))
      .rejects.toThrow(/不支持在回答进行中追加/);
  });

  it("rejects agent mode when unsupported", async () => {
    const { service } = engineLikeService({});
    await expect(service.setMode("agent")).rejects.toThrow(/不支持 Agent 模式/);
  });

  it("rejects login when unsupported", async () => {
    const { service } = engineLikeService({});
    await expect(service.login()).rejects.toThrow(/不需要登录|不支持登录/);
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `npx vitest run test/agent-client.test.ts`
Expected: FAIL（`agentCapabilities` 不存在 / 守卫尚未实现，`send` 走到 `turnSteer` 抛 TypeError）。

- [ ] **Step 5: 改 `src/codex-service.ts`**

逐处修改（保持其余逻辑字节不动）：

1. 导入：`import { CODEX_CAPABILITIES, type AgentCapabilities, type AgentClient } from "./agent-client";`
2. `CodexServiceState` 接口加一行：`capabilities: AgentCapabilities;`；`state` 初始化对象加 `capabilities: CODEX_CAPABILITIES`。
3. 字段类型：`private client: AgentClient | null = null;`；`requireClient(): AgentClient`。
4. `startInternal` 成功路径（`this.client = client;` 之后）加 `this.state.capabilities = client.agentCapabilities;`。
5. `sendToActiveTurn` 的 running 分支，在调用 `turnSteer` 前加：

```ts
      const client = this.requireClient();
      if (!this.state.capabilities.supportsSteering || !client.turnSteer) {
        throw new Error("当前模型服务不支持在回答进行中追加，请等待完成或先点停止");
      }
```

并把 `await this.requireClient().turnSteer({...})` 改为 `await client.turnSteer({...})`。

6. `login()` 开头加：

```ts
    if (!this.state.capabilities.supportsLogin || !this.requireClient().accountLoginStart) {
      throw new Error("当前后端不需要登录");
    }
```

调用改为 `await this.requireClient().accountLoginStart!({...})`。`logout()` 同样守卫（`supportsLogin` + `accountLogout`，文案"当前后端不支持退出登录"）。

7. `setMode` 开头（mode 校验后）加：

```ts
    if (mode === "agent" && !this.state.capabilities.supportsAgentMode) {
      return Promise.reject(new Error("当前模型服务不支持 Agent 模式"));
    }
```

8. `restoreCheckpoint` 与 `rollbackConversation`：调用 `threadFork`/`threadRollback` 前守卫 `supportsCheckpoints` 且方法存在，否则 `throw new Error("当前后端不支持检查点")`；调用处改用非空断言（守卫后）。

- [ ] **Step 6: 跑测试与全量回归**

Run: `npx vitest run test/agent-client.test.ts && npm run check && npx vitest run`
Expected: 新测试 PASS；既有 365 全绿；tsc 通过。

- [ ] **Step 7: Commit**

```bash
git add src/agent-client.ts src/codex-app-server.ts src/codex-service.ts test/agent-client.test.ts
git commit -m "refactor: extract AgentClient interface with capability guards"
```

---

### Task 2: HTTP 流式传输（http-stream.ts）

**Files:**
- Create: `src/http-stream.ts`
- Test: `test/http-stream.test.ts`

**Interfaces:**
- Produces: `streamRequest(options: StreamRequestOptions): Promise<StreamResult>`；`StreamRequestOptions { url; headers; body; signal; onChunk(text); fetchImpl? }`；`StreamResult { status: number; ok: boolean; errorBody: string | null }`。Task 6 的 EngineClient 与 Task 4 的连通性测试消费。
- 语义：2xx → 增量回调 `onChunk`，resolve `{ok:true}`；非 2xx → **不**调 `onChunk`，读全文进 `errorBody`；abort → reject `AbortError`；`fetchImpl: null` 强制走 XHR 回退（测试用）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { streamRequest } from "../src/http-stream";

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

describe("streamRequest", () => {
  it("delivers chunks incrementally on 2xx", async () => {
    const seen: string[] = [];
    const result = await streamRequest({
      url: "https://api.example/v1",
      headers: {},
      body: "{}",
      signal: new AbortController().signal,
      onChunk: (text) => seen.push(text),
      fetchImpl: async () => sseResponse(["hel", "lo"]),
    });
    expect(result.ok).toBe(true);
    expect(seen.join("")).toBe("hello");
  });

  it("returns errorBody without chunks on non-2xx", async () => {
    const seen: string[] = [];
    const result = await streamRequest({
      url: "https://api.example/v1",
      headers: {},
      body: "{}",
      signal: new AbortController().signal,
      onChunk: (text) => seen.push(text),
      fetchImpl: async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }),
    });
    expect(result).toEqual({ status: 401, ok: false, errorBody: '{"error":{"message":"bad key"}}' });
    expect(seen).toEqual([]);
  });

  it("falls back to XHR when fetchImpl is null", async () => {
    const seen: string[] = [];
    class FakeXHR {
      status = 200;
      responseText = "";
      onprogress: (() => void) | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      abort() {}
      send() {
        this.responseText = "part1";
        this.onprogress?.();
        this.responseText = "part1part2";
        this.onprogress?.();
        this.onload?.();
      }
    }
    (globalThis as any).XMLHttpRequest = FakeXHR;
    const result = await streamRequest({
      url: "https://api.example/v1",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: new AbortController().signal,
      onChunk: (text) => seen.push(text),
      fetchImpl: null,
    });
    delete (globalThis as any).XMLHttpRequest;
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["part1", "part2"]);
  });

  it("rejects with AbortError when aborted before start", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(streamRequest({
      url: "https://api.example/v1",
      headers: {},
      body: "{}",
      signal: controller.signal,
      onChunk: () => {},
      fetchImpl: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/http-stream.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 `src/http-stream.ts`**

```ts
export interface StreamResult {
  status: number;
  ok: boolean;
  errorBody: string | null;
}

export interface StreamRequestOptions {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  onChunk(text: string): void;
  /** Injectable for tests; `null` forces the XHR fallback path. */
  fetchImpl?: typeof fetch | null;
}

/**
 * Streams a POST response body as incremental text. Prefers fetch +
 * ReadableStream (Gecko 102+); falls back to XMLHttpRequest onprogress when
 * fetch is unavailable. Non-2xx responses never reach onChunk — the whole
 * body is returned as errorBody so callers can surface a readable error.
 */
export async function streamRequest(options: StreamRequestOptions): Promise<StreamResult> {
  const fetchImpl = options.fetchImpl === undefined
    ? (typeof fetch === "function" ? fetch.bind(globalThis) : null)
    : options.fetchImpl;
  if (fetchImpl) return fetchStream(fetchImpl, options);
  return xhrStream(options);
}

async function fetchStream(
  fetchImpl: typeof fetch,
  options: StreamRequestOptions,
): Promise<StreamResult> {
  const response = await fetchImpl(options.url, {
    method: "POST",
    headers: options.headers,
    body: options.body,
    signal: options.signal,
  });
  if (!response.ok) {
    let errorBody: string | null = null;
    try {
      errorBody = await response.text();
    }
    catch {
      errorBody = null;
    }
    return { status: response.status, ok: false, errorBody };
  }
  const body = response.body;
  if (!body) {
    // Environment without ReadableStream on Response: deliver in one piece.
    options.onChunk(await response.text());
    return { status: response.status, ok: true, errorBody: null };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      const text = decoder.decode(value, { stream: true });
      if (text) options.onChunk(text);
    }
  }
  const tail = decoder.decode();
  if (tail) options.onChunk(tail);
  return { status: response.status, ok: true, errorBody: null };
}

function xhrStream(options: StreamRequestOptions): Promise<StreamResult> {
  return new Promise<StreamResult>((resolve, reject) => {
    const XHR = (globalThis as { XMLHttpRequest?: new () => XMLHttpRequest }).XMLHttpRequest;
    if (!XHR) {
      reject(new Error("此环境不支持网络请求"));
      return;
    }
    const request = new XHR();
    let delivered = 0;
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => {
      try { request.abort(); } catch { /* already closed */ }
      reject(abortError());
    });
    if (options.signal.aborted) {
      reject(abortError());
      return;
    }
    options.signal.addEventListener("abort", onAbort);
    request.open("POST", options.url, true);
    for (const [name, value] of Object.entries(options.headers)) {
      request.setRequestHeader(name, value);
    }
    request.onprogress = () => {
      if (request.status >= 200 && request.status < 300) {
        const text = request.responseText || "";
        if (text.length > delivered) {
          options.onChunk(text.slice(delivered));
          delivered = text.length;
        }
      }
    };
    request.onload = () => finish(() => {
      const ok = request.status >= 200 && request.status < 300;
      if (ok) {
        const text = request.responseText || "";
        if (text.length > delivered) options.onChunk(text.slice(delivered));
        resolve({ status: request.status, ok: true, errorBody: null });
      }
      else {
        resolve({ status: request.status, ok: false, errorBody: request.responseText || null });
      }
    });
    request.onerror = () => finish(() => reject(new Error("网络请求失败，请检查网络或 baseUrl")));
    request.send(options.body);
  });
}

function abortError(): Error {
  const error = new Error("已中断");
  error.name = "AbortError";
  return error;
}
```

- [ ] **Step 4: 跑测试与回归**

Run: `npx vitest run test/http-stream.test.ts && npm run check`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/http-stream.ts test/http-stream.test.ts
git commit -m "feat: streaming HTTP transport with fetch and XHR fallback"
```

---

### Task 3: wire 类型层 + OpenAI 兼容适配器

**Files:**
- Create: `src/wire.ts`
- Create: `src/wire-openai.ts`
- Test: `test/wire-openai.test.ts`

**Interfaces:**
- Produces（`src/wire.ts`，Task 6/11 消费）:

```ts
export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  text: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: WireToolCall[];
  /** Present on tool result messages. */
  toolCallId?: string;
}
export interface WireToolCall { id: string; name: string; argumentsJson: string; }
export interface WireToolSpec { name: string; description: string; inputSchema: Record<string, unknown>; }
export type WireEvent =
  | { type: "textDelta"; delta: string }
  | { type: "toolCalls"; calls: WireToolCall[] }
  | { type: "stop"; reason: "end" | "toolCalls" }
  | { type: "error"; message: string };
export interface WireRequest { url: string; headers: Record<string, string>; body: string; }
export interface WireRequestParams { model: string; effort: string | null; }
export interface WireParser { push(chunk: string): WireEvent[]; end(): WireEvent[]; }
export interface WireAdapter {
  buildRequest(
    baseUrl: string,
    apiKey: string,
    messages: WireMessage[],
    tools: WireToolSpec[],
    params: WireRequestParams,
  ): WireRequest;
  createParser(): WireParser;
}
```

- 解析器约定：`textDelta` 实时流出；tool call 增量在解析器内部拼装，`finish_reason`/`[DONE]` 时一次性发 `{toolCalls}` + `{stop, reason:"toolCalls"}`；`stop` 之后忽略后续行；`error` 事件后停止。忽略不认识的 delta 字段（如 DeepSeek 的 `reasoning_content`）。

- [ ] **Step 1: 写 `src/wire.ts`**（内容即上方 Produces 代码块，原样成文件，无实现逻辑。）

- [ ] **Step 2: 写失败测试 `test/wire-openai.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { OpenAIWire } from "../src/wire-openai";
import type { WireEvent } from "../src/wire";

const wire = new OpenAIWire();

function sse(lines: string[]): string {
  return lines.map((line) => `data: ${line}\n\n`).join("");
}

function drain(chunks: string[]): WireEvent[] {
  const parser = wire.createParser();
  const events: WireEvent[] = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.end());
  return events;
}

describe("OpenAIWire.buildRequest", () => {
  it("builds a chat-completions request with tools and bearer auth", () => {
    const request = wire.buildRequest(
      "https://api.deepseek.com/",
      "sk-test",
      [
        { role: "system", text: "sys" },
        { role: "user", text: "你好" },
        { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "zotero_page", argumentsJson: '{"page":3}' }] },
        { role: "tool", text: "page text", toolCallId: "c1" },
      ],
      [{ name: "zotero_page", description: "read page", inputSchema: { type: "object" } }],
      { model: "deepseek-chat", effort: null },
    );
    expect(request.url).toBe("https://api.deepseek.com/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(request.body);
    expect(body.model).toBe("deepseek-chat");
    expect(body.stream).toBe(true);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.messages[2].tool_calls[0].function.name).toBe("zotero_page");
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "page text" });
    expect(body.tools[0].function.parameters).toEqual({ type: "object" });
  });

  it("includes reasoning_effort only when provided", () => {
    const request = wire.buildRequest("https://api.openai.com/v1", "k", [{ role: "user", text: "hi" }], [], {
      model: "gpt-5-mini", effort: "high",
    });
    expect(JSON.parse(request.body).reasoning_effort).toBe("high");
  });
});

describe("OpenAIWire parser", () => {
  it("streams text deltas split across chunks", () => {
    const payload = sse([
      '{"choices":[{"delta":{"content":"你"}}]}',
      '{"choices":[{"delta":{"content":"好"},"finish_reason":null}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "[DONE]",
    ]);
    const middle = Math.floor(payload.length / 2);
    const events = drain([payload.slice(0, middle), payload.slice(middle)]);
    const text = events.filter((event) => event.type === "textDelta")
      .map((event) => (event as { delta: string }).delta).join("");
    expect(text).toBe("你好");
    expect(events.at(-1)).toEqual({ type: "stop", reason: "end" });
  });

  it("assembles parallel tool calls from indexed deltas", () => {
    const events = drain([sse([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"a","arguments":"{\\"x\\":"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c1","function":{"name":"b","arguments":"{}"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    ])]);
    const toolEvent = events.find((event) => event.type === "toolCalls") as { calls: unknown[] } | undefined;
    expect(toolEvent?.calls).toEqual([
      { id: "c0", name: "a", argumentsJson: '{"x":1}' },
      { id: "c1", name: "b", argumentsJson: "{}" },
    ]);
    expect(events.at(-1)).toEqual({ type: "stop", reason: "toolCalls" });
  });

  it("surfaces provider error payloads and stops", () => {
    const events = drain([sse(['{"error":{"message":"Invalid model"}}'])]);
    expect(events[0]).toEqual({ type: "error", message: "Invalid model" });
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run test/wire-openai.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 4: 写 `src/wire-openai.ts`**

```ts
import type {
  WireAdapter,
  WireEvent,
  WireMessage,
  WireParser,
  WireRequest,
  WireRequestParams,
  WireToolSpec,
} from "./wire";

/** OpenAI-compatible chat-completions wire (DeepSeek, Moonshot, OpenRouter, Ollama, OpenAI). */
export class OpenAIWire implements WireAdapter {
  buildRequest(
    baseUrl: string,
    apiKey: string,
    messages: WireMessage[],
    tools: WireToolSpec[],
    params: WireRequestParams,
  ): WireRequest {
    const body: Record<string, unknown> = {
      model: params.model,
      stream: true,
      messages: messages.map(toOpenAIMessage),
    };
    if (tools.length) {
      body.tools = tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }));
    }
    if (params.effort) body.reasoning_effort = params.effort;
    return {
      url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    };
  }

  createParser(): WireParser {
    return new OpenAIStreamParser();
  }
}

function toOpenAIMessage(message: WireMessage): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.text || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.argumentsJson },
      })),
    };
  }
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId || "", content: message.text };
  }
  return { role: message.role, content: message.text };
}

class OpenAIStreamParser implements WireParser {
  private buffer = "";
  private stopped = false;
  private readonly toolCalls = new Map<number, { id: string; name: string; argumentsJson: string }>();

  push(chunk: string): WireEvent[] {
    this.buffer += chunk;
    const events: WireEvent[] = [];
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.consumeLine(line, events);
    }
    return events;
  }

  end(): WireEvent[] {
    const events: WireEvent[] = [];
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) this.consumeLine(rest, events);
    if (!this.stopped) {
      this.stopped = true;
      this.flushStop(events, this.toolCalls.size ? "toolCalls" : "end");
    }
    return events;
  }

  private consumeLine(line: string, events: WireEvent[]): void {
    if (this.stopped || !line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      this.stopped = true;
      this.flushStop(events, this.toolCalls.size ? "toolCalls" : "end");
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    }
    catch {
      this.stopped = true;
      events.push({ type: "error", message: "模型服务返回了无法解析的流式数据" });
      return;
    }
    const errorRecord = parsed.error as Record<string, unknown> | undefined;
    if (errorRecord) {
      this.stopped = true;
      events.push({
        type: "error",
        message: typeof errorRecord.message === "string" ? errorRecord.message : "模型服务返回错误",
      });
      return;
    }
    const choice = Array.isArray(parsed.choices)
      ? parsed.choices[0] as Record<string, unknown> | undefined
      : undefined;
    if (!choice) return;
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (typeof delta?.content === "string" && delta.content) {
      events.push({ type: "textDelta", delta: delta.content });
    }
    for (const raw of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
      const record = raw as Record<string, unknown>;
      const callIndex = typeof record.index === "number" ? record.index : 0;
      const current = this.toolCalls.get(callIndex) ?? { id: "", name: "", argumentsJson: "" };
      if (typeof record.id === "string" && record.id) current.id = record.id;
      const fn = record.function as Record<string, unknown> | undefined;
      if (typeof fn?.name === "string" && fn.name) current.name = fn.name;
      if (typeof fn?.arguments === "string") current.argumentsJson += fn.arguments;
      this.toolCalls.set(callIndex, current);
    }
    const finish = choice.finish_reason;
    if (finish === "tool_calls" || finish === "stop") {
      this.stopped = true;
      this.flushStop(events, finish === "tool_calls" ? "toolCalls" : "end");
    }
  }

  private flushStop(events: WireEvent[], reason: "end" | "toolCalls"): void {
    if (this.toolCalls.size) {
      const calls = [...this.toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([position, call]) => ({
          id: call.id || `call-${position}`,
          name: call.name,
          argumentsJson: call.argumentsJson || "{}",
        }));
      this.toolCalls.clear();
      events.push({ type: "toolCalls", calls });
      events.push({ type: "stop", reason: "toolCalls" });
      return;
    }
    events.push({ type: "stop", reason });
  }
}
```

- [ ] **Step 5: 跑测试与回归**

Run: `npx vitest run test/wire-openai.test.ts && npm run check`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/wire.ts src/wire-openai.ts test/wire-openai.test.ts
git commit -m "feat: wire abstraction and OpenAI-compatible streaming adapter"
```

---

### Task 4: secrets(Login Manager)+ ProviderProfile 配置

**Files:**
- Create: `src/secrets.ts`
- Create: `src/providers.ts`
- Create: `test/gecko-stubs.ts`（见「测试环境 Gecko stub」一节，内容照搬）
- Modify: `prefs.js`(加 `providers`/`backend` 两个 pref)
- Test: `test/providers.test.ts`

**Interfaces:**
- Produces(`src/secrets.ts`):
  - `saveSecret(realm: string, username: string, secret: string): Promise<void>`
  - `readSecret(realm: string, username: string): Promise<string | null>`
  - `deleteSecret(realm: string, username: string): Promise<void>`
  - `maskSecret(secret: string): string` → `"····" + 尾 4 位`
- Produces(`src/providers.ts`):
  - `ProviderModel { id; label; contextWindow?; supportsReasoningEffort? }`
  - `ProviderProfile { id; name; wire: "openai" | "anthropic"; baseUrl; models: ProviderModel[]; defaultModel }`
  - `loadProviders(): ProviderProfile[]` / `saveProviders(profiles: ProviderProfile[]): void`(pref `providers` JSON)
  - `PROVIDER_PRESETS: readonly ProviderPreset[]`(`ProviderPreset = Omit<ProviderProfile, "id">`)
  - `providerKeyRealm(providerId: string): string` → `zotkit-provider:<providerId>`
  - `connectivityError(result: StreamResult): string`(HTTP 状态 → 可读中文文案)
  - `testProvider(profile, apiKey, streamImpl?): Promise<string>`(连通性测试)

- [ ] **Step 1: 写失败测试 `test/providers.test.ts`**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { installGeckoStubs } from "./gecko-stubs";

installGeckoStubs();

import { deleteSecret, maskSecret, readSecret, saveSecret } from "../src/secrets";
import { setPrefString } from "../src/platform";
import {
  PROVIDER_PRESETS,
  loadProviders,
  providerKeyRealm,
  saveProviders,
  testProvider,
  type ProviderProfile,
} from "../src/providers";

const profile: ProviderProfile = {
  id: "p-deepseek",
  name: "DeepSeek",
  wire: "openai",
  baseUrl: "https://api.deepseek.com",
  models: [{ id: "deepseek-chat", label: "DeepSeek Chat", contextWindow: 65536 }],
  defaultModel: "deepseek-chat",
};

afterEach(() => {
  saveProviders([]);
});

describe("secrets (memory fallback outside Gecko)", () => {
  it("round-trips and masks a secret", async () => {
    await saveSecret(providerKeyRealm("p1"), "p1", "sk-abcdef1234");
    expect(await readSecret(providerKeyRealm("p1"), "p1")).toBe("sk-abcdef1234");
    expect(maskSecret("sk-abcdef1234")).toBe("····1234");
    await deleteSecret(providerKeyRealm("p1"), "p1");
    expect(await readSecret(providerKeyRealm("p1"), "p1")).toBeNull();
  });
});

describe("providers", () => {
  it("round-trips profiles through the pref", () => {
    saveProviders([profile]);
    expect(loadProviders()).toEqual([profile]);
  });

  it("tolerates corrupted pref JSON", () => {
    setPrefString("providers", "{not json");
    expect(loadProviders()).toEqual([]);
  });

  it("ships the spec'd presets", () => {
    const names = PROVIDER_PRESETS.map((preset) => preset.name);
    expect(names).toEqual(expect.arrayContaining([
      "DeepSeek", "Kimi（月之暗面开放平台）", "Kimi For Coding（订阅）",
      "OpenRouter", "Ollama（本地）", "OpenAI", "Anthropic",
    ]));
    const kimiSub = PROVIDER_PRESETS.find((preset) => preset.name.startsWith("Kimi For Coding"));
    expect(kimiSub?.wire).toBe("anthropic");
    expect(kimiSub?.baseUrl).toBe("");
  });

  it("reports readable connectivity results", async () => {
    const ok = await testProvider(profile, "sk-x", async (options) => {
      options.onChunk("data: {}\n");
      return { status: 200, ok: true, errorBody: null };
    });
    expect(ok).toMatch(/连接成功/);
    await expect(testProvider(profile, "sk-x", async () => ({
      status: 401, ok: false, errorBody: null,
    }))).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/providers.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写 `src/secrets.ts`**

```ts
/**
 * Secret storage backed by the Zotero (Gecko) Login Manager. Secrets never
 * touch prefs or logs. Outside Gecko (vitest) an in-memory map keeps the
 * call sites testable; the real branch is covered by the macOS smoke pass.
 */
const LOGIN_ORIGIN = "chrome://zotkit";
const memoryFallback = new Map<string, string>();

function memoryKey(realm: string, username: string): string {
  return `${realm}|${username}`;
}

function loginsApi(): any | null {
  if (typeof Components === "undefined") return null;
  try {
    return (globalThis as { Services?: { logins?: unknown } }).Services?.logins ?? null;
  }
  catch {
    return null;
  }
}

async function findLogin(api: any, realm: string, username: string): Promise<any | null> {
  const logins = await api.searchLoginsAsync({ origin: LOGIN_ORIGIN, httpRealm: realm });
  for (const login of logins) {
    if (login.username === username) return login;
  }
  return null;
}

export async function saveSecret(realm: string, username: string, secret: string): Promise<void> {
  const api = loginsApi();
  if (!api) {
    memoryFallback.set(memoryKey(realm, username), secret);
    return;
  }
  const existing = await findLogin(api, realm, username);
  if (existing) api.removeLogin(existing);
  const info = Components.classes["@mozilla.org/login-manager/loginInfo;1"]
    .createInstance(Components.interfaces.nsILoginInfo);
  info.init(LOGIN_ORIGIN, null, realm, username, secret, "", "");
  await api.addLoginAsync(info);
}

export async function readSecret(realm: string, username: string): Promise<string | null> {
  const api = loginsApi();
  if (!api) return memoryFallback.get(memoryKey(realm, username)) ?? null;
  const login = await findLogin(api, realm, username);
  return login ? String(login.password) : null;
}

export async function deleteSecret(realm: string, username: string): Promise<void> {
  const api = loginsApi();
  if (!api) {
    memoryFallback.delete(memoryKey(realm, username));
    return;
  }
  const login = await findLogin(api, realm, username);
  if (login) api.removeLogin(login);
}

export function maskSecret(secret: string): string {
  return `····${secret.slice(-4)}`;
}
```

- [ ] **Step 4: 写 `src/providers.ts`**

```ts
import { prefString, setPrefString } from "./platform";
import { streamRequest, type StreamRequestOptions, type StreamResult } from "./http-stream";
import { OpenAIWire } from "./wire-openai";

export interface ProviderModel {
  id: string;
  label: string;
  contextWindow?: number;
  supportsReasoningEffort?: boolean;
}

export interface ProviderProfile {
  id: string;
  name: string;
  wire: "openai" | "anthropic";
  baseUrl: string;
  models: ProviderModel[];
  defaultModel: string;
}

export type ProviderPreset = Omit<ProviderProfile, "id">;

export const PROVIDER_PRESETS: readonly ProviderPreset[] = Object.freeze([
  {
    name: "DeepSeek",
    wire: "openai" as const,
    baseUrl: "https://api.deepseek.com",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat", contextWindow: 65536 },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner", contextWindow: 65536 },
    ],
    defaultModel: "deepseek-chat",
  },
  {
    name: "Kimi（月之暗面开放平台）",
    wire: "openai" as const,
    baseUrl: "https://api.moonshot.cn/v1",
    models: [{ id: "kimi-k2-0711-preview", label: "Kimi K2", contextWindow: 131072 }],
    defaultModel: "kimi-k2-0711-preview",
  },
  {
    // Subscription endpoint is Anthropic-compatible; its URL tracks Moonshot's
    // docs, so the preset ships without one and the form requires it.
    name: "Kimi For Coding（订阅）",
    wire: "anthropic" as const,
    baseUrl: "",
    models: [{ id: "kimi-k2-0711-preview", label: "Kimi K2（订阅）", contextWindow: 131072 }],
    defaultModel: "kimi-k2-0711-preview",
  },
  {
    name: "OpenRouter",
    wire: "openai" as const,
    baseUrl: "https://openrouter.ai/api/v1",
    models: [],
    defaultModel: "",
  },
  {
    name: "Ollama（本地）",
    wire: "openai" as const,
    baseUrl: "http://localhost:11434/v1",
    models: [],
    defaultModel: "",
  },
  {
    name: "OpenAI",
    wire: "openai" as const,
    baseUrl: "https://api.openai.com/v1",
    models: [{ id: "gpt-5-mini", label: "GPT-5 mini", supportsReasoningEffort: true }],
    defaultModel: "gpt-5-mini",
  },
  {
    name: "Anthropic",
    wire: "anthropic" as const,
    baseUrl: "https://api.anthropic.com",
    models: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 200000 }],
    defaultModel: "claude-sonnet-5",
  },
]);

export function loadProviders(): ProviderProfile[] {
  try {
    const parsed = JSON.parse(prefString("providers", "[]")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProviderProfile);
  }
  catch {
    return [];
  }
}

export function saveProviders(profiles: ProviderProfile[]): void {
  setPrefString("providers", JSON.stringify(profiles));
}

export function providerKeyRealm(providerId: string): string {
  return `zotkit-provider:${providerId}`;
}

/** One minimal streamed completion against the profile; resolves with a readable success line. */
export async function testProvider(
  profile: ProviderProfile,
  apiKey: string,
  streamImpl: (options: StreamRequestOptions) => Promise<StreamResult> = streamRequest,
): Promise<string> {
  const model = profile.models.find((candidate) => candidate.id === profile.defaultModel)
    ?? profile.models[0];
  if (!model) throw new Error("请先在模型列表里至少配置一个模型");
  if (!profile.baseUrl) throw new Error("请填写 baseUrl");
  // Anthropic wire arrives in Task 11; until then connectivity tests use the
  // OpenAI wire and anthropic-wire profiles surface a readable notice.
  if (profile.wire === "anthropic") throw new Error("Anthropic 兼容服务的连通性测试将在后续版本提供");
  const wire = new OpenAIWire();
  const request = wire.buildRequest(
    profile.baseUrl,
    apiKey,
    [{ role: "user", text: "ping" }],
    [],
    { model: model.id, effort: null },
  );
  const controller = new AbortController();
  let sawChunk = false;
  const result = await streamImpl({
    url: request.url,
    headers: request.headers,
    body: request.body,
    signal: controller.signal,
    onChunk: () => {
      sawChunk = true;
      controller.abort();
    },
  }).catch((error: unknown) => {
    if ((error as Error)?.name === "AbortError" && sawChunk) {
      return { status: 200, ok: true, errorBody: null } satisfies StreamResult;
    }
    throw error;
  });
  if (!result.ok) throw new Error(connectivityError(result));
  return `连接成功：${profile.name} · ${model.id}`;
}

export function connectivityError(result: StreamResult): string {
  if (result.status === 401) return "API key 无效或已过期（HTTP 401）";
  if (result.status === 402 || result.status === 403) return `余额不足或没有权限（HTTP ${result.status}）`;
  if (result.status === 404) return "模型名或 baseUrl 不存在（HTTP 404）";
  if (result.status === 429) return "请求被限流（HTTP 429），请稍后重试";
  const detail = extractErrorMessage(result.errorBody);
  return detail
    ? `模型服务返回 HTTP ${result.status}：${detail}`
    : `模型服务返回 HTTP ${result.status}`;
}

function extractErrorMessage(errorBody: string | null): string | null {
  if (!errorBody) return null;
  try {
    const parsed = JSON.parse(errorBody) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === "string") return message.slice(0, 200);
  }
  catch { /* not JSON */ }
  return errorBody.slice(0, 200);
}

function isProviderProfile(value: unknown): value is ProviderProfile {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.name === "string"
    && (record.wire === "openai" || record.wire === "anthropic")
    && typeof record.baseUrl === "string"
    && Array.isArray(record.models)
    && typeof record.defaultModel === "string";
}
```

- [ ] **Step 5: `prefs.js` 加两行**

```js
pref("extensions.zotkit.backend", "");
pref("extensions.zotkit.providers", "[]");
```

- [ ] **Step 6: 跑测试与回归**

Run: `npx vitest run test/providers.test.ts && npm run check && npx vitest run`
Expected: 全 PASS。(若 `test/build-assets.test.ts` 断言 prefs.js 内容清单,按其现有模式把新 pref 补进断言。)

- [ ] **Step 7: Commit**

```bash
git add src/secrets.ts src/providers.ts prefs.js test/providers.test.ts test/gecko-stubs.ts
git commit -m "feat: provider profiles with Login Manager key storage and presets"
```

---

### Task 5: engine-messages 纯函数层(消息组装 / 截断 / 模型解析)

**Files:**
- Create: `src/engine-messages.ts`
- Test: `test/engine-messages.test.ts`

**Interfaces:**
- Consumes: `WireMessage`(Task 3)、`ProviderProfile/ProviderModel`(Task 4)、`AdditionalContextEntry`(`./protocol`)。
- Produces(Task 6 消费):
  - `DEFAULT_CONTEXT_WINDOW = 131072`、`OUTPUT_TOKEN_RESERVE = 8192`
  - `estimateTokens(text: string): number` → `Math.ceil(text.length / 3)`
  - `EngineHistoryMessage { role: "user" | "assistant"; text: string }`
  - `formatAdditionalContext(additionalContext): string`
  - `buildTurnMessages(input: BuildTurnMessagesInput): WireMessage[]`
  - `engineModelId(providerId, modelId): string` → `engine:<providerId>:<modelId>`
  - `resolveEngineModel(modelId, providers): { provider: ProviderProfile; model: ProviderModel }`

- [ ] **Step 1: 写失败测试 `test/engine-messages.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_WINDOW,
  OUTPUT_TOKEN_RESERVE,
  buildTurnMessages,
  engineModelId,
  estimateTokens,
  resolveEngineModel,
} from "../src/engine-messages";
import type { ProviderProfile } from "../src/providers";

const providers: ProviderProfile[] = [{
  id: "p1",
  name: "DeepSeek",
  wire: "openai",
  baseUrl: "https://api.deepseek.com",
  models: [
    { id: "deepseek-chat", label: "Chat" },
    { id: "deepseek-reasoner", label: "Reasoner" },
  ],
  defaultModel: "deepseek-chat",
}];

describe("estimateTokens", () => {
  it("uses ceil(chars / 3)", () => {
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("buildTurnMessages", () => {
  it("orders system, kept history, then context-wrapped user text", () => {
    const messages = buildTurnMessages({
      developerInstructions: "You are the research assistant.",
      history: [
        { role: "user", text: "第一问" },
        { role: "assistant", text: "第一答" },
      ],
      additionalContext: { "Zotero Reader": { kind: "untrusted", value: "page text" } },
      userText: "第二问",
      contextWindow: DEFAULT_CONTEXT_WINDOW,
    });
    expect(messages[0]).toEqual({ role: "system", text: "You are the research assistant." });
    expect(messages[1]).toEqual({ role: "user", text: "第一问" });
    expect(messages[2]).toEqual({ role: "assistant", text: "第一答" });
    expect(messages[3]!.role).toBe("user");
    expect(messages[3]!.text).toContain("[Zotero Reader]");
    expect(messages[3]!.text).toContain("page text");
    expect(messages[3]!.text.endsWith("第二问")).toBe(true);
  });

  it("drops oldest pairs when over budget and never splits a pair", () => {
    const bigText = "x".repeat(3 * 1000);
    const history = [
      { role: "user" as const, text: `老:${bigText}` },
      { role: "assistant" as const, text: `老答:${bigText}` },
      { role: "user" as const, text: "新问" },
      { role: "assistant" as const, text: "新答" },
    ];
    const contextWindow = OUTPUT_TOKEN_RESERVE + estimateTokens("current") + 500;
    const messages = buildTurnMessages({
      developerInstructions: null,
      history,
      additionalContext: null,
      userText: "current",
      contextWindow,
    });
    const texts = messages.map((message) => message.text);
    expect(texts).toContain("新问");
    expect(texts).toContain("新答");
    expect(texts.some((text) => text.startsWith("老:"))).toBe(false);
    expect(texts.some((text) => text.startsWith("老答:"))).toBe(false);
    const firstHistory = messages.find((message) => message.text !== "current");
    expect(firstHistory?.role).toBe("user");
  });
});

describe("resolveEngineModel", () => {
  it("resolves the default model when modelId is null", () => {
    const resolved = resolveEngineModel(null, providers);
    expect(resolved.model.id).toBe("deepseek-chat");
  });

  it("parses engine:<provider>:<model> ids", () => {
    const resolved = resolveEngineModel(engineModelId("p1", "deepseek-reasoner"), providers);
    expect(resolved.provider.id).toBe("p1");
    expect(resolved.model.id).toBe("deepseek-reasoner");
  });

  it("throws readable errors", () => {
    expect(() => resolveEngineModel(null, [])).toThrow(/尚未配置任何模型服务/);
    expect(() => resolveEngineModel("engine:nope:m", providers)).toThrow(/找不到对应的模型服务/);
    expect(() => resolveEngineModel("engine:p1:nope", providers)).toThrow(/不在.*模型列表/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/engine-messages.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写 `src/engine-messages.ts`**

```ts
import type { AdditionalContextEntry } from "./protocol";
import type { WireMessage } from "./wire";
import type { ProviderModel, ProviderProfile } from "./providers";

export const DEFAULT_CONTEXT_WINDOW = 131072;
export const OUTPUT_TOKEN_RESERVE = 8192;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface EngineHistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export interface BuildTurnMessagesInput {
  developerInstructions: string | null;
  history: EngineHistoryMessage[];
  additionalContext: Record<string, AdditionalContextEntry> | null | undefined;
  userText: string;
  contextWindow: number;
}

export function formatAdditionalContext(
  additionalContext: Record<string, AdditionalContextEntry> | null | undefined,
): string {
  if (!additionalContext) return "";
  return Object.entries(additionalContext)
    .map(([name, entry]) => `[${name}]\n${entry.value}`)
    .join("\n\n");
}

/**
 * Assembles the wire messages for one engine turn. The per-turn Reader
 * attachment is ephemeral (rebuilt fresh every turn, exactly like the codex
 * path), so history keeps only the raw user/assistant texts. Over budget,
 * whole user/assistant pairs drop oldest-first; system and the current user
 * message are never dropped.
 */
export function buildTurnMessages(input: BuildTurnMessagesInput): WireMessage[] {
  const system: WireMessage | null = input.developerInstructions
    ? { role: "system", text: input.developerInstructions }
    : null;
  const contextBlock = formatAdditionalContext(input.additionalContext);
  const currentText = contextBlock ? `${contextBlock}\n\n${input.userText}` : input.userText;
  const current: WireMessage = { role: "user", text: currentText };
  const budget = Math.max(
    0,
    input.contextWindow
      - OUTPUT_TOKEN_RESERVE
      - estimateTokens(system?.text ?? "")
      - estimateTokens(currentText),
  );
  const kept: WireMessage[] = [];
  let used = 0;
  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    const message = input.history[index]!;
    const cost = estimateTokens(message.text);
    if (used + cost > budget) break;
    used += cost;
    kept.unshift({ role: message.role, text: message.text });
  }
  while (kept.length && kept[0]!.role === "assistant") kept.shift();
  return [...(system ? [system] : []), ...kept, current];
}

export function engineModelId(providerId: string, modelId: string): string {
  return `engine:${providerId}:${modelId}`;
}

export interface EngineModelRef {
  provider: ProviderProfile;
  model: ProviderModel;
}

export function resolveEngineModel(
  modelId: string | null | undefined,
  providers: ProviderProfile[],
): EngineModelRef {
  if (!providers.length) throw new Error("尚未配置任何模型服务，请在设置中添加");
  if (!modelId) {
    const provider = providers[0]!;
    const model = provider.models.find((candidate) => candidate.id === provider.defaultModel)
      ?? provider.models[0];
    if (!model) throw new Error(`模型服务 ${provider.name} 没有配置模型`);
    return { provider, model };
  }
  const match = /^engine:([^:]+):(.+)$/.exec(modelId);
  if (!match) throw new Error(`无法识别的引擎模型：${modelId}`);
  const provider = providers.find((candidate) => candidate.id === match[1]);
  if (!provider) throw new Error("找不到对应的模型服务，请检查设置");
  const model = provider.models.find((candidate) => candidate.id === match[2]);
  if (!model) throw new Error(`模型 ${match[2]} 不在 ${provider.name} 的模型列表里`);
  return { provider, model };
}
```

- [ ] **Step 4: 跑测试与回归**

Run: `npx vitest run test/engine-messages.test.ts && npm run check`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/engine-messages.ts test/engine-messages.test.ts
git commit -m "feat: engine message assembly with pair-safe truncation"
```

---

### Task 6: EngineClient(agent loop + 通知合成 + 转录持久化)

**Files:**
- Create: `src/engine-client.ts`
- Test: `test/engine-client.test.ts`

**Interfaces:**
- Consumes: `AgentClient/ENGINE_CAPABILITIES`(Task 1)、`streamRequest`(Task 2)、`WireAdapter` 家族(Task 3)、`OpenAIWire`、`ProviderProfile/connectivityError`(Task 4)、`buildTurnMessages/resolveEngineModel/engineModelId/DEFAULT_CONTEXT_WINDOW/EngineHistoryMessage`(Task 5)、`ThreadStore` 与协议类型(`./codex-app-server`)。
- Produces(Task 7 消费): `class EngineClient implements AgentClient`、`EngineClientOptions`、`EngineTranscriptStorage`、实例方法 `importThread(name, messages): Promise<string>`。
- **通知合成契约**(喂 `store.applyNotification` 后再转发 `onNotification`,与 codex 客户端次序一致):
  - 轮开始: `turn/started` `{threadId, turn:{id, threadId, status:"inProgress", items:[]}}`
  - 用户消息: `item/completed` `{threadId, turnId, item:{id:"<turnId>:user", type:"userMessage", content:[{type:"text", text}]}, completedAtMs}`
  - 助手流式: `item/started`(`{id:"<turnId>:assistant:<n>", type:"agentMessage", text:""}`)→ 多次 `item/agentMessage/delta` `{threadId, turnId, itemId, delta}` → `item/completed`(全文)
  - 工具调用: `item/started` + `item/completed` `{item:{id:"<turnId>:tool:<n>:<i>", type:"dynamicToolCall", tool, arguments, progress:[结果预览]}}`
  - 成功: `turn/completed` `{threadId, turn:{id, threadId, status:"completed"}}`
  - 失败: 先 `error` `{threadId, turnId, error:{message}, willRetry:false}` 再 `turn/failed` `{threadId, turnId, turn:{id, threadId}, error:{message}}`——`turn/failed` 是 `CodexService` 里 utility waiter 的 reject 信号,**顺序与字段名不可改**。
  - 中断(abort): 不发 error;已流出的半截文本并入历史,收尾 `item/completed` + `turn/completed`。

- [ ] **Step 1: 写失败测试 `test/engine-client.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { installGeckoStubs } from "./gecko-stubs";

installGeckoStubs();

import { EngineClient, type EngineTranscriptStorage } from "../src/engine-client";
import { ThreadStore } from "../src/codex-app-server";
import type { RpcNotification } from "../src/protocol";
import type { WireAdapter, WireEvent, WireParser } from "../src/wire";
import type { ProviderProfile } from "../src/providers";

const provider: ProviderProfile = {
  id: "p1",
  name: "DeepSeek",
  wire: "openai",
  baseUrl: "https://api.deepseek.com",
  models: [{ id: "deepseek-chat", label: "Chat" }],
  defaultModel: "deepseek-chat",
};

/** Scripted adapter: element N of `script` is the WireEvent[] stream run N produces. */
function scriptedWire(script: WireEvent[][]): WireAdapter {
  let run = 0;
  return {
    buildRequest: (baseUrl, apiKey, messages) => ({
      url: `${baseUrl}/chat/completions`,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ messages }),
    }),
    createParser(): WireParser {
      const events = script[Math.min(run, script.length - 1)]!;
      run += 1;
      return { push: () => events, end: () => [] };
    },
  };
}

function memoryStorage(): EngineTranscriptStorage & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: async (threadId) => files.get(threadId) ?? null,
    write: async (threadId, content) => { files.set(threadId, content); },
  };
}

type EngineOptions = ConstructorParameters<typeof EngineClient>[0];

function makeClient(script: WireEvent[][], overrides: Partial<EngineOptions> = {}) {
  const store = new ThreadStore();
  const notifications: RpcNotification[] = [];
  const storage = memoryStorage();
  const client = new EngineClient({
    store,
    providers: () => [provider],
    readKey: async () => "sk-test",
    onNotification: (notification) => notifications.push(notification),
    streamImpl: async (options) => {
      options.onChunk("scripted");
      return { status: 200, ok: true, errorBody: null };
    },
    wireAdapters: { openai: scriptedWire(script) },
    storage,
    ...overrides,
  });
  return { client, store, notifications, storage };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 25; index += 1) await Promise.resolve();
}

describe("EngineClient", () => {
  it("streams a text turn through the codex notification vocabulary", async () => {
    const { client, store, notifications, storage } = makeClient([[
      { type: "textDelta", delta: "你" },
      { type: "textDelta", delta: "好" },
      { type: "stop", reason: "end" },
    ]]);
    const thread = await client.threadStart({});
    await client.turnStart({
      threadId: thread.thread.id,
      input: [{ type: "text", text: "问题", text_elements: [] }],
      model: null,
      effort: "medium",
    });
    await settle();
    const methods = notifications.map((notification) => notification.method);
    expect(methods).toContain("turn/started");
    expect(methods).toContain("item/agentMessage/delta");
    expect(methods).toContain("turn/completed");
    const stored = store.getThread(thread.thread.id)!;
    const items = stored.turns[0]!.items;
    expect(items.some((item) => item.type === "userMessage")).toBe(true);
    expect(items.find((item) => item.type === "agentMessage")?.text).toBe("你好");
    expect(storage.files.get(thread.thread.id)).toContain("你好");
  });

  it("runs the dynamic tool loop and feeds results back", async () => {
    const dynamicToolCall = vi.fn().mockResolvedValue({
      success: true,
      contentItems: [{ type: "inputText", text: "page three text" }],
    });
    const { client, store } = makeClient([
      [
        { type: "toolCalls", calls: [{ id: "c1", name: "zotero_page", argumentsJson: "{\"page\":3}" }] },
        { type: "stop", reason: "toolCalls" },
      ],
      [
        { type: "textDelta", delta: "答案" },
        { type: "stop", reason: "end" },
      ],
    ], { handlers: { dynamicToolCall } });
    const thread = await client.threadStart({
      dynamicTools: [{ type: "function", name: "zotero_page", description: "d", inputSchema: {} }],
    });
    await client.turnStart({
      threadId: thread.thread.id,
      input: [{ type: "text", text: "第三页说了什么", text_elements: [] }],
      model: "engine:p1:deepseek-chat",
      effort: "medium",
    });
    await settle();
    expect(dynamicToolCall).toHaveBeenCalledWith(expect.objectContaining({
      tool: "zotero_page",
      arguments: { page: 3 },
    }));
    const items = store.getThread(thread.thread.id)!.turns[0]!.items;
    expect(items.some((item) => item.type === "dynamicToolCall")).toBe(true);
    const agentTexts = items.filter((item) => item.type === "agentMessage");
    expect(agentTexts[agentTexts.length - 1]?.text).toBe("答案");
  });

  it("fails the turn with turn/failed on HTTP errors", async () => {
    const { client, notifications } = makeClient([[]], {
      streamImpl: async () => ({ status: 401, ok: false, errorBody: null }),
    });
    const thread = await client.threadStart({});
    await client.turnStart({
      threadId: thread.thread.id,
      input: [{ type: "text", text: "问", text_elements: [] }],
      model: null,
      effort: "medium",
    });
    await settle();
    const failed = notifications.find((notification) => notification.method === "turn/failed");
    expect(failed).toBeTruthy();
    expect(JSON.stringify(failed!.params)).toContain("401");
    expect(notifications.some((notification) => notification.method === "turn/completed")).toBe(false);
  });

  it("caps the tool loop at 8 iterations", async () => {
    const dynamicToolCall = vi.fn().mockResolvedValue({
      success: true,
      contentItems: [{ type: "inputText", text: "{}" }],
    });
    const { client, notifications } = makeClient([[
      { type: "toolCalls", calls: [{ id: "c", name: "t", argumentsJson: "{}" }] },
      { type: "stop", reason: "toolCalls" },
    ]], { handlers: { dynamicToolCall } });
    const thread = await client.threadStart({
      dynamicTools: [{ type: "function", name: "t", description: "d", inputSchema: {} }],
    });
    await client.turnStart({
      threadId: thread.thread.id,
      input: [{ type: "text", text: "q", text_elements: [] }],
      model: null,
      effort: "medium",
    });
    await settle();
    expect(dynamicToolCall).toHaveBeenCalledTimes(7);
    const failed = notifications.find((notification) => notification.method === "turn/failed");
    expect(JSON.stringify(failed!.params)).toContain("工具调用次数超限");
  });

  it("resumes a persisted thread into the store", async () => {
    const storage = memoryStorage();
    const first = makeClient([[
      { type: "textDelta", delta: "answer" },
      { type: "stop", reason: "end" },
    ]], { storage });
    const thread = await first.client.threadStart({});
    await first.client.turnStart({
      threadId: thread.thread.id,
      input: [{ type: "text", text: "q1", text_elements: [] }],
      model: null,
      effort: "medium",
    });
    await settle();
    const second = makeClient([[]], { storage });
    const resumed = await second.client.threadResume({ threadId: thread.thread.id });
    expect(resumed.thread.id).toBe(thread.thread.id);
    const stored = second.store.getThread(thread.thread.id)!;
    expect(stored.turns.length).toBe(1);
    expect(stored.turns[0]!.items.find((item) => item.type === "agentMessage")?.text).toBe("answer");
  });

  it("imports migrated history as completed turns", async () => {
    const { client, store } = makeClient([[]]);
    const threadId = await client.importThread("迁移标题", [
      { role: "user", text: "老问题" },
      { role: "assistant", text: "老回答" },
    ]);
    const stored = store.getThread(threadId)!;
    expect(stored.turns.length).toBe(1);
    expect(stored.turns[0]!.items.map((item) => item.type)).toEqual(["userMessage", "agentMessage"]);
  });
});
```

说明:8 次上限用例里,第 8 次迭代在流返回 toolCalls 后直接判超限——工具执行器只会被调用 7 次(第 8 次迭代不再执行工具,直接失败)。若实现选择"第 8 次照常执行工具、第 9 次判失败",把断言改成 `toHaveBeenCalledTimes(8)` 并在实现里保持一致;两种取一,测试与实现必须同一语义,推荐前者(先到上限先止损)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/engine-client.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写 `src/engine-client.ts`**

```ts
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  ModelListResponse,
  RpcNotification,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
} from "./codex-app-server";
import { ThreadStore } from "./codex-app-server";
import { ENGINE_CAPABILITIES, type AgentClient } from "./agent-client";
import { streamRequest } from "./http-stream";
import { OpenAIWire } from "./wire-openai";
import type { WireAdapter, WireMessage, WireToolCall, WireToolSpec } from "./wire";
import type { ProviderProfile } from "./providers";
import { connectivityError } from "./providers";
import {
  DEFAULT_CONTEXT_WINDOW,
  buildTurnMessages,
  engineModelId,
  resolveEngineModel,
  type EngineHistoryMessage,
} from "./engine-messages";
import { profilePath, randomID } from "./platform";

export interface EngineTranscriptStorage {
  read(threadId: string): Promise<string | null>;
  write(threadId: string, content: string): Promise<void>;
}

export interface EngineClientOptions {
  store: ThreadStore;
  providers(): ProviderProfile[];
  readKey(providerId: string): Promise<string | null>;
  handlers?: {
    dynamicToolCall?: (params: DynamicToolCallParams) =>
      DynamicToolCallResponse | Promise<DynamicToolCallResponse>;
  };
  onNotification?: (notification: RpcNotification) => void;
  streamImpl?: typeof streamRequest;
  wireAdapters?: Partial<Record<"openai" | "anthropic", WireAdapter>>;
  storage?: EngineTranscriptStorage;
  now?: () => number;
}

const MAX_TOOL_ITERATIONS = 8;

interface EngineThreadState {
  id: string;
  name: string | null;
  createdAt: string;
  history: EngineHistoryMessage[];
  dynamicTools: WireToolSpec[];
  developerInstructions: string | null;
  turnCount: number;
  activeAbort: AbortController | null;
}

class EngineTurnError extends Error {}

/**
 * In-process AgentClient: drives OpenAI/Anthropic-compatible endpoints
 * directly and synthesizes the same ThreadStore notifications the codex
 * app-server client produces, so every downstream consumer (entries
 * rendering, utility-turn waiters, paper trail, noting) works unchanged.
 */
export class EngineClient implements AgentClient {
  readonly agentCapabilities = ENGINE_CAPABILITIES;

  private readonly store: ThreadStore;
  private readonly options: EngineClientOptions;
  private readonly threads = new Map<string, EngineThreadState>();
  private readonly storage: EngineTranscriptStorage;
  private readonly stream: typeof streamRequest;

  constructor(options: EngineClientOptions) {
    this.options = options;
    this.store = options.store;
    this.storage = options.storage ?? defaultStorage();
    this.stream = options.streamImpl ?? streamRequest;
  }

  connect(): Promise<unknown> {
    return Promise.resolve({});
  }

  close(): void {
    for (const thread of this.threads.values()) {
      thread.activeAbort?.abort();
      thread.activeAbort = null;
    }
  }

  accountRead(): Promise<{ account: Record<string, unknown> | null; requiresOpenaiAuth: boolean }> {
    return Promise.resolve({ account: null, requiresOpenaiAuth: false });
  }

  modelList(): Promise<ModelListResponse> {
    const providers = this.options.providers();
    const data = providers.flatMap((provider, providerIndex) =>
      provider.models.map((model) => ({
        id: engineModelId(provider.id, model.id),
        displayName: `${provider.name} · ${model.label}`,
        supportedReasoningEfforts: model.supportsReasoningEffort
          ? [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }]
          : [],
        isDefault: providerIndex === 0 && model.id === provider.defaultModel,
      })),
    );
    return Promise.resolve({ data } as ModelListResponse);
  }

  async threadStart(params: ThreadStartParams = {}): Promise<ThreadStartResponse> {
    const id = randomID("eng").slice(0, 48);
    const thread: EngineThreadState = {
      id,
      name: null,
      createdAt: new Date().toISOString(),
      history: [],
      dynamicTools: normalizeToolSpecs(params.dynamicTools),
      developerInstructions: typeof params.developerInstructions === "string"
        ? params.developerInstructions
        : null,
      turnCount: 0,
      activeAbort: null,
    };
    this.threads.set(id, thread);
    this.store.ingestThread({ id, turns: [] });
    await this.persist(thread);
    return { thread: { id } } as ThreadStartResponse;
  }

  async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    const thread = this.threads.get(params.threadId) ?? await this.loadThread(params.threadId);
    if (!thread) throw new Error("找不到这个引擎会话");
    const tools = normalizeToolSpecs(params.dynamicTools);
    if (tools.length) thread.dynamicTools = tools;
    if (typeof params.developerInstructions === "string") {
      thread.developerInstructions = params.developerInstructions;
    }
    this.ingestHistory(thread);
    return { thread: { id: thread.id } } as ThreadResumeResponse;
  }

  async threadRead(threadId: string): Promise<ThreadReadResponse> {
    const thread = this.threads.get(threadId) ?? await this.loadThread(threadId);
    if (!thread) throw new Error("找不到这个引擎会话");
    this.ingestHistory(thread);
    return { thread: this.store.getThread(threadId) } as unknown as ThreadReadResponse;
  }

  async threadSetName(threadId: string, name: string): Promise<Record<string, never>> {
    const thread = this.threads.get(threadId) ?? await this.loadThread(threadId);
    if (thread) {
      thread.name = name;
      this.store.setThreadName(threadId, name);
      await this.persist(thread);
    }
    return {};
  }

  async turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
    const thread = this.threads.get(params.threadId) ?? await this.loadThread(params.threadId);
    if (!thread) throw new Error("找不到这个引擎会话");
    if (thread.activeAbort) throw new Error("当前回答尚未结束");
    const userText = extractUserText(params.input);
    const turnId = `${thread.id}:turn:${thread.turnCount + 1}`;
    const abort = new AbortController();
    thread.activeAbort = abort;
    void this.runTurn(thread, turnId, userText, params, abort)
      .catch(() => { /* runTurn reports via notifications */ })
      .finally(() => {
        if (thread.activeAbort === abort) thread.activeAbort = null;
      });
    return { turn: { id: turnId } } as TurnStartResponse;
  }

  turnInterrupt(params: TurnInterruptParams): Promise<Record<string, never>> {
    this.threads.get(params.threadId)?.activeAbort?.abort();
    return Promise.resolve({});
  }

  /** Seeds a new thread with migrated history (backend switch carry-over). */
  async importThread(name: string, messages: EngineHistoryMessage[]): Promise<string> {
    const started = await this.threadStart({});
    const thread = this.threads.get(started.thread.id)!;
    thread.name = name;
    thread.history = messages.filter((message) => message.text.trim());
    thread.turnCount = Math.ceil(thread.history.length / 2);
    this.ingestHistory(thread);
    this.store.setThreadName(thread.id, name);
    await this.persist(thread);
    return thread.id;
  }

  private async runTurn(
    thread: EngineThreadState,
    turnId: string,
    userText: string,
    params: TurnStartParams,
    abort: AbortController,
  ): Promise<void> {
    const threadId = thread.id;
    this.notify("turn/started", {
      threadId,
      turn: { id: turnId, threadId, status: "inProgress", items: [] },
    });
    this.notify("item/completed", {
      threadId,
      turnId,
      item: {
        id: `${turnId}:user`,
        type: "userMessage",
        content: [{ type: "text", text: userText }],
      },
      completedAtMs: this.now(),
    });
    let finalText = "";
    try {
      const providers = this.options.providers();
      const { provider, model } = resolveEngineModel(params.model ?? null, providers);
      const apiKey = await this.options.readKey(provider.id);
      if (!apiKey) {
        throw new EngineTurnError(`模型服务 ${provider.name} 还没有保存 API key，请在设置中填写`);
      }
      const wire = this.wireFor(provider);
      const baseMessages = buildTurnMessages({
        developerInstructions: thread.developerInstructions,
        history: thread.history,
        additionalContext: params.additionalContext,
        userText,
        contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      });
      const effort = model.supportsReasoningEffort && typeof params.effort === "string"
        ? params.effort
        : null;
      const exchange: WireMessage[] = [];
      for (let iteration = 1; ; iteration += 1) {
        const itemId = `${turnId}:assistant:${iteration}`;
        this.notify("item/started", {
          threadId,
          turnId,
          item: { id: itemId, type: "agentMessage", text: "" },
          startedAtMs: this.now(),
        });
        const request = wire.buildRequest(
          provider.baseUrl,
          apiKey,
          [...baseMessages, ...exchange],
          thread.dynamicTools,
          { model: model.id, effort },
        );
        const parser = wire.createParser();
        let text = "";
        let toolCalls: WireToolCall[] | null = null;
        let streamError: string | null = null;
        const handleEvents = (events: ReturnType<typeof parser.push>) => {
          for (const event of events) {
            if (event.type === "textDelta") {
              text += event.delta;
              finalText = text;
              this.notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: event.delta });
            }
            else if (event.type === "toolCalls") toolCalls = event.calls;
            else if (event.type === "error") streamError = event.message;
          }
        };
        const result = await this.stream({
          url: request.url,
          headers: request.headers,
          body: request.body,
          signal: abort.signal,
          onChunk: (chunk) => handleEvents(parser.push(chunk)),
        });
        handleEvents(parser.end());
        if (streamError) throw new EngineTurnError(streamError);
        if (!result.ok) throw new EngineTurnError(connectivityError(result));
        this.notify("item/completed", {
          threadId,
          turnId,
          item: { id: itemId, type: "agentMessage", text },
          completedAtMs: this.now(),
        });
        const calls = toolCalls as WireToolCall[] | null;
        if (!calls || !calls.length) {
          finalText = text;
          break;
        }
        if (iteration >= MAX_TOOL_ITERATIONS) {
          throw new EngineTurnError(`工具调用次数超限（${MAX_TOOL_ITERATIONS} 次），已停止本轮`);
        }
        exchange.push({ role: "assistant", text, toolCalls: calls });
        for (const [position, call] of calls.entries()) {
          const resultText = await this.invokeTool(thread, turnId, iteration, position, call);
          exchange.push({ role: "tool", text: resultText, toolCallId: call.id });
        }
      }
      thread.history = [
        ...thread.history,
        { role: "user", text: userText },
        { role: "assistant", text: finalText },
      ];
      thread.turnCount += 1;
      await this.persist(thread);
      this.notify("turn/completed", {
        threadId,
        turn: { id: turnId, threadId, status: "completed" },
      });
    }
    catch (error) {
      if ((error as Error)?.name === "AbortError") {
        thread.history = [
          ...thread.history,
          { role: "user", text: userText },
          { role: "assistant", text: finalText },
        ];
        thread.turnCount += 1;
        await this.persist(thread);
        this.notify("turn/completed", {
          threadId,
          turn: { id: turnId, threadId, status: "completed" },
        });
        return;
      }
      const message = error instanceof Error && error.message
        ? error.message
        : "模型服务调用失败，请重试";
      this.notify("error", { threadId, turnId, error: { message }, willRetry: false });
      this.notify("turn/failed", {
        threadId,
        turnId,
        turn: { id: turnId, threadId },
        error: { message },
      });
    }
  }

  private async invokeTool(
    thread: EngineThreadState,
    turnId: string,
    iteration: number,
    position: number,
    call: WireToolCall,
  ): Promise<string> {
    const threadId = thread.id;
    const itemId = `${turnId}:tool:${iteration}:${position}`;
    let argumentsValue: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(call.argumentsJson || "{}") as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        argumentsValue = parsed as Record<string, unknown>;
      }
    }
    catch { /* malformed arguments fall through as {} */ }
    this.notify("item/started", {
      threadId,
      turnId,
      item: { id: itemId, type: "dynamicToolCall", tool: call.name, arguments: argumentsValue },
      startedAtMs: this.now(),
    });
    const handler = this.options.handlers?.dynamicToolCall;
    const response: DynamicToolCallResponse = handler
      ? await handler({
          threadId,
          turnId,
          callId: call.id,
          namespace: null,
          tool: call.name,
          arguments: argumentsValue,
        })
      : { success: false, contentItems: [{ type: "inputText", text: "没有可用的工具执行器" }] };
    const resultText = response.contentItems
      .map((item) => (item.type === "inputText" ? item.text : ""))
      .filter(Boolean)
      .join("\n") || "（无输出）";
    this.notify("item/completed", {
      threadId,
      turnId,
      item: {
        id: itemId,
        type: "dynamicToolCall",
        tool: call.name,
        arguments: argumentsValue,
        progress: [resultText.slice(0, 2000)],
      },
      completedAtMs: this.now(),
    });
    return resultText;
  }

  private wireFor(provider: ProviderProfile): WireAdapter {
    const custom = this.options.wireAdapters?.[provider.wire];
    if (custom) return custom;
    if (provider.wire === "openai") return new OpenAIWire();
    throw new EngineTurnError("Anthropic 兼容接入将在后续版本提供");
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const notification = { method, params } as RpcNotification;
    this.store.applyNotification(notification);
    this.options.onNotification?.(notification);
  }

  private ingestHistory(thread: EngineThreadState): void {
    const turns = [];
    for (let index = 0; index < thread.history.length; index += 2) {
      const user = thread.history[index];
      const assistant = thread.history[index + 1];
      const turnId = `${thread.id}:turn:${index / 2 + 1}`;
      const items = [];
      if (user) {
        items.push({
          id: `${turnId}:user`,
          type: "userMessage",
          content: [{ type: "text", text: user.text }],
        });
      }
      if (assistant) {
        items.push({ id: `${turnId}:assistant:1`, type: "agentMessage", text: assistant.text });
      }
      turns.push({ id: turnId, status: "completed", items });
    }
    this.store.replaceThread({ id: thread.id, name: thread.name, turns } as never);
  }

  private async loadThread(threadId: string): Promise<EngineThreadState | null> {
    const content = await this.storage.read(threadId).catch(() => null);
    if (!content) return null;
    const thread: EngineThreadState = {
      id: threadId,
      name: null,
      createdAt: new Date().toISOString(),
      history: [],
      dynamicTools: [],
      developerInstructions: null,
      turnCount: 0,
      activeAbort: null,
    };
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as Record<string, unknown>;
        if (record.kind === "meta") {
          if (typeof record.name === "string") thread.name = record.name;
          if (typeof record.createdAt === "string") thread.createdAt = record.createdAt;
        }
        else if (
          record.kind === "message"
          && (record.role === "user" || record.role === "assistant")
          && typeof record.text === "string"
        ) {
          thread.history.push({ role: record.role, text: record.text });
        }
      }
      catch { /* skip corrupt lines */ }
    }
    thread.turnCount = Math.ceil(thread.history.length / 2);
    this.threads.set(threadId, thread);
    return thread;
  }

  private async persist(thread: EngineThreadState): Promise<void> {
    const lines = [
      JSON.stringify({
        kind: "meta",
        version: 1,
        name: thread.name,
        createdAt: thread.createdAt,
      }),
      ...thread.history.map((message) => JSON.stringify({
        kind: "message",
        role: message.role,
        text: message.text,
      })),
    ];
    await this.storage.write(thread.id, `${lines.join("\n")}\n`).catch(() => {
      // Persistence is best-effort: a failed write must not fail the turn.
    });
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}

function normalizeToolSpecs(raw: unknown): WireToolSpec[] {
  if (!Array.isArray(raw)) return [];
  const specs: WireToolSpec[] = [];
  for (const value of raw) {
    const record = value as Record<string, unknown>;
    if (typeof record?.name !== "string") continue;
    specs.push({
      name: record.name,
      description: typeof record.description === "string" ? record.description : "",
      inputSchema: (record.inputSchema && typeof record.inputSchema === "object")
        ? record.inputSchema as Record<string, unknown>
        : { type: "object" },
    });
  }
  return specs;
}

function extractUserText(input: unknown): string {
  if (!Array.isArray(input)) return "";
  return input
    .map((item) => {
      const record = item as Record<string, unknown>;
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function defaultStorage(): EngineTranscriptStorage {
  const pathFor = (threadId: string) => profilePath("engine-threads", `${threadId}.jsonl`);
  return {
    async read(threadId) {
      try {
        return await IOUtils.readUTF8(pathFor(threadId));
      }
      catch {
        return null;
      }
    },
    async write(threadId, content) {
      await IOUtils.makeDirectory(profilePath("engine-threads"), {
        createAncestors: true,
        ignoreExisting: true,
        permissions: 0o700,
      });
      await IOUtils.writeUTF8(pathFor(threadId), content, { tmpPath: `${pathFor(threadId)}.tmp` });
    },
  };
}
```

实现提示:若 `ThreadStartParams`/`TurnStartParams`/`DynamicToolCallParams` 的字段名与 `src/protocol.ts` 定义有出入,以 `protocol.ts` 为准调整;`IOUtils` 在测试环境不存在——默认 storage 只在 Zotero 运行时被构造(测试始终注入 memory storage),不要在模块顶层触碰 `IOUtils`。

- [ ] **Step 4: 跑测试与回归**

Run: `npx vitest run test/engine-client.test.ts && npm run check && npx vitest run`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/engine-client.ts test/engine-client.test.ts
git commit -m "feat: EngineClient agent loop with codex-compatible notifications"
```

---

### Task 7: CodexService 双后端(引擎启动 / 会话绑定 / codex→引擎历史迁移)

**Files:**
- Modify: `src/codex-service.ts`
- Test: `test/backend-switch.test.ts`(新)

**Interfaces:**
- Consumes: `EngineClient/EngineClientOptions`(Task 6)、`loadProviders/providerKeyRealm`(Task 4)、`readSecret`(Task 4)、`EngineHistoryMessage`(Task 5)、`prefString/setPrefString`(`./platform`)。
- Produces(Task 9/10 消费):
  - `CodexServiceState.backend: "codex" | "engine"`
  - `switchBackend(target: "codex" | "engine", carryHistory: boolean): Promise<void>`
  - `accountLabel()` 引擎分支(`内置引擎 · N 个模型服务` / `内置引擎 · 未配置模型服务`)
  - `SessionRecord.backend?: "codex" | "engine"`(会话按后端隔离)
- 硬性验收:引擎路径**绝不**调用 `findExecutable`/`bridge.start`/`bridge.spawnPipe`。

- [ ] **Step 1: 写失败测试 `test/backend-switch.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { CodexService } from "../src/codex-service";
import { setPrefString } from "../src/platform";
import { installGeckoStubs } from "./gecko-stubs";

installGeckoStubs();

import type { NativeBridge } from "../src/native-bridge";
import type { ReaderContext, ReaderContextService } from "../src/reader-context";
import type { AgentClient } from "../src/agent-client";
import { ENGINE_CAPABILITIES } from "../src/agent-client";
import { EngineClient } from "../src/engine-client";
import { ThreadStore } from "../src/codex-app-server";

function paperContext(): ReaderContext {
  return {
    schemaVersion: 1,
    capturedAt: "2026-07-26T00:00:00.000Z",
    attachment: {
      id: 7, key: "ATTACH", libraryID: 1, title: "Paper PDF",
      filename: "paper.pdf", creators: [], tags: [],
    },
    parent: { id: 6, key: "PARENT", libraryID: 1, title: "A Paper", creators: [], tags: [] },
    pdfPath: "/papers/paper.pdf",
    page: { pageIndex: 2, pageNumber: 3, pageLabel: "3", text: "t", source: "pdfjs", warnings: [] },
    selection: null,
    fullText: { source: "indexed-fulltext", characters: 10 },
    workspace: {
      root: "/profile/papers/1-ATTACH",
      context: "/profile/papers/1-ATTACH/context.json",
      currentPage: "/profile/papers/1-ATTACH/current-page.md",
      currentSelection: "/profile/papers/1-ATTACH/current-selection.md",
      pdfText: "/profile/papers/1-ATTACH/current-pdf-text.txt",
      agents: "/profile/papers/1-ATTACH/AGENTS.md",
      claude: "/profile/papers/1-ATTACH/CLAUDE.md",
    },
    warnings: [],
  } as unknown as ReaderContext;
}

/** Engine-shaped fake that satisfies every method the service touches. */
function fakeEngine() {
  let nextThread = 0;
  const client = {
    agentCapabilities: ENGINE_CAPABILITIES,
    connect: vi.fn().mockResolvedValue({}),
    close: vi.fn(),
    accountRead: vi.fn().mockResolvedValue({ account: null, requiresOpenaiAuth: false }),
    modelList: vi.fn().mockResolvedValue({ data: [] }),
    threadStart: vi.fn().mockImplementation(async () => ({ thread: { id: `eng-${++nextThread}` } })),
    threadResume: vi.fn().mockImplementation(async (params: { threadId: string }) => ({ thread: { id: params.threadId } })),
    threadRead: vi.fn().mockResolvedValue({ thread: { id: "eng-1", turns: [] } }),
    threadSetName: vi.fn().mockResolvedValue({}),
    turnStart: vi.fn().mockResolvedValue({ turn: { id: "turn-1" } }),
    turnInterrupt: vi.fn().mockResolvedValue({}),
    importThread: vi.fn().mockResolvedValue("eng-imported"),
  };
  Object.setPrototypeOf(client, EngineClient.prototype);
  return client as unknown as AgentClient & { importThread: ReturnType<typeof vi.fn> };
}

function makeService(engine: AgentClient) {
  const callbacks = { onState: vi.fn(), onError: vi.fn() };
  const bridge = {
    start: vi.fn().mockRejectedValue(new Error("bridge must not start for engine backend")),
    spawnPipe: vi.fn(),
    closeSession: vi.fn(),
  } as unknown as NativeBridge;
  const service = new CodexService(
    bridge,
    { tools: [] } as unknown as ReaderContextService,
    "test",
    callbacks,
    null,
    () => engine,
  );
  return { service, callbacks, bridge };
}

describe("engine backend startup", () => {
  it("starts without touching the bridge or codex CLI", async () => {
    setPrefString("backend", "engine");
    const engine = fakeEngine();
    const { service, bridge } = makeService(engine);
    await service.start();
    expect(service.state.backend).toBe("engine");
    expect(service.state.connected).toBe(true);
    expect(service.state.capabilities.supportsAgentMode).toBe(false);
    expect((bridge as any).start).not.toHaveBeenCalled();
    expect((bridge as any).spawnPipe).not.toHaveBeenCalled();
  });
});

describe("backend-scoped sessions", () => {
  it("does not resume a codex-backed record on the engine backend", async () => {
    setPrefString("backend", "engine");
    const engine = fakeEngine();
    const { service } = makeService(engine);
    await service.start();
    (service as any).sessions.papers["1-ATTACH"] = {
      threadId: "codex-old", title: "老会话", workspace: "/w",
      updatedAt: "2026-07-25T00:00:00.000Z", backend: "codex",
    };
    (service as any).saveSessions = vi.fn().mockResolvedValue(undefined);
    await service.setPaper(paperContext());
    expect((engine as any).threadResume).not.toHaveBeenCalled();
    expect((engine as any).threadStart).toHaveBeenCalled();
    expect((service as any).sessions.papers["1-ATTACH"].backend).toBe("engine");
  });
});

describe("switchBackend with history carry-over", () => {
  it("imports codex user/assistant turns into a new engine thread", async () => {
    setPrefString("backend", "codex");
    const engine = fakeEngine();
    const { service } = makeService(engine);
    const internal = service as any;
    internal.sessions = {
      version: 1,
      papers: {
        "1-ATTACH": {
          threadId: "codex-old", title: "论文 A", workspace: "/w",
          updatedAt: "2026-07-25T00:00:00.000Z", backend: "codex",
        },
      },
    };
    internal.activePaperKey = "1-ATTACH";
    internal.activeContext = paperContext();
    internal.saveSessions = vi.fn().mockResolvedValue(undefined);
    internal.loadSessions = vi.fn().mockResolvedValue(undefined);
    service.state.backend = "codex";
    service.state.connected = true;
    service.state.activeThreadId = "codex-old";
    internal.threadPaperKeys.set("codex-old", "1-ATTACH");
    internal.client = { close: vi.fn() };
    service.readThreadTurns = vi.fn().mockResolvedValue([[
      { id: "u1", kind: "user", text: "老问题" },
      { id: "a1", kind: "assistant", text: "老回答" },
      { id: "t1", kind: "tool", text: "工具输出" },
    ]]) as any;
    await service.switchBackend("engine", true);
    expect((engine as any).importThread).toHaveBeenCalledWith("论文 A", [
      { role: "user", text: "老问题" },
      { role: "assistant", text: "老回答" },
    ]);
    expect(service.state.backend).toBe("engine");
    expect(service.state.activeThreadId).toBe("eng-imported");
    expect(internal.sessions.papers["1-ATTACH"].backend).toBe("engine");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/backend-switch.test.ts`
Expected: FAIL(构造函数没有第 6 个参数、`switchBackend` 不存在等)。

- [ ] **Step 3: 改 `src/codex-service.ts`**

按以下清单落实(定位以符号名为准,实施前先读相关方法现状):

1. **导入**:

```ts
import { CODEX_CAPABILITIES, ENGINE_CAPABILITIES, type AgentCapabilities, type AgentClient } from "./agent-client";
import { EngineClient, type EngineClientOptions } from "./engine-client";
import { loadProviders, providerKeyRealm } from "./providers";
import { readSecret } from "./secrets";
import type { EngineHistoryMessage } from "./engine-messages";
```

并在现有 `platform` 导入里补 `prefString, setPrefString`。

2. **状态与类型**:`CodexServiceState` 加 `backend: "codex" | "engine";`,初始化为 `"codex"`;`SessionRecord` 加 `backend?: "codex" | "engine";`。

3. **构造函数**尾部追加可注入工厂(默认真 EngineClient):

```ts
  constructor(
    private readonly bridge: NativeBridge,
    private readonly readerContext: ReaderContextService,
    private readonly version: string,
    private readonly callbacks: CodexServiceCallbacks,
    private agentToolProvider: CodexAgentToolProvider | null = null,
    private readonly engineClientFactory: (options: EngineClientOptions) => AgentClient
      = (options) => new EngineClient(options),
  ) {}
```

4. **启动分流**:现 `startInternal` 更名为 `startCodexInternal`,把开头的 `await this.loadSessions();` 移出;新的 `startInternal`:

```ts
  private async startInternal(): Promise<void> {
    await this.loadSessions();
    const backend = (prefString("backend", "") || "engine") as "codex" | "engine";
    this.state.backend = backend;
    if (backend === "engine") await this.startEngineInternal();
    else await this.startCodexInternal();
  }

  private async startEngineInternal(): Promise<void> {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    if (this.client) {
      this.client.close(1000, "Zotkit reconnecting");
      this.client = null;
    }
    const client = this.engineClientFactory({
      store: this.store,
      providers: () => loadProviders(),
      readKey: (providerId) => readSecret(providerKeyRealm(providerId), providerId),
      handlers: { dynamicToolCall: (params) => this.handleDynamicTool(params) },
      onNotification: (notification) => this.handleNotification(notification),
    });
    await client.connect();
    this.client = client;
    this.state.connected = true;
    this.state.appServerAvailable = true;
    this.state.fallbackReason = null;
    this.state.capabilities = client.agentCapabilities;
    this.unsubscribeStore = this.store.subscribe(() => this.callbacks.onState());
    this.state.account = await client.accountRead({ refreshToken: false });
    await this.refreshModels();
    this.callbacks.onState();
  }
```

`startCodexInternal` 在 `this.client = client;` 之后同样设 `this.state.capabilities = client.agentCapabilities;`(Task 1 已加则确认存在)。

5. **会话按后端隔离**:
   - `newThreadInternal` 写 `this.sessions.papers[paperKey]` 时加 `backend: this.state.backend`。
   - `setPaperInternal` 的 resume 分支条件改为 `if (existing && (existing.backend ?? "codex") === this.state.backend)`。
   - `getThreadOptions()` 的 records 过滤链加 `.filter((record) => (record.backend ?? "codex") === this.state.backend)`。
   - `switchThreadInternal` 的 `records` 同样过滤。
   - `rememberActiveThread` 调用点传入的 record 带 `backend: this.state.backend`(restoreCheckpoint 处)。

6. **accountLabel 引擎分支**(方法开头):

```ts
    if (this.state.backend === "engine") {
      const providers = loadProviders();
      return providers.length
        ? `内置引擎 · ${providers.length} 个模型服务`
        : "内置引擎 · 未配置模型服务";
    }
```

7. **switchBackend**(新公开方法,放在 `interrupt()` 之后):

```ts
  switchBackend(target: "codex" | "engine", carryHistory: boolean): Promise<void> {
    return this.enqueuePaperTransition(() => this.switchBackendInternal(target, carryHistory));
  }

  private async switchBackendInternal(
    target: "codex" | "engine",
    carryHistory: boolean,
  ): Promise<void> {
    if (target === this.state.backend && this.state.connected) return;
    const context = this.activeContext;
    const paperKey = this.activePaperKey;
    let carried: EngineHistoryMessage[] = [];
    let title = "论文对话";
    if (carryHistory && target === "engine" && this.state.activeThreadId && paperKey) {
      const turns = await this.readThreadTurns(this.state.activeThreadId);
      carried = turns.flat()
        .filter((entry) => entry.kind === "user" || entry.kind === "assistant")
        .map((entry) => ({
          role: entry.kind === "user" ? "user" as const : "assistant" as const,
          text: entry.text,
        }))
        .filter((message) => message.text.trim().length > 0);
      title = this.sessions.papers[paperKey]?.title || title;
    }
    this.stop();
    setPrefString("backend", target);
    await this.startInternal();
    this.activeContext = context;
    this.activePaperKey = null;
    if (carried.length && context?.workspace && paperKey && this.client instanceof EngineClient) {
      const threadId = await this.client.importThread(title, carried);
      this.activePaperKey = paperKey;
      this.rememberActiveThread(paperKey, {
        threadId,
        title,
        workspace: context.workspace.root,
        updatedAt: new Date().toISOString(),
        backend: "engine",
      });
      this.state.activeThreadId = threadId;
      this.state.activeTurnId = null;
      this.threadPaperKeys.set(threadId, paperKey);
      await this.saveSessions();
    }
    else if (context) {
      await this.setPaperInternal(context);
    }
    this.callbacks.onState();
  }
```

注意:`readThreadTurns` 在 `this.stop()` **之前**执行(codex 还在线时转录;离线也有 store 兜底);`stop()` 会清 `activeThreadId` 等,所以上下文/paperKey 先行快照。反方向(→codex)`carried` 恒为空,自然走 `setPaperInternal` 新建/恢复。

- [ ] **Step 4: 跑测试与回归**

Run: `npx vitest run test/backend-switch.test.ts && npm run check && npx vitest run`
Expected: 全 PASS(既有 codex-service 测试不受影响——它们直接注入 `internal.client`,不走启动分流)。

- [ ] **Step 5: Commit**

```bash
git add src/codex-service.ts test/backend-switch.test.ts
git commit -m "feat: dual-backend service with engine startup and history migration"
```

---

### Task 8: Provider 设置组件(provider-settings.ts)

**Files:**
- Create: `src/provider-settings.ts`
- Test: `test/provider-settings.test.ts`

**Interfaces:**
- Consumes: `ProviderProfile/ProviderModel/PROVIDER_PRESETS`(Task 4)。
- Produces(Task 10 消费):

```ts
export interface ProviderSettingsState {
  providers: ProviderProfile[];
  keyMask: Record<string, string>;   // providerId → "····1234",无 key 则缺席
  statusText: string | null;         // 测试/保存结果一行字
  busy: boolean;
}
export interface ProviderSettingsCallbacks {
  onSave(profile: ProviderProfile, apiKey: string | null): void; // apiKey null = 不改已存 key
  onDelete(providerId: string): void;
  onTest(profile: ProviderProfile, apiKey: string | null): void;
  onClose(): void;
}
export class ProviderSettingsView {
  constructor(host: HTMLElement, callbacks: ProviderSettingsCallbacks);
  setState(state: ProviderSettingsState): void;
  destroy(): void;
}
export function parseModelLines(text: string): ProviderModel[];
export function formatModelLines(models: ProviderModel[]): string;
```

- 表单字段:预设下拉(选中即回填 name/wire/baseUrl/models/defaultModel)、名称、wire 单选(openai/anthropic)、baseUrl、模型清单 textarea(每行 `id|显示名|contextWindow(可空)|effort(填 "effort" 表示支持)`)、默认模型、API key(password 输入,占位显示掩码)。
- 卡片底部固定数据外发提示文案:**“对话内容（含论文摘录、批注）将发送到你配置的这个端点。请仅使用你信任的服务。”**
- 编辑既有 provider:点“编辑”回填表单(key 输入留空 = 保留原 key);保存新 provider 时 `id` 由调用方生成,组件对新条目提交 `id: ""`,由 Task 10 的 onSave 分配。

- [ ] **Step 1: 写失败测试 `test/provider-settings.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import {
  ProviderSettingsView,
  formatModelLines,
  parseModelLines,
} from "../src/provider-settings";
import type { ProviderProfile } from "../src/providers";

const profile: ProviderProfile = {
  id: "p1",
  name: "DeepSeek",
  wire: "openai",
  baseUrl: "https://api.deepseek.com",
  models: [{ id: "deepseek-chat", label: "Chat", contextWindow: 65536 }],
  defaultModel: "deepseek-chat",
};

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const callbacks = {
    onSave: vi.fn(),
    onDelete: vi.fn(),
    onTest: vi.fn(),
    onClose: vi.fn(),
  };
  const view = new ProviderSettingsView(host, callbacks);
  return { host, view, callbacks };
}

describe("parseModelLines", () => {
  it("parses id|label|contextWindow|effort lines", () => {
    expect(parseModelLines("m1|Model One|131072|effort\nm2|Model Two\n\n")).toEqual([
      { id: "m1", label: "Model One", contextWindow: 131072, supportsReasoningEffort: true },
      { id: "m2", label: "Model Two" },
    ]);
  });

  it("round-trips through formatModelLines", () => {
    const models = parseModelLines(formatModelLines(profile.models));
    expect(models).toEqual(profile.models);
  });
});

describe("ProviderSettingsView", () => {
  it("lists providers with masked keys and never renders a raw key", () => {
    const { host, view } = mount();
    view.setState({
      providers: [profile],
      keyMask: { p1: "····1234" },
      statusText: null,
      busy: false,
    });
    expect(host.textContent).toContain("DeepSeek");
    expect(host.textContent).toContain("····1234");
    expect(host.textContent).toContain("将发送到你配置的这个端点");
  });

  it("fills the form from a preset and submits a new profile", () => {
    const { host, view, callbacks } = mount();
    view.setState({ providers: [], keyMask: {}, statusText: null, busy: false });
    const presetSelect = host.querySelector<HTMLSelectElement>(".zc-provider-preset")!;
    presetSelect.value = "DeepSeek";
    presetSelect.dispatchEvent(new Event("change", { bubbles: true }));
    const baseUrl = host.querySelector<HTMLInputElement>(".zc-provider-baseurl")!;
    expect(baseUrl.value).toBe("https://api.deepseek.com");
    const keyInput = host.querySelector<HTMLInputElement>(".zc-provider-key")!;
    keyInput.value = "sk-secret";
    host.querySelector<HTMLButtonElement>(".zc-provider-save")!.click();
    expect(callbacks.onSave).toHaveBeenCalledTimes(1);
    const [saved, apiKey] = callbacks.onSave.mock.calls[0]!;
    expect(saved.id).toBe("");
    expect(saved.name).toBe("DeepSeek");
    expect(saved.models.length).toBeGreaterThan(0);
    expect(apiKey).toBe("sk-secret");
  });

  it("editing keeps the stored key when the key input stays empty", () => {
    const { host, view, callbacks } = mount();
    view.setState({
      providers: [profile],
      keyMask: { p1: "····1234" },
      statusText: null,
      busy: false,
    });
    host.querySelector<HTMLButtonElement>(".zc-provider-edit")!.click();
    host.querySelector<HTMLButtonElement>(".zc-provider-save")!.click();
    const [saved, apiKey] = callbacks.onSave.mock.calls[0]!;
    expect(saved.id).toBe("p1");
    expect(apiKey).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/provider-settings.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写 `src/provider-settings.ts`**

```ts
import { PROVIDER_PRESETS, type ProviderModel, type ProviderProfile } from "./providers";

export interface ProviderSettingsState {
  providers: ProviderProfile[];
  keyMask: Record<string, string>;
  statusText: string | null;
  busy: boolean;
}

export interface ProviderSettingsCallbacks {
  onSave(profile: ProviderProfile, apiKey: string | null): void;
  onDelete(providerId: string): void;
  onTest(profile: ProviderProfile, apiKey: string | null): void;
  onClose(): void;
}

export function parseModelLines(text: string): ProviderModel[] {
  const models: ProviderModel[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const [id = "", label = "", contextWindow = "", effort = ""] = line.split("|").map((part) => part.trim());
    if (!id) continue;
    const model: ProviderModel = { id, label: label || id };
    const parsedWindow = Number.parseInt(contextWindow, 10);
    if (Number.isFinite(parsedWindow) && parsedWindow > 0) model.contextWindow = parsedWindow;
    if (effort === "effort") model.supportsReasoningEffort = true;
    models.push(model);
  }
  return models;
}

export function formatModelLines(models: ProviderModel[]): string {
  return models.map((model) => [
    model.id,
    model.label,
    model.contextWindow ? String(model.contextWindow) : "",
    model.supportsReasoningEffort ? "effort" : "",
  ].join("|").replace(/\|+$/, "")).join("\n");
}

const EGRESS_NOTICE = "对话内容（含论文摘录、批注）将发送到你配置的这个端点。请仅使用你信任的服务。";

export class ProviderSettingsView {
  private readonly host: HTMLElement;
  private readonly callbacks: ProviderSettingsCallbacks;
  private state: ProviderSettingsState = { providers: [], keyMask: {}, statusText: null, busy: false };
  private editingId = "";

  constructor(host: HTMLElement, callbacks: ProviderSettingsCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
    this.host.classList.add("zc-provider-settings");
    this.render();
  }

  setState(state: ProviderSettingsState): void {
    this.state = state;
    this.render();
  }

  destroy(): void {
    this.host.replaceChildren();
  }

  private render(): void {
    const doc = this.host.ownerDocument;
    this.host.replaceChildren();

    const header = doc.createElement("div");
    header.className = "zc-provider-header";
    const title = doc.createElement("strong");
    title.textContent = "模型服务";
    const close = doc.createElement("button");
    close.className = "zc-provider-close";
    close.textContent = "关闭";
    close.addEventListener("click", () => this.callbacks.onClose());
    header.append(title, close);
    this.host.appendChild(header);

    const list = doc.createElement("div");
    list.className = "zc-provider-list";
    for (const provider of this.state.providers) {
      const row = doc.createElement("div");
      row.className = "zc-provider-row";
      const label = doc.createElement("span");
      label.textContent = `${provider.name} · ${provider.wire} · ${provider.baseUrl || "（未填 baseUrl）"}`;
      const mask = doc.createElement("span");
      mask.className = "zc-provider-mask";
      mask.textContent = this.state.keyMask[provider.id] || "未保存 key";
      const edit = doc.createElement("button");
      edit.className = "zc-provider-edit";
      edit.textContent = "编辑";
      edit.addEventListener("click", () => {
        this.editingId = provider.id;
        this.fillForm(provider);
      });
      const remove = doc.createElement("button");
      remove.className = "zc-provider-delete";
      remove.textContent = "删除";
      remove.addEventListener("click", () => this.callbacks.onDelete(provider.id));
      row.append(label, mask, edit, remove);
      list.appendChild(row);
    }
    this.host.appendChild(list);

    this.host.appendChild(this.buildForm(doc));

    if (this.state.statusText) {
      const status = doc.createElement("div");
      status.className = "zc-provider-status";
      status.textContent = this.state.statusText;
      this.host.appendChild(status);
    }

    const notice = doc.createElement("p");
    notice.className = "zc-provider-egress";
    notice.textContent = EGRESS_NOTICE;
    this.host.appendChild(notice);
  }

  private buildForm(doc: Document): HTMLElement {
    const form = doc.createElement("div");
    form.className = "zc-provider-form";

    const preset = doc.createElement("select");
    preset.className = "zc-provider-preset";
    const placeholder = doc.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "从预设开始…";
    preset.appendChild(placeholder);
    for (const candidate of PROVIDER_PRESETS) {
      const option = doc.createElement("option");
      option.value = candidate.name;
      option.textContent = candidate.name;
      preset.appendChild(option);
    }
    preset.addEventListener("change", () => {
      const chosen = PROVIDER_PRESETS.find((candidate) => candidate.name === preset.value);
      if (chosen) {
        this.editingId = "";
        this.fillForm({ ...chosen, id: "" });
      }
    });

    const name = input(doc, "zc-provider-name", "名称");
    const baseUrl = input(doc, "zc-provider-baseurl", "baseUrl（如 https://api.deepseek.com）");
    const wire = doc.createElement("select");
    wire.className = "zc-provider-wire";
    for (const value of ["openai", "anthropic"]) {
      const option = doc.createElement("option");
      option.value = value;
      option.textContent = value === "openai" ? "OpenAI 兼容" : "Anthropic 兼容";
      wire.appendChild(option);
    }
    const models = doc.createElement("textarea");
    models.className = "zc-provider-models";
    models.placeholder = "每行一个模型：id|显示名|contextWindow|effort";
    const defaultModel = input(doc, "zc-provider-default", "默认模型 id");
    const key = input(doc, "zc-provider-key", "API key（留空 = 保留已存的）");
    key.type = "password";

    const test = doc.createElement("button");
    test.className = "zc-provider-test";
    test.textContent = "测试连接";
    test.disabled = this.state.busy;
    test.addEventListener("click", () => {
      this.callbacks.onTest(this.collect(form), keyValue(form));
    });

    const save = doc.createElement("button");
    save.className = "zc-provider-save";
    save.textContent = "保存";
    save.disabled = this.state.busy;
    save.addEventListener("click", () => {
      this.callbacks.onSave(this.collect(form), keyValue(form));
    });

    form.append(preset, name, wire, baseUrl, models, defaultModel, key, test, save);
    return form;
  }

  private fillForm(profile: ProviderProfile): void {
    const query = <T extends HTMLElement>(selector: string) =>
      this.host.querySelector<T>(selector)!;
    query<HTMLInputElement>(".zc-provider-name").value = profile.name;
    query<HTMLSelectElement>(".zc-provider-wire").value = profile.wire;
    query<HTMLInputElement>(".zc-provider-baseurl").value = profile.baseUrl;
    query<HTMLTextAreaElement>(".zc-provider-models").value = formatModelLines(profile.models);
    query<HTMLInputElement>(".zc-provider-default").value = profile.defaultModel;
    query<HTMLInputElement>(".zc-provider-key").value = "";
  }

  private collect(form: HTMLElement): ProviderProfile {
    const query = <T extends HTMLElement>(selector: string) => form.querySelector<T>(selector)!;
    const models = parseModelLines(query<HTMLTextAreaElement>(".zc-provider-models").value);
    const defaultModel = query<HTMLInputElement>(".zc-provider-default").value.trim()
      || models[0]?.id || "";
    return {
      id: this.editingId,
      name: query<HTMLInputElement>(".zc-provider-name").value.trim(),
      wire: query<HTMLSelectElement>(".zc-provider-wire").value === "anthropic" ? "anthropic" : "openai",
      baseUrl: query<HTMLInputElement>(".zc-provider-baseurl").value.trim(),
      models,
      defaultModel,
    };
  }
}

function input(doc: Document, className: string, placeholder: string): HTMLInputElement {
  const element = doc.createElement("input");
  element.className = className;
  element.placeholder = placeholder;
  return element;
}

function keyValue(form: HTMLElement): string | null {
  const value = form.querySelector<HTMLInputElement>(".zc-provider-key")!.value.trim();
  return value ? value : null;
}
```

样式:在现有 sidebar 样式表里(跟随现有 `.zc-*` 卡片样式所在文件)为 `.zc-provider-settings` 及子类补最小样式(overlay 定位、行距、按钮间距),风格对齐 `zc-consent-card`。

- [ ] **Step 4: 跑测试与回归**

Run: `npx vitest run test/provider-settings.test.ts && npm run check`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/provider-settings.ts test/provider-settings.test.ts
git commit -m "feat: provider settings panel with presets and masked keys"
```

---

### Task 9: 两级模型菜单 + 引导/切换卡 + capability 隐藏(sidebar/float)

**Files:**
- Create: `src/model-menu.ts`
- Modify: `src/sidebar.ts`
- Modify: `src/float-panel.ts`
- Test: `test/model-menu.test.ts`,扩展 `test/sidebar.test.ts`

**Interfaces:**
- Produces(`src/model-menu.ts`):

```ts
export function modelBackend(modelId: string): "engine" | "codex";  // id 前缀 "engine:" 判定
export function renderModelOptions(
  select: HTMLSelectElement,
  models: ModelOption[],
  selected: string,
): void; // 清空后按「内置引擎」/「Codex（订阅）」两个 optgroup 重建
```

- `SidebarState` 新增字段(**全部可选**,避免破坏既有测试;缺省语义在括号里):
  - `backend?: "codex" | "engine"`(缺省 `"codex"`)
  - `capabilities?: { supportsAgentMode: boolean; supportsLogin: boolean }`(缺省全 true)
  - `onboarding?: boolean`(缺省 false;true 时渲染 `zc-engine-onboarding` 卡)
  - `backendSwitch?: { targetLabel: string } | null`(非空渲染 `zc-backend-switch` 卡)
- `SidebarCallbacks` 新增(可选):`onOpenProviderSettings?(): void`、`onChooseCodexBackend?(): void`、`onBackendSwitchDecision?(decision: "carry" | "fresh" | "cancel"): void`。
- `FloatPanelState`/`FloatPanelCallbacks` 同样加 `capabilities?`(登录按钮隐藏用)并把模型渲染换成 `renderModelOptions`。

- [ ] **Step 1: 写失败测试 `test/model-menu.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { modelBackend, renderModelOptions } from "../src/model-menu";

describe("modelBackend", () => {
  it("classifies by the engine: prefix", () => {
    expect(modelBackend("engine:p1:deepseek-chat")).toBe("engine");
    expect(modelBackend("gpt-5")).toBe("codex");
  });
});

describe("renderModelOptions", () => {
  it("groups engine and codex models into labelled optgroups", () => {
    const select = document.createElement("select");
    renderModelOptions(select, [
      { id: "engine:p1:deepseek-chat", label: "DeepSeek · Chat" },
      { id: "gpt-5", label: "GPT-5" },
    ], "engine:p1:deepseek-chat");
    const groups = [...select.querySelectorAll("optgroup")].map((group) => group.label);
    expect(groups).toEqual(["内置引擎", "Codex（订阅）"]);
    expect(select.value).toBe("engine:p1:deepseek-chat");
  });

  it("omits an empty group", () => {
    const select = document.createElement("select");
    renderModelOptions(select, [{ id: "gpt-5", label: "GPT-5" }], "gpt-5");
    expect([...select.querySelectorAll("optgroup")].map((group) => group.label)).toEqual(["Codex（订阅）"]);
  });
});
```

`test/sidebar.test.ts` 追加(沿用该文件现有的 view 构造辅助;下面的 `makeView/baseState` 指代文件里已有的等价物,names 以现状为准):

```ts
  it("renders the engine onboarding card with both paths", () => {
    const { view, host, callbacks } = makeView();
    view.setState({ ...baseState(), onboarding: true });
    const card = host.querySelector(".zc-engine-onboarding")!;
    expect(card.textContent).toContain("添加模型服务");
    card.querySelector<HTMLButtonElement>(".zc-onboarding-add")!.click();
    expect(callbacks.onOpenProviderSettings).toHaveBeenCalled();
    card.querySelector<HTMLButtonElement>(".zc-onboarding-codex")!.click();
    expect(callbacks.onChooseCodexBackend).toHaveBeenCalled();
  });

  it("renders the backend switch card and reports each decision", () => {
    const { view, host, callbacks } = makeView();
    view.setState({ ...baseState(), backendSwitch: { targetLabel: "内置引擎" } });
    const card = host.querySelector(".zc-backend-switch")!;
    expect(card.textContent).toContain("内置引擎");
    card.querySelector<HTMLButtonElement>(".zc-switch-carry")!.click();
    expect(callbacks.onBackendSwitchDecision).toHaveBeenCalledWith("carry");
  });

  it("hides mode toggle and login affordances per capabilities", () => {
    const { view, host } = makeView();
    view.setState({
      ...baseState(),
      capabilities: { supportsAgentMode: false, supportsLogin: false },
    });
    expect(host.querySelector(".zc-mode-toggle")).toBeNull();
  });
```

(`.zc-mode-toggle` 若现状类名不同,用现状类名;断言语义是“Agent 模式切换控件在 supportsAgentMode=false 时不渲染”。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/model-menu.test.ts test/sidebar.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 3: 写 `src/model-menu.ts`**

```ts
import type { ModelOption } from "./sidebar";

export function modelBackend(modelId: string): "engine" | "codex" {
  return modelId.startsWith("engine:") ? "engine" : "codex";
}

export function renderModelOptions(
  select: HTMLSelectElement,
  models: ModelOption[],
  selected: string,
): void {
  const doc = select.ownerDocument;
  select.replaceChildren();
  const groups: Array<{ label: string; members: ModelOption[] }> = [
    { label: "内置引擎", members: models.filter((model) => modelBackend(model.id) === "engine") },
    { label: "Codex（订阅）", members: models.filter((model) => modelBackend(model.id) === "codex") },
  ];
  for (const group of groups) {
    if (!group.members.length) continue;
    const optgroup = doc.createElement("optgroup");
    optgroup.label = group.label;
    for (const model of group.members) {
      const option = doc.createElement("option");
      option.value = model.id;
      option.textContent = model.label;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }
  if (selected) select.value = selected;
}
```

- [ ] **Step 4: 改 `src/sidebar.ts` 与 `src/float-panel.ts`**

1. 两处 `renderModels`(sidebar.ts ~837 行、float-panel.ts ~498 行)的“清空 + 逐个 append option”循环替换为 `renderModelOptions(this.modelSelect, state.models, state.selectedModel)`(import 自 `./model-menu`;保留各自 change 监听不动)。
2. `SidebarState`/`SidebarCallbacks` 按 Interfaces 节添加可选字段/回调。
3. 新增两张卡的渲染(跟随现有 `paperTrailConsent` 卡的渲染位置与写法,插在消息列表上方):

```ts
  private renderEngineOnboarding(container: HTMLElement, state: SidebarState): void {
    if (!state.onboarding) return;
    const doc = container.ownerDocument;
    const card = doc.createElement("div");
    card.className = "zc-engine-onboarding";
    const text = doc.createElement("p");
    text.textContent = "还没有配置模型服务。添加一个 API 服务（如 DeepSeek / Kimi），或继续使用 Codex 订阅。";
    const add = doc.createElement("button");
    add.className = "zc-onboarding-add";
    add.textContent = "添加模型服务";
    add.addEventListener("click", () => this.callbacks.onOpenProviderSettings?.());
    const codex = doc.createElement("button");
    codex.className = "zc-onboarding-codex";
    codex.textContent = "继续用 Codex（订阅）";
    codex.addEventListener("click", () => this.callbacks.onChooseCodexBackend?.());
    card.append(text, add, codex);
    container.appendChild(card);
  }

  private renderBackendSwitch(container: HTMLElement, state: SidebarState): void {
    if (!state.backendSwitch) return;
    const doc = container.ownerDocument;
    const card = doc.createElement("div");
    card.className = "zc-backend-switch";
    const text = doc.createElement("p");
    text.textContent = `切换到 ${state.backendSwitch.targetLabel}。当前对话的历史要带过去吗？`;
    const carry = doc.createElement("button");
    carry.className = "zc-switch-carry";
    carry.textContent = "携带对话历史继续（推荐）";
    carry.addEventListener("click", () => this.callbacks.onBackendSwitchDecision?.("carry"));
    const fresh = doc.createElement("button");
    fresh.className = "zc-switch-fresh";
    fresh.textContent = "开新会话";
    fresh.addEventListener("click", () => this.callbacks.onBackendSwitchDecision?.("fresh"));
    const cancel = doc.createElement("button");
    cancel.className = "zc-switch-cancel";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => this.callbacks.onBackendSwitchDecision?.("cancel"));
    card.append(text, carry, fresh, cancel);
    container.appendChild(card);
  }
```

在主渲染路径中调用这两个方法(位置与 consent 卡一致),并注意:`backendSwitch` 卡渲染时把普通 composer 的发送按钮禁用与否维持现状——卡是模态语义,由 Task 10 的 pending 状态控制生命周期。
4. capability 隐藏:渲染 Agent/Ask 模式切换控件处包一层 `if (state.capabilities?.supportsAgentMode !== false)`;渲染登录/退出登录按钮处包 `if (state.capabilities?.supportsLogin !== false)`。float-panel 的登录按钮同理。
5. 反方向注意:切到引擎后 `models` 里没有 codex 模型时,codex optgroup 自然消失——不需要额外处理;但要在模型菜单旁加一个小按钮(类名 `zc-model-settings`,文本 “⚙”),点击触发 `onOpenProviderSettings?.()`,让设置入口不依赖 onboarding 卡。

- [ ] **Step 5: 跑测试与回归**

Run: `npx vitest run test/model-menu.test.ts test/sidebar.test.ts test/float-panel.test.ts && npm run check && npx vitest run`
Expected: 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/model-menu.ts src/sidebar.ts src/float-panel.ts test/model-menu.test.ts test/sidebar.test.ts
git commit -m "feat: grouped model menu, onboarding and backend-switch cards"
```

---

### Task 10: plugin.ts 接线(切换流程 / 设置面板 / 账户与引导状态)

**Files:**
- Modify: `src/plugin.ts`
- Test: 扩展 `test/plugin-state.test.ts`(若该文件只测纯函数,把本任务新增的纯 helper 放进 `model-menu.ts`/`providers.ts` 并在各自测试文件断言;plugin.ts 的接线以 `npm run check` + 上层 UI 测试覆盖)

**Interfaces:**
- Consumes: `switchBackend/state.backend/state.capabilities/accountLabel`(Task 7)、`ProviderSettingsView`(Task 8)、`modelBackend`(Task 9)、`loadProviders/saveProviders/testProvider/providerKeyRealm`(Task 4)、`saveSecret/readSecret/deleteSecret/maskSecret`(Task 4)、`randomID`(`./platform`)。
- 行为验收:
  1. 模型菜单选中另一后端的模型 → 弹 `backendSwitch` 卡;“携带”→ `switchBackend(target, true)`;“开新会话”→ `switchBackend(target, false)`;“取消”→ 状态复原。
  2. 引擎后端 + 零 provider + 已连接 → `onboarding: true`;“继续用 Codex（订阅）” → `switchBackend("codex", false)`。
  3. `sendChat` 的登录报错文案按后端区分(引擎侧实际不会触发——`requiresOpenaiAuth:false` 恒视为已就绪)。
  4. 设置面板保存 provider:新条目分配 `id = randomID("prov").slice(0, 24)`;key 传 null 时不动已存 key;保存后若引擎在线,调 `this.codex.refreshModels()` 并重渲染。

- [ ] **Step 1: plugin.ts 修改清单**(实施前先读各符号现状)

1. **字段**:

```ts
  private pendingBackendSwitch: { targetModel: string; targetLabel: string } | null = null;
  private providerSettingsHost: HTMLElement | null = null;
  private providerSettingsView: ProviderSettingsView | null = null;
```

2. **onModelChange**(sidebar 与 float 两处回调统一改为):

```ts
      onModelChange: (model) => { void this.handleModelSelection(model); },
```

新增方法:

```ts
  private async handleModelSelection(model: string): Promise<void> {
    const target = modelBackend(model);
    if (this.codex.state.connected && target !== this.codex.state.backend) {
      this.pendingBackendSwitch = {
        targetModel: model,
        targetLabel: target === "engine" ? "内置引擎" : "Codex（订阅）",
      };
      this.renderChatViews();
      return;
    }
    this.selectedModel = model;
    setPrefString("defaultModel", model);
    this.renderChatViews();
  }

  private async resolveBackendSwitch(decision: "carry" | "fresh" | "cancel"): Promise<void> {
    const pending = this.pendingBackendSwitch;
    this.pendingBackendSwitch = null;
    if (!pending || decision === "cancel") {
      this.renderChatViews();
      return;
    }
    const target = modelBackend(pending.targetModel);
    try {
      await this.codex.switchBackend(target, decision === "carry");
      this.selectedModel = pending.targetModel;
      setPrefString("defaultModel", pending.targetModel);
    }
    catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
    }
    finally {
      this.renderChatViews();
    }
  }
```

3. **SidebarView 回调注册**(`mountChat` 内)追加:

```ts
      onOpenProviderSettings: () => this.openProviderSettings(),
      onChooseCodexBackend: () => {
        void this.codex.switchBackend("codex", false)
          .then(() => this.renderChatViews())
          .catch((error) => this.reportError(error));
      },
      onBackendSwitchDecision: (decision) => { void this.resolveBackendSwitch(decision); },
```

4. **renderChatViews 的 setState** 追加字段:

```ts
        backend: this.codex.state.backend,
        capabilities: {
          supportsAgentMode: this.codex.state.capabilities.supportsAgentMode,
          supportsLogin: this.codex.state.capabilities.supportsLogin,
        },
        onboarding: this.codex.state.backend === "engine"
          && this.codex.state.connected
          && loadProviders().length === 0,
        backendSwitch: this.pendingBackendSwitch
          ? { targetLabel: this.pendingBackendSwitch.targetLabel }
          : null,
```

`accountLabel` 一行改为无条件 `accountLabel: this.codex.state.connected ? this.codex.accountLabel() : undefined`(引擎侧 `isSignedIn()` 恒 true,原三元继续可用也行——保持行为:连接后就显示标签)。

5. **sendChat** 的登录守卫改为:

```ts
    if (!this.codex.isSignedIn()) {
      throw new Error(this.codex.state.backend === "engine"
        ? "请先在设置中添加模型服务"
        : "请先使用 ChatGPT 登录 Codex");
    }
```

`newChat`/`openChatWithSelection` 里同一文案同样替换。`ensureChatSessionInternal` 的 `unavailable` 判断(`未找到 Codex CLI`)保留——引擎路径不会产生该消息。

6. **设置面板挂载**:

```ts
  private openProviderSettings(): void {
    const body = this.activeSidebarBody();
    if (!body) return;
    if (!this.providerSettingsHost) {
      this.providerSettingsHost = body.ownerDocument.createElement("div");
      this.providerSettingsHost.className = "zc-provider-overlay";
      body.appendChild(this.providerSettingsHost);
      this.providerSettingsView = new ProviderSettingsView(this.providerSettingsHost, {
        onSave: (profile, apiKey) => { void this.saveProvider(profile, apiKey); },
        onDelete: (providerId) => { void this.deleteProvider(providerId); },
        onTest: (profile, apiKey) => { void this.testProviderConnection(profile, apiKey); },
        onClose: () => this.closeProviderSettings(),
      });
    }
    void this.refreshProviderSettings(null);
  }

  private closeProviderSettings(): void {
    this.providerSettingsView?.destroy();
    this.providerSettingsView = null;
    this.providerSettingsHost?.remove();
    this.providerSettingsHost = null;
  }

  private async refreshProviderSettings(statusText: string | null, busy = false): Promise<void> {
    if (!this.providerSettingsView) return;
    const providers = loadProviders();
    const keyMask: Record<string, string> = {};
    for (const provider of providers) {
      const key = await readSecret(providerKeyRealm(provider.id), provider.id);
      if (key) keyMask[provider.id] = maskSecret(key);
    }
    this.providerSettingsView.setState({ providers, keyMask, statusText, busy });
  }

  private async saveProvider(profile: ProviderProfile, apiKey: string | null): Promise<void> {
    if (!profile.name || !profile.models.length) {
      await this.refreshProviderSettings("请至少填写名称和一个模型");
      return;
    }
    const id = profile.id || randomID("prov").slice(0, 24);
    const next = { ...profile, id };
    const rest = loadProviders().filter((candidate) => candidate.id !== id);
    saveProviders([...rest, next]);
    if (apiKey) await saveSecret(providerKeyRealm(id), id, apiKey);
    if (this.codex.state.backend === "engine" && this.codex.state.connected) {
      await this.codex.refreshModels().catch(() => { /* surfaced on next send */ });
    }
    await this.refreshProviderSettings(`已保存 ${next.name}`);
    this.renderChatViews();
  }

  private async deleteProvider(providerId: string): Promise<void> {
    saveProviders(loadProviders().filter((candidate) => candidate.id !== providerId));
    await deleteSecret(providerKeyRealm(providerId), providerId);
    if (this.codex.state.backend === "engine" && this.codex.state.connected) {
      await this.codex.refreshModels().catch(() => { /* ignore */ });
    }
    await this.refreshProviderSettings("已删除");
    this.renderChatViews();
  }

  private async testProviderConnection(profile: ProviderProfile, apiKey: string | null): Promise<void> {
    await this.refreshProviderSettings("正在测试…", true);
    try {
      const key = apiKey
        ?? (profile.id ? await readSecret(providerKeyRealm(profile.id), profile.id) : null);
      if (!key) throw new Error("请先填写 API key");
      const result = await testProvider(profile, key);
      await this.refreshProviderSettings(result);
    }
    catch (error) {
      await this.refreshProviderSettings(error instanceof Error ? error.message : String(error));
    }
  }
```

7. **导入**:`ProviderSettingsView`、`modelBackend`、`loadProviders/saveProviders/testProvider/providerKeyRealm/ProviderProfile`、`saveSecret/readSecret/deleteSecret/maskSecret`、`randomID`。

- [ ] **Step 2: 回归与手动核对**

Run: `npm run check && npx vitest run`
Expected: 全 PASS。逐条核对本任务 Interfaces 节的 4 条行为验收在代码路径上成立(阅读走查,不依赖真机)。

- [ ] **Step 3: Commit**

```bash
git add src/plugin.ts
git commit -m "feat: wire backend switching and provider settings into the plugin"
```

---

### Task 11: AnthropicWire(Anthropic 兼容 / Kimi For Coding)

**Files:**
- Create: `src/wire-anthropic.ts`
- Modify: `src/engine-client.ts`(`wireFor` 接上 anthropic 分支)
- Modify: `src/providers.ts`(`testProvider` 移除 anthropic 拒绝分支,改用对应 wire)
- Test: `test/wire-anthropic.test.ts`

**Interfaces:**
- Consumes/Produces: 实现 Task 3 的 `WireAdapter`。
- 映射规则(钉死):
  - URL:`{baseUrl 去尾斜杠}/v1/messages`;若 baseUrl 已以 `/v1` 结尾则拼 `/messages`(容忍两种预设写法)。
  - 头:`x-api-key: <key>`、`anthropic-version: 2023-06-01`、`content-type: application/json`。
  - body:`{model, max_tokens: 8192, stream: true, system?, messages, tools?}`;`system` 取首条 system 消息文本;`tools` 映射 `{name, description, input_schema: inputSchema}`。
  - 消息:user → `{role:"user", content:[{type:"text",text}]}`;assistant(带 toolCalls)→ content 里 text block(如非空)+ 每个 call 一个 `{type:"tool_use", id, name, input: JSON.parse(argumentsJson)}`;tool 结果 → `{role:"user", content:[{type:"tool_result", tool_use_id, content: text}]}`,**连续多条 tool 消息合并进同一个 user content 数组**(Anthropic 要求 user/assistant 交替)。
  - effort(仅当引擎侧因 `supportsReasoningEffort` 传入非 null):`low→{budget_tokens:4096}`、`medium→8192`、`high→16384`,body 加 `thinking:{type:"enabled", budget_tokens}`。
  - 流解析(SSE `event:`/`data:` 行):`content_block_delta` 的 `text_delta` → textDelta;`content_block_start` 的 `tool_use` 记录 id/name;`input_json_delta.partial_json` 追加;`message_delta` 的 `stop_reason` `tool_use`→flush toolCalls+stop(toolCalls),`end_turn`/`max_tokens`→stop(end);`event: error` 或 data 里 `type:"error"` → error 事件;`thinking_delta` 等未知 block 静默忽略。

- [ ] **Step 1: 写失败测试 `test/wire-anthropic.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { AnthropicWire } from "../src/wire-anthropic";
import type { WireEvent } from "../src/wire";

const wire = new AnthropicWire();

function drain(chunks: string[]): WireEvent[] {
  const parser = wire.createParser();
  const events: WireEvent[] = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.end());
  return events;
}

describe("AnthropicWire.buildRequest", () => {
  it("builds a messages request with system, tools and merged tool results", () => {
    const request = wire.buildRequest(
      "https://api.anthropic.com",
      "sk-ant",
      [
        { role: "system", text: "sys" },
        { role: "user", text: "问" },
        { role: "assistant", text: "先查", toolCalls: [{ id: "t1", name: "zotero_page", argumentsJson: "{\"page\":2}" }] },
        { role: "tool", text: "第二页内容", toolCallId: "t1" },
      ],
      [{ name: "zotero_page", description: "read", inputSchema: { type: "object" } }],
      { model: "claude-sonnet-5", effort: null },
    );
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers["x-api-key"]).toBe("sk-ant");
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(request.body);
    expect(body.system).toBe("sys");
    expect(body.max_tokens).toBe(8192);
    expect(body.tools[0].input_schema).toEqual({ type: "object" });
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "先查" },
      { type: "tool_use", id: "t1", name: "zotero_page", input: { page: 2 } },
    ]);
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "第二页内容" }],
    });
  });

  it("maps effort onto a thinking budget", () => {
    const request = wire.buildRequest("https://api.kimi.example/anthropic", "k", [
      { role: "user", text: "q" },
    ], [], { model: "kimi-k2", effort: "high" });
    expect(JSON.parse(request.body).thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
  });
});

describe("AnthropicWire parser", () => {
  it("streams text deltas and stops on end_turn", () => {
    const events = drain([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ]);
    const text = events.filter((event) => event.type === "textDelta")
      .map((event) => (event as { delta: string }).delta).join("");
    expect(text).toBe("你好");
    expect(events.at(-1)).toEqual({ type: "stop", reason: "end" });
  });

  it("assembles a tool_use block from indexed json deltas", () => {
    const events = drain([
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t9","name":"zotero_page"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"page\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"5}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    ]);
    const toolEvent = events.find((event) => event.type === "toolCalls") as { calls: unknown[] } | undefined;
    expect(toolEvent?.calls).toEqual([{ id: "t9", name: "zotero_page", argumentsJson: "{\"page\":5}" }]);
    expect(events.at(-1)).toEqual({ type: "stop", reason: "toolCalls" });
  });

  it("surfaces error events", () => {
    const events = drain([
      'event: error\ndata: {"type":"error","error":{"message":"overloaded"}}\n\n',
    ]);
    expect(events[0]).toEqual({ type: "error", message: "overloaded" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/wire-anthropic.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写 `src/wire-anthropic.ts`**

```ts
import type {
  WireAdapter,
  WireEvent,
  WireMessage,
  WireParser,
  WireRequest,
  WireRequestParams,
  WireToolSpec,
} from "./wire";

const THINKING_BUDGETS: Record<string, number> = { low: 4096, medium: 8192, high: 16384 };

/** Anthropic-compatible messages wire (Anthropic API, Kimi For Coding subscription endpoint). */
export class AnthropicWire implements WireAdapter {
  buildRequest(
    baseUrl: string,
    apiKey: string,
    messages: WireMessage[],
    tools: WireToolSpec[],
    params: WireRequestParams,
  ): WireRequest {
    const trimmed = baseUrl.replace(/\/+$/, "");
    const url = trimmed.endsWith("/v1") ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
    const system = messages.find((message) => message.role === "system")?.text;
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: 8192,
      stream: true,
      messages: toAnthropicMessages(messages),
    };
    if (system) body.system = system;
    if (tools.length) {
      body.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }
    const budget = params.effort ? THINKING_BUDGETS[params.effort] : undefined;
    if (budget) body.thinking = { type: "enabled", budget_tokens: budget };
    return {
      url,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    };
  }

  createParser(): WireParser {
    return new AnthropicStreamParser();
  }
}

function toAnthropicMessages(messages: WireMessage[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.toolCallId || "",
        content: message.text,
      };
      const previous = output[output.length - 1];
      if (previous && previous.role === "user" && Array.isArray(previous.content)
        && (previous.content as Array<{ type?: string }>).every((item) => item.type === "tool_result")) {
        (previous.content as unknown[]).push(block);
      }
      else {
        output.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      const content: unknown[] = [];
      if (message.text) content.push({ type: "text", text: message.text });
      for (const call of message.toolCalls) {
        let input: unknown = {};
        try { input = JSON.parse(call.argumentsJson || "{}"); } catch { /* keep {} */ }
        content.push({ type: "tool_use", id: call.id, name: call.name, input });
      }
      output.push({ role: "assistant", content });
      continue;
    }
    output.push({ role: message.role, content: [{ type: "text", text: message.text }] });
  }
  return output;
}

class AnthropicStreamParser implements WireParser {
  private buffer = "";
  private stopped = false;
  private readonly toolBlocks = new Map<number, { id: string; name: string; argumentsJson: string }>();

  push(chunk: string): WireEvent[] {
    this.buffer += chunk;
    const events: WireEvent[] = [];
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.consumeLine(line, events);
    }
    return events;
  }

  end(): WireEvent[] {
    const events: WireEvent[] = [];
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) this.consumeLine(rest, events);
    if (!this.stopped) {
      this.stopped = true;
      this.flushStop(events, this.toolBlocks.size ? "toolCalls" : "end");
    }
    return events;
  }

  private consumeLine(line: string, events: WireEvent[]): void {
    if (this.stopped || !line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    }
    catch {
      this.stopped = true;
      events.push({ type: "error", message: "模型服务返回了无法解析的流式数据" });
      return;
    }
    const type = parsed.type;
    if (type === "error") {
      const errorRecord = parsed.error as Record<string, unknown> | undefined;
      this.stopped = true;
      events.push({
        type: "error",
        message: typeof errorRecord?.message === "string" ? errorRecord.message : "模型服务返回错误",
      });
      return;
    }
    if (type === "content_block_start") {
      const blockIndex = typeof parsed.index === "number" ? parsed.index : 0;
      const block = parsed.content_block as Record<string, unknown> | undefined;
      if (block?.type === "tool_use") {
        this.toolBlocks.set(blockIndex, {
          id: typeof block.id === "string" ? block.id : `tool-${blockIndex}`,
          name: typeof block.name === "string" ? block.name : "",
          argumentsJson: "",
        });
      }
      return;
    }
    if (type === "content_block_delta") {
      const blockIndex = typeof parsed.index === "number" ? parsed.index : 0;
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        events.push({ type: "textDelta", delta: delta.text });
      }
      else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const block = this.toolBlocks.get(blockIndex);
        if (block) block.argumentsJson += delta.partial_json;
      }
      return;
    }
    if (type === "message_delta") {
      const delta = parsed.delta as Record<string, unknown> | undefined;
      const stopReason = delta?.stop_reason;
      if (stopReason === "tool_use") {
        this.stopped = true;
        this.flushStop(events, "toolCalls");
      }
      else if (stopReason === "end_turn" || stopReason === "max_tokens") {
        this.stopped = true;
        this.flushStop(events, "end");
      }
    }
  }

  private flushStop(events: WireEvent[], reason: "end" | "toolCalls"): void {
    if (this.toolBlocks.size) {
      const calls = [...this.toolBlocks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([position, block]) => ({
          id: block.id || `tool-${position}`,
          name: block.name,
          argumentsJson: block.argumentsJson || "{}",
        }));
      this.toolBlocks.clear();
      events.push({ type: "toolCalls", calls });
      events.push({ type: "stop", reason: "toolCalls" });
      return;
    }
    events.push({ type: "stop", reason });
  }
}
```

- [ ] **Step 4: 接线**

- `src/engine-client.ts` 的 `wireFor`:anthropic 分支改为 `return new AnthropicWire();`(import 补上)。
- `src/providers.ts` 的 `testProvider`:删除 anthropic 拒绝分支,`const wire = profile.wire === "anthropic" ? new AnthropicWire() : new OpenAIWire();`(import 补上)。同步删除/更新 Task 4 测试里对该拒绝行为的断言(若写了)。

- [ ] **Step 5: 跑测试与回归**

Run: `npx vitest run test/wire-anthropic.test.ts && npm run check && npx vitest run`
Expected: 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/wire-anthropic.ts src/engine-client.ts src/providers.ts test/wire-anthropic.test.ts
git commit -m "feat: Anthropic-compatible wire adapter (Anthropic API, Kimi subscription)"
```

---

### Task 12: 验收测试(零写工具 / 无 codex 可用)+ 文档

**Files:**
- Create: `test/engine-acceptance.test.ts`
- Modify: `zotero-plugin/README.md`(相对本仓库根;即插件目录下的 README)
- Test: 上述新测试文件

**Interfaces:**
- Consumes: Task 1–7 全部产物;现有 `READER_CONTEXT_TOOLS/READER_TOOL_NAMES`(`./reader-context`)、`ZOTERO_MUTATION_TOOL`(`./zotero-mutations`)。

- [ ] **Step 1: 写 `test/engine-acceptance.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { CodexService } from "../src/codex-service";
import { setPrefString } from "../src/platform";
import { installGeckoStubs } from "./gecko-stubs";

installGeckoStubs();

import { READER_CONTEXT_TOOLS, READER_TOOL_NAMES } from "../src/reader-context";
import { ZOTERO_MUTATION_TOOL, ZoteroMutationService } from "../src/zotero-mutations";
import { ENGINE_CAPABILITIES } from "../src/agent-client";
import { EngineClient } from "../src/engine-client";
import type { NativeBridge } from "../src/native-bridge";
import type { ReaderContextService } from "../src/reader-context";

describe("deterministic-write guarantee on the engine backend", () => {
  it("passes only read-only reader tools to engine threads in ask mode", async () => {
    setPrefString("backend", "engine");
    const captured: unknown[] = [];
    const engine = {
      agentCapabilities: ENGINE_CAPABILITIES,
      connect: vi.fn().mockResolvedValue({}),
      close: vi.fn(),
      accountRead: vi.fn().mockResolvedValue({ account: null, requiresOpenaiAuth: false }),
      modelList: vi.fn().mockResolvedValue({ data: [] }),
      threadStart: vi.fn().mockImplementation(async (params: { dynamicTools?: unknown[] }) => {
        captured.push(...(params.dynamicTools ?? []));
        return { thread: { id: "eng-1" } };
      }),
      threadResume: vi.fn(),
      threadRead: vi.fn().mockResolvedValue({}),
      threadSetName: vi.fn().mockResolvedValue({}),
      turnStart: vi.fn().mockResolvedValue({ turn: { id: "t" } }),
      turnInterrupt: vi.fn().mockResolvedValue({}),
    };
    Object.setPrototypeOf(engine, EngineClient.prototype);
    const callbacks = { onState: vi.fn(), onError: vi.fn() };
    const mutationProvider = {
      tools: [ZOTERO_MUTATION_TOOL],
      invokeTool: vi.fn(),
    };
    const service = new CodexService(
      {} as NativeBridge,
      { tools: READER_CONTEXT_TOOLS } as unknown as ReaderContextService,
      "test",
      callbacks,
      mutationProvider as never,
      () => engine as never,
    );
    const specs = (service as any).dynamicToolSpecs() as Array<{ name: string }>;
    const names = specs.map((spec) => spec.name);
    expect(names).toEqual([...READER_TOOL_NAMES]);
    expect(names).not.toContain(ZOTERO_MUTATION_TOOL.name);
    // Agent mode (the only path that could expose mutation tools) is
    // structurally unreachable on the engine backend:
    service.state.capabilities = ENGINE_CAPABILITIES;
    await expect(service.setMode("agent")).rejects.toThrow(/不支持 Agent 模式/);
  });
});
```

(若 `READER_CONTEXT_TOOLS`/`READER_TOOL_NAMES`/`ZOTERO_MUTATION_TOOL` 的名字与现状不同,以 `test/codex-service.test.ts` 顶部的既有导入为准——现状确实从这两个模块导入这三个符号。)

- [ ] **Step 2: 跑测试**

Run: `npx vitest run test/engine-acceptance.test.ts && npx vitest run`
Expected: 全 PASS。

- [ ] **Step 3: README 更新**

在 `zotero-plugin/README.md` 的功能介绍部分(“Research Chat”相关章节之后)插入一节,中英双语版本都要更新(该 README 若为中英双文件/双段结构,遵循现有结构):

```markdown
## 模型服务（内置引擎）

Research Chat 默认由插件内置引擎驱动，直连你自己配置的模型服务，无需安装任何 CLI 或订阅：

1. 侧栏模型菜单旁点 ⚙（或首次使用时的「添加模型服务」卡片）。
2. 从预设选择 DeepSeek / Kimi（月之暗面开放平台）/ OpenRouter / Ollama / OpenAI / Anthropic，或填自定义 OpenAI/Anthropic 兼容端点。
3. 粘贴 API key（保存在 Zotero 的密码管理器里，不写入配置文件）→ 测试连接 → 保存。

注意：对话内容（含论文摘录、批注）会发送到你配置的端点；Kimi For Coding 订阅端点面向 coding agent 设计，使用前请确认 Moonshot 服务条款。

已安装并登录 codex CLI 的用户可继续使用 Codex（订阅）后端：模型菜单里选择 Codex 分组即可；对话中途从 Codex 切到引擎可选择「携带对话历史继续」。留痕高亮与 Note 笔记在两个后端下行为一致。
```

- [ ] **Step 4: Commit**

```bash
git add test/engine-acceptance.test.ts README.md
git commit -m "test: engine-backend deterministic-write acceptance; docs: engine setup"
```

(README 路径按插件仓库实际文件名 `git add`。)

---

### Task 13: SSH 远程 Codex(传输层 + 服务集成)

**Files:**
- Create: `src/ssh-codex.ts`
- Modify: `src/codex-service.ts`(codex 启动分支的远程 target、远程语义边界)
- Modify: `prefs.js`(`codexTarget`、`sshProfiles`)
- Test: `test/ssh-codex.test.ts`

**Interfaces:**
- Produces(`src/ssh-codex.ts`):

```ts
export interface SshCodexProfile {
  id: string;
  name: string;
  host: string;
  port: number;             // 默认 22
  user: string;
  auth: "key" | "password";
  keyPath?: string;         // auth === "key" 时可选(留空 = 用 ssh-agent/默认密钥)
  remoteCodexPath: string;  // 默认 "codex";远程命令不经 login shell,PATH 不全时需绝对路径
}
export function loadSshProfiles(): SshCodexProfile[];   // pref sshProfiles
export function saveSshProfiles(profiles: SshCodexProfile[]): void;
export function sshSecretRealm(profileId: string): string; // `zotkit-ssh:${profileId}`
export interface SshLaunch { argv: string[]; env: Record<string, string>; }
export function buildSshLaunch(profile: SshCodexProfile, askpassPath: string | null): SshLaunch;
export const ASKPASS_SCRIPT: string; // "#!/bin/sh\nprintf '%s\n' \"$ZOTKIT_SSH_PASSWORD\"\n"
```

- argv 规则(钉死):
  - 公共前缀:`["ssh", "-T", "-p", String(port), "-o", "StrictHostKeyChecking=yes"]`
  - key 认证:追加 `"-o", "BatchMode=yes"`,有 keyPath 再追加 `"-i", keyPath`
  - password 认证:**不**加 BatchMode;env 含 `SSH_ASKPASS: askpassPath`、`SSH_ASKPASS_REQUIRE: "force"`、`DISPLAY: ":0"`
  - 结尾:`` `${user}@${host}`, "--", remoteCodexPath, "app-server", "--stdio" ``
  - env 公共含 `NO_COLOR: "1"`;**builder 输出永不包含密码**——密码由服务侧读取 secret 后合并为 `ZOTKIT_SSH_PASSWORD`。
- 服务集成语义:
  - pref `codexTarget`(默认 `"local"`);非 local 时 codex 启动分支不调 `findExecutable`,argv/env 来自 builder;password 认证先 `ensureAskpassScript()`(把 `ASKPASS_SCRIPT` 写到 `profilePath("zotkit-askpass.sh")`,权限 0o700)再把 secret 并入 env;secret 缺失 → `throw new Error("远程 Codex 的 SSH 密码尚未保存，请在设置中填写")`。
  - 远程时 `this.remoteCodex = true`;capabilities = `{ ...CODEX_CAPABILITIES, supportsAgentMode: false, supportsCheckpoints: false }`。
  - `threadModeSettings`/`turnModeSettings` 远程分支:不传 `cwd`/`runtimeWorkspaceRoots`(若协议类型把 cwd 定为必填,传 `"/tmp"`),sandbox 恒 `read-only`、approvalPolicy 恒 `never`、developerInstructions 恒 ASK 版。
  - `buildAdditionalContext` 加第三参 `options: { includeLocalPaths?: boolean } = {}`,`includeLocalPaths === false` 时省略 `PDF path`/`PDF directory` 两行;函数加 `export` 供测试;调用点传 `{ includeLocalPaths: !this.remoteCodex }`。
  - 连接失败的错误文案追加指引:捕获 codex 启动/connect 异常时,若 target 非 local,把错误包装为 `` `远程 Codex 连接失败：${原文}。若是首次连接该主机，请先在终端 ssh 一次以确认主机指纹（known_hosts）。` ``。

- [ ] **Step 1: 写失败测试 `test/ssh-codex.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { ASKPASS_SCRIPT, buildSshLaunch, type SshCodexProfile } from "../src/ssh-codex";
import { buildAdditionalContext } from "../src/codex-service";

const base: SshCodexProfile = {
  id: "s1",
  name: "lab box",
  host: "lab.example.edu",
  port: 22,
  user: "eric",
  auth: "key",
  keyPath: "/Users/eric/.ssh/id_ed25519",
  remoteCodexPath: "/home/eric/.local/bin/codex",
};

describe("buildSshLaunch", () => {
  it("builds key-auth argv with BatchMode and identity file", () => {
    const launch = buildSshLaunch(base, null);
    expect(launch.argv).toEqual([
      "ssh", "-T", "-p", "22", "-o", "StrictHostKeyChecking=yes",
      "-o", "BatchMode=yes", "-i", "/Users/eric/.ssh/id_ed25519",
      "eric@lab.example.edu", "--",
      "/home/eric/.local/bin/codex", "app-server", "--stdio",
    ]);
    expect(launch.env).toEqual({ NO_COLOR: "1" });
  });

  it("builds password-auth env without embedding the password", () => {
    const launch = buildSshLaunch({ ...base, auth: "password", keyPath: undefined }, "/profile/zotkit-askpass.sh");
    expect(launch.argv).not.toContain("BatchMode=yes");
    expect(launch.env.SSH_ASKPASS).toBe("/profile/zotkit-askpass.sh");
    expect(launch.env.SSH_ASKPASS_REQUIRE).toBe("force");
    expect(JSON.stringify(launch)).not.toContain("password");
    expect(launch.env.ZOTKIT_SSH_PASSWORD).toBeUndefined();
  });

  it("askpass script echoes the env password", () => {
    expect(ASKPASS_SCRIPT).toContain("ZOTKIT_SSH_PASSWORD");
    expect(ASKPASS_SCRIPT.startsWith("#!/bin/sh")).toBe(true);
  });
});

describe("remote additional context", () => {
  const context = {
    attachment: { key: "A", libraryID: 1, title: "T", filename: "t.pdf", creators: [], tags: [] },
    parent: null,
    pdfPath: "/papers/t.pdf",
    page: { pageIndex: 0, pageNumber: 1, pageLabel: "1", text: "x", source: "pdfjs", warnings: [] },
    selection: null,
    warnings: [],
  } as never;

  it("omits local paths when includeLocalPaths is false", () => {
    const local = buildAdditionalContext(context, {}, { includeLocalPaths: true });
    const remote = buildAdditionalContext(context, {}, { includeLocalPaths: false });
    expect(JSON.stringify(local)).toContain("PDF path");
    expect(JSON.stringify(remote)).not.toContain("PDF path");
    expect(JSON.stringify(remote)).not.toContain("PDF directory");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/ssh-codex.test.ts`
Expected: FAIL(模块不存在 / `buildAdditionalContext` 未导出)。

- [ ] **Step 3: 写 `src/ssh-codex.ts`**

```ts
import { prefString, setPrefString } from "./platform";

export interface SshCodexProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: "key" | "password";
  keyPath?: string;
  remoteCodexPath: string;
}

export interface SshLaunch {
  argv: string[];
  env: Record<string, string>;
}

export const ASKPASS_SCRIPT = "#!/bin/sh\nprintf '%s\\n' \"$ZOTKIT_SSH_PASSWORD\"\n";

export function loadSshProfiles(): SshCodexProfile[] {
  try {
    const parsed = JSON.parse(prefString("sshProfiles", "[]")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSshProfile);
  }
  catch {
    return [];
  }
}

export function saveSshProfiles(profiles: SshCodexProfile[]): void {
  setPrefString("sshProfiles", JSON.stringify(profiles));
}

export function sshSecretRealm(profileId: string): string {
  return `zotkit-ssh:${profileId}`;
}

/**
 * Builds the ssh argv/env that pipes a remote `codex app-server --stdio`
 * through the native helper's spawnPipe. The password itself never appears
 * here: the service merges it into env as ZOTKIT_SSH_PASSWORD after reading
 * the Login Manager secret.
 */
export function buildSshLaunch(profile: SshCodexProfile, askpassPath: string | null): SshLaunch {
  const argv = ["ssh", "-T", "-p", String(profile.port || 22), "-o", "StrictHostKeyChecking=yes"];
  const env: Record<string, string> = { NO_COLOR: "1" };
  if (profile.auth === "key") {
    argv.push("-o", "BatchMode=yes");
    if (profile.keyPath) argv.push("-i", profile.keyPath);
  }
  else {
    if (askpassPath) env.SSH_ASKPASS = askpassPath;
    env.SSH_ASKPASS_REQUIRE = "force";
    env.DISPLAY = ":0";
  }
  argv.push(
    `${profile.user}@${profile.host}`,
    "--",
    profile.remoteCodexPath || "codex",
    "app-server",
    "--stdio",
  );
  return { argv, env };
}

function isSshProfile(value: unknown): value is SshCodexProfile {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.name === "string"
    && typeof record.host === "string"
    && typeof record.user === "string"
    && (record.auth === "key" || record.auth === "password")
    && typeof record.remoteCodexPath === "string";
}
```

- [ ] **Step 4: 服务集成(`src/codex-service.ts`)**

1. 导入 `buildSshLaunch/loadSshProfiles/sshSecretRealm/ASKPASS_SCRIPT` 与 `readSecret`(已有)。
2. 字段 `private remoteCodex = false;`。
3. `startCodexInternal` 里替换 spawn 段:

```ts
    const target = prefString("codexTarget", "local");
    let argv: string[];
    let env: Record<string, string>;
    if (target === "local") {
      this.remoteCodex = false;
      const executable = await findExecutable("codex");
      if (!executable) throw new Error("未找到 Codex CLI。请先安装 Codex，然后重试。");
      argv = [executable, "app-server", "--stdio"];
      env = { NO_COLOR: "1" };
    }
    else {
      const profile = loadSshProfiles().find((candidate) => candidate.id === target);
      if (!profile) throw new Error("找不到远程 Codex 配置，请检查设置");
      this.remoteCodex = true;
      let askpassPath: string | null = null;
      if (profile.auth === "password") {
        askpassPath = await this.ensureAskpassScript();
      }
      const launch = buildSshLaunch(profile, askpassPath);
      argv = launch.argv;
      env = launch.env;
      if (profile.auth === "password") {
        const password = await readSecret(sshSecretRealm(profile.id), profile.id);
        if (!password) throw new Error("远程 Codex 的 SSH 密码尚未保存，请在设置中填写");
        env.ZOTKIT_SSH_PASSWORD = password;
      }
    }
    const sessionId = randomID("appserver").slice(0, 64);
    await this.bridge.spawnPipe(sessionId, { argv, cwd: profilePath(), env });
```

4. 新增:

```ts
  private async ensureAskpassScript(): Promise<string> {
    const path = profilePath("zotkit-askpass.sh");
    await IOUtils.writeUTF8(path, ASKPASS_SCRIPT, { tmpPath: `${path}.tmp` });
    await IOUtils.setPermissions(path, 0o700);
    return path;
  }
```

5. capabilities:startCodexInternal 成功路径改为

```ts
      this.state.capabilities = this.remoteCodex
        ? { ...client.agentCapabilities, supportsAgentMode: false, supportsCheckpoints: false }
        : client.agentCapabilities;
```

6. 远程语义:`threadModeSettings`/`turnModeSettings` 开头加

```ts
    if (this.remoteCodex) {
      return {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "read-only",
        developerInstructions: ASK_DEVELOPER_INSTRUCTIONS,
        dynamicTools: this.dynamicToolSpecs(),
      } as ReturnType<CodexService["threadModeSettings"]>;
    }
```

(turnModeSettings 对应返回 `sandboxPolicy: { type: "readOnly", networkAccess: false }` 版本,不含 cwd/roots;若 tsc 报 cwd 必填,按类型定义补 `cwd: "/tmp"`。)
7. `buildAdditionalContext` 按 Interfaces 节改签名并 `export`;`sendToActiveTurn` 调用点传 `{ includeLocalPaths: !this.remoteCodex }`。
8. 远程连接失败包装(startCodexInternal 的 catch 或 start() 的 catch 处):target 非 local 时按 Interfaces 节文案包装后 rethrow。
9. `prefs.js` 加:

```js
pref("extensions.zotkit.codexTarget", "local");
pref("extensions.zotkit.sshProfiles", "[]");
```

- [ ] **Step 5: 跑测试与回归**

Run: `npx vitest run test/ssh-codex.test.ts && npm run check && npx vitest run`
Expected: 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/ssh-codex.ts src/codex-service.ts prefs.js test/ssh-codex.test.ts
git commit -m "feat: remote codex over SSH transport (key and askpass password auth)"
```

---

### Task 14: SSH 设置 UI + 文档 + 真机 smoke 清单

**Files:**
- Modify: `src/provider-settings.ts`(SSH 区块)
- Modify: `src/plugin.ts`(SSH 回调接线 + 后端重启)
- Modify: `zotero-plugin/README.md`(远程 Codex 一节)
- Test: 扩展 `test/provider-settings.test.ts`

**Interfaces:**
- `ProviderSettingsState` 追加:`sshProfiles: SshCodexProfile[]`、`codexTarget: string`("local" 或 profileId)。
- `ProviderSettingsCallbacks` 追加:`onSaveSsh(profile: SshCodexProfile, password: string | null): void`、`onDeleteSsh(profileId: string): void`、`onSelectCodexTarget(target: string): void`。
- 组件渲染:在 provider 表单之后加「远程 Codex（SSH）」区块——target 单选(`本机` + 每个 profile,类名 `zc-ssh-target`)、profile 列表(编辑/删除)、表单(名称/host/port/user/认证方式单选 key|password/keyPath/密码 password 输入/remoteCodexPath),保存按钮类名 `zc-ssh-save`;区块底部固定提示:“首次连接请先在终端 `ssh user@host` 一次以确认主机指纹。远程模式仅支持 Ask（只读）。”
- plugin 接线:
  - `onSaveSsh`:新条目 `id = randomID("ssh").slice(0, 24)`;`saveSshProfiles` upsert;password 非空 → `saveSecret(sshSecretRealm(id), id, password)`;刷新视图。
  - `onDeleteSsh`:移除 + `deleteSecret`;若被删的 profile 是当前 `codexTarget` → `setPrefString("codexTarget", "local")`。
  - `onSelectCodexTarget`:`setPrefString("codexTarget", target)`;若当前后端是 codex 且已连接 → `this.codex.stop(); await this.codex.start();`(重启拉起新传输),异常走 `reportError`。
  - `refreshProviderSettings` 组装 `sshProfiles: loadSshProfiles()`、`codexTarget: prefString("codexTarget", "local")`。

- [ ] **Step 1: 扩展 `test/provider-settings.test.ts`**

```ts
  it("renders the SSH section and submits a password-auth profile", () => {
    const { host, view, callbacks } = mount(); // mount() 需扩展返回含 onSaveSsh 等的 callbacks
    view.setState({
      providers: [],
      keyMask: {},
      statusText: null,
      busy: false,
      sshProfiles: [],
      codexTarget: "local",
    });
    expect(host.textContent).toContain("远程 Codex");
    host.querySelector<HTMLInputElement>(".zc-ssh-host")!.value = "lab.example.edu";
    host.querySelector<HTMLInputElement>(".zc-ssh-user")!.value = "eric";
    host.querySelector<HTMLSelectElement>(".zc-ssh-auth")!.value = "password";
    host.querySelector<HTMLInputElement>(".zc-ssh-password")!.value = "hunter2";
    host.querySelector<HTMLButtonElement>(".zc-ssh-save")!.click();
    const [profile, password] = callbacks.onSaveSsh.mock.calls[0]!;
    expect(profile.host).toBe("lab.example.edu");
    expect(profile.auth).toBe("password");
    expect(password).toBe("hunter2");
    expect(host.textContent).not.toContain("hunter2");
  });

  it("reports codex target selection", () => {
    const { host, view, callbacks } = mount();
    view.setState({
      providers: [], keyMask: {}, statusText: null, busy: false,
      sshProfiles: [{
        id: "s1", name: "lab", host: "h", port: 22, user: "u",
        auth: "key", remoteCodexPath: "codex",
      }],
      codexTarget: "local",
    });
    const radios = host.querySelectorAll<HTMLInputElement>(".zc-ssh-target");
    expect(radios.length).toBe(2); // 本机 + s1
    radios[1]!.click();
    expect(callbacks.onSelectCodexTarget).toHaveBeenCalledWith("s1");
  });
```

(`ProviderSettingsState` 的 `sshProfiles`/`codexTarget` 设为**必填**并同步修 Task 8 已有用例的 state 字面量——该文件此时全归本轮所有,直接改。)

- [ ] **Step 2: 跑测试确认失败,再实现**

Run: `npx vitest run test/provider-settings.test.ts`
实现 `provider-settings.ts` SSH 区块(单选 radio 用 `type="radio"` + `name="zc-ssh-target"`,change/click 触发 `onSelectCodexTarget`;表单/列表写法完全对齐本文件 provider 部分的既有风格),再实现 plugin.ts 接线(Interfaces 节清单)。

- [ ] **Step 3: README 远程 Codex 一节**(接在 Task 12 的“模型服务”节之后)

```markdown
### 远程 Codex（SSH）

如果你的 codex CLI 登录在一台远程 Linux 机器上，可以让 Zotero 直接借用它：

1. 先在终端 `ssh user@host` 成功登录一次（确认主机指纹进入 known_hosts）。
2. 设置面板 → 远程 Codex（SSH）→ 填 host / 用户名 / 认证方式（推荐密钥；密码存 Zotero 密码管理器）/ 远端 codex 路径（建议绝对路径，如 `~/.local/bin/codex`）。
3. 在「Codex 运行位置」里选中该远程配置。模型、账户、额度全部来自远端已登录的 codex。

限制：远程模式仅支持 Ask（只读）；Agent 模式、检查点在远程下不可用；SSH 断开后重新发送会自动重连。
```

- [ ] **Step 4: 全量回归**

Run: `npm run check && npx vitest run`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/provider-settings.ts src/plugin.ts test/provider-settings.test.ts README.md
git commit -m "feat: SSH remote-codex settings UI and target switching"
```

(README 路径按插件仓库实际文件名 `git add`。)

---

## 真机 smoke 清单(macOS,发布门槛,不阻塞合并)

在 Mac 上构建安装后逐项验证,结果记入 `.superpowers/sdd/progress.md`:

1. **流式手感**:引擎后端 + DeepSeek key,提问后文本逐段出现(验证 Zotero Gecko 的 fetch ReadableStream 路径;若整段一次性出现,回退路径在工作,记录之)。
2. **DeepSeek 全流程**:选中提问 → 留痕高亮(comment 含问题+要点)→ 已理解 → Note 生成 `.md` 附件。
3. **Kimi 双路**:开放平台 key(OpenAI wire)与 Kimi For Coding 订阅端点(Anthropic wire)各跑一轮问答。
4. **迁移旅程**:codex 订阅聊 2 轮 → 菜单切 DeepSeek → 携带历史 → 追问引用前文成立。
5. **错误路径**:错 key(401 文案)、断网、限流各一次;轮次以可读错误失败,无半截成功。
6. **无 codex 干净环境**:临时改名 codex 二进制,重启 Zotero,引擎后端全功能可用,无「未找到 Codex CLI」报错。
7. **Login Manager**:重启 Zotero 后 key 仍在;prefs 文件里 grep 不到 key。
8. **远程 codex**:密钥认证 + 密码认证各连一次远程 Linux;提问、留痕、Noting;断开 SSH 后重试报可读错误并可重连;known_hosts 未收录时的报错文案含指引。
9. **性能**:引擎空闲时 CPU 0%,无轮询。

## Self-review 记录

- Spec 覆盖:决策表逐条 → Task 1(接口/守卫)、2–6(引擎)、4/8/10(provider+key+UI)、7(双后端+迁移+无 codex 启动)、9/10(两级菜单/引导/切换卡)、11(Anthropic/Kimi 订阅)、12(零写保证验收+文档)、13/14(SSH);spec 第八节验收 1–5 对应 Task 12 测试 + smoke 清单 2/4/5/6/8。
- 一致性:`agentCapabilities` 字段名、`engine:<providerId>:<modelId>`、`turn/failed` 参数形状、`EngineHistoryMessage`、`providerKeyRealm`/`sshSecretRealm` 在各任务间已交叉核对。
- 已知取舍(实施时不要“修复”):引导卡合并了 spec 的“升级用户一次性选择卡”(零 provider 卡上的「继续用 Codex」即该路径);引擎侧 steer 不支持,发送中追加会得到可读错误;`testProvider` 在 Task 4–10 期间对 anthropic profile 报“后续版本提供”,Task 11 解除。
