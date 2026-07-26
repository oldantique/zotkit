# 设计:内置 Agent 引擎(自主工作流)+ AgentClient 双后端抽象

日期:2026-07-26
分支:`feature/zotero-reader-codex-integration`
范围:仅 `zotero-plugin/`(TypeScript;不涉及 macOS 原生 helper 与 Python CLI)
前置:paper-trail + Noting 已合入本分支(spec `2026-07-25-paper-trail-noting-design.md`)

## 目标

让 Zotero Research Chat 的完整体验(Ask 聊天、留痕高亮、Noting 笔记)**不依赖任何订阅制
agent CLI**。用户对标的体验是 ChatGPT 网页端 chatbot——但宿主是 Zotero:装 XPI、填一个
API key,即可用任意 OpenAI/Anthropic 兼容模型服务(尤其 Kimi、DeepSeek)完成全部阅读
工作流。

一句话:把今天由 codex app-server 代劳的「模型循环编排」收回插件自己手里;codex 降为
可选后端。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 形态 | **插件内置引擎**(TS,进程内直连 HTTP)。不做 CLI、不做无头服务——工具执行本就在插件侧,codex 真正提供的只是模型循环,Ask 语义下插件可自持 |
| codex 去留 | **双后端共存**:内置引擎为默认,codex 为可选(订阅用户、Agent 模式、高级终端保留) |
| 抽象层切位 | **客户端缝合层(方案乙)**:在 `CodexAppServerClient` 高度定义 `AgentClient` 接口;`EngineClient` 与之**并列**实现同一接口,谁也不融合谁;`codex-service.ts` 泛化为后端无关的会话状态机 |
| 接入面 | **两套 wire**:OpenAI 兼容(Kimi 开放平台/DeepSeek/OpenRouter/Ollama/OpenAI/自定义端点)+ Anthropic 兼容(Anthropic key、Kimi For Coding 订阅端点) |
| 跨后端迁移 | **codex → 引擎携带历史续聊进 v1**(转录导入);反方向只能开新会话(codex 不接受注入历史),明示不对称 |
| 独立性验收 | **无 codex 的干净机器必须完整可用**:装 XPI + 填 key = 全部 Reader 功能;引擎后端下不探测 codex |
| 远程 Codex | **支持 SSH 连接远端 Linux 上已登录的 codex CLI**(密钥或密码认证):同一 CodexAppServerClient,仅传输层换为 `ssh` 拉起远端进程;Ask-only,Agent 模式禁用 |
| Agent 模式(shell/文件写/沙箱) | 不进引擎,仍为 codex/claude 专属——这不在对标的 ChatGPT 体验内 |

方案甲(服务层平行双轨)被否:留痕/Noting/会话逻辑要么复制要么继续困在 codex-service。
方案丙(一步到位 ChatBackend 大抽象 + ACP 适配)被否:一次动两条腿,ACP 将来可在乙的
接口上演化,YAGNI。

## 一、架构总览

```
UI (sidebar / float-panel / terminal)
        │
session-service(codex-service.ts 泛化改名)
  会话状态机:entries、留痕 hook、Noting、sessions、工具注册表 —— 后端无关
        │  消费 AgentClient 接口
        ├── CodexAppServerClient(现状,实现 AgentClient,行为不变)
        │     ├── 本地传输:helper spawnPipe → `codex app-server --stdio`
        │     └── SSH 传输:helper spawnPipe → `ssh … <远端codex> app-server --stdio`
        └── EngineClient(新增,进程内)
                ├── agent loop(消息组装 → 流式请求 → 工具调用循环 → 中断)
                ├── OpenAIWire 适配器
                └── AnthropicWire 适配器
```

## 二、AgentClient 接口契约

从现状萃取,只收窄不发明。接口覆盖会话状态机实际消费的语义:

```ts
interface AgentClient {
  initialize(): Promise<void>;
  close(): Promise<void>;
  listModels(): Promise<ModelOption[]>;
  accountState(): AgentAccountState;
  // { kind: "subscription" | "apiKey"; label: string; ready: boolean }

  startThread(params: AgentThreadParams): Promise<string>; // → threadId
  // params 含 developerInstructions、dynamicTools(JSON Schema 工具规格,
  // 与现有 CodexDynamicToolSpec 同型——OpenAI/Anthropic 的 tools 都吃 JSON Schema)
  startTurn(threadId: string, input: AgentTurnInput): Promise<string>; // → turnId
  // input 含正文、Reader 上下文附件(由 session-service 组装,后端无关)、model、effort
  interrupt(threadId: string, turnId: string): Promise<void>;
  readThreadTurns(threadId: string): Promise<AgentTurnRecord[]>;

  runUtilityTurn(prompt: string, opts: { timeoutMs: number; model?: string }): Promise<string>;
  // codex 实现 = 现有隐藏线程;引擎实现 = 一次无线程单发调用。
  // 语义沿用既有铁律:失败/超时必须 reject,绝不把半截流当成功返回。

  onEvent(handler: (event: AgentClientEvent) => void): () => void;

  readonly capabilities: AgentCapabilities;
  // { supportsAgentMode; supportsApprovals; supportsReasoningEffort(model 级);
  //   supportsLogin; supportsHistoryImport }
}
```

**统一事件流**(引擎只发核心集;codex 客户端把自己的通知映射到核心集,codex 专属的
plan/审批/diff 类通知以扩展事件原样透传,现有渲染路径不变):

```ts
type AgentClientEvent =
  | { type: "textDelta"; threadId; turnId; delta: string }
  | { type: "toolCallBegin"; threadId; turnId; callId; toolName; args: JsonValue }
  | { type: "toolCallEnd"; threadId; turnId; callId; result: JsonValue; isError: boolean }
  | { type: "turnCompleted"; threadId; turnId }
  | { type: "turnFailed"; threadId; turnId; errorText: string }
  | { type: "backendExtension"; threadId; payload: JsonValue }; // codex 专属卡片透传
```

UI 依据 `capabilities` 隐藏 codex 专属控件(Agent 开关、审批卡、plan 卡),禁止散落
`if (backend === "codex")` 判断。

## 三、EngineClient 内部

### agent loop

```
组装消息:developerInstructions(system)+ 迁移历史(如有)+ 历史轮次
        + 本轮 Reader 上下文附件 + 用户输入
→ wire.buildRequest(messages, tools, {model, effort, stream: true})
→ 流式解析:textDelta 逐段上抛
→ 模型发起工具调用 → 执行现有只读工具注册表中的处理器(与 codex 路径同一注册表、
  同一执行器)→ 结果以 tool 消息喂回 → 继续循环
→ 护栏:单轮最多 8 次工具调用迭代,超出以 turnFailed 结束("工具调用次数超限")
→ 中断:AbortController;interrupt() → abort 当前 HTTP 流 → turnFailed("已中断")
```

### wire 适配器(无状态,fixture 可单测)

```ts
interface WireAdapter {
  buildRequest(messages, tools, params): { url; headers; body };
  parseStream(chunk: Uint8Array, state): WireEvent[];
  // WireEvent: textDelta | toolCallDelta(增量拼装) | usage | stop | error
}
```

- **OpenAIWire**:`POST {baseUrl}/chat/completions`,SSE `data:` 行,`tool_calls` 增量
  按 index 拼装;`reasoning_effort` 仅当模型声明支持时传。
- **AnthropicWire**:`POST {baseUrl}/v1/messages`,事件流(`content_block_delta` 等),
  `tool_use` block;effort 映射到 thinking budget(声明支持时)。
- 认证头:OpenAI 系 `Authorization: Bearer`;Anthropic 系 `x-api-key` + `anthropic-version`。

### 上下文管理(截断策略,数值钉死)

- 每个模型条目带 `contextWindow`(tokens,预设未填时默认 131072)。
- token 估算:`Math.ceil(chars / 3)`(中英混合保守值)。
- 预算 = contextWindow − 8192(输出预留)。组装顺序:system + 本轮附件 + 从最新往旧
  收历史轮;超预算时**丢弃最旧的对话轮**(成对丢 user/assistant),system 与本轮附件
  永不丢。附件本身沿用现状的有界组装,不在引擎里二次截断。

### 流式传输(首要技术风险,作为 spike 先行)

Zotero 的 Gecko 运行时优先用 `fetch` + ReadableStream 增量读;不可用则回退
`XMLHttpRequest` + `onprogress` 增量切片。Spike 结论写进实施记录,真机 smoke 必测。

## 四、Provider 配置与 key 存储

```ts
interface ProviderProfile {
  id: string;               // 稳定随机 ID
  name: string;             // 显示名
  wire: "openai" | "anthropic";
  baseUrl: string;
  models: { id: string; label: string; contextWindow?: number;
            supportsReasoningEffort?: boolean }[];
  defaultModel: string;
}
```

- Profile 列表存 pref `extensions.zotkit.providers`(JSON,**不含 key**)。
- **API key 存 Zotero Login Manager**(`Services.logins`):origin `chrome://zotkit`,
  realm `zotkit-provider:<providerId>`,username = providerId,password = key。
  界面只显示尾号 4 位;key 不进 prefs、不进日志;错误消息脱敏(不回显 key)。
- 预设模板(baseUrl 预填,key 用户粘贴):

| 预设 | wire | baseUrl |
|---|---|---|
| DeepSeek | openai | `https://api.deepseek.com` |
| Kimi(月之暗面开放平台) | openai | `https://api.moonshot.cn/v1` |
| Kimi For Coding(订阅) | anthropic | 留空模板,用户按官方文档填(端点随官方变动,附条款提醒:该端点面向 coding agent,使用场景合规性以 Moonshot 条款为准) |
| OpenRouter | openai | `https://openrouter.ai/api/v1` |
| Ollama(本地) | openai | `http://localhost:11434/v1` |
| OpenAI | openai | `https://api.openai.com/v1` |
| Anthropic | anthropic | `https://api.anthropic.com` |
| 自定义 | 二选一 | 用户填 |

- 添加/编辑界面**明示数据外发**:「对话内容(含论文摘录、批注)将发送到该端点」。
- 连通性测试按钮:一次最小 completion 调用,报可读结果(401 → key 无效;404 → 模型名
  或 baseUrl 有误;超时 → 网络/端点不可达)。

## 五、UI 变化

- **模型菜单两级化**:`内置引擎 → <provider> → <model>` 与 `Codex(订阅) → <model>`。
  沿用现有 ModelOption 渲染,分组头新增。
- **账户卡按后端**:引擎侧显示 `<provider> · key ····1234 · 就绪`;codex 侧现状不变。
- **默认后端** pref `extensions.zotkit.backend`:`"engine" | "codex"`,默认 `"engine"`。
- **启动不再依赖 codex**:`findExecutable("codex")` 仅在用户选择/使用 codex 后端时调用;
  引擎后端路径零探测。
- **引导卡**(替代现在的「未找到 Codex CLI」报错):默认后端为引擎且无任何 provider 时,
  聊天面板显示「添加模型服务」引导卡 → 跳设置;升级用户首次运行时若无 provider 且检测到
  codex 曾在用(存在历史会话),显示一次性卡片:「继续用 Codex(订阅)」(写 pref 为
  codex)/「添加 API 服务」。
- **reasoning-effort 控件**仅当所选模型 `supportsReasoningEffort` 时显示。
- 留痕、Noting、问题清单、⌘K 浮窗:零改动(只与 session-service 对话)。

## 六、会话持久化与跨后端迁移

- 每个线程记录 `backend: "engine" | "codex"`(engine 线程另记 providerId + model);
  恢复会话回到原后端。codex 线程转录仍由 codex 管;**引擎线程由插件持久化**:profile
  目录下每线程一个 JSONL 转录文件(逐轮 append:role、文本、时间戳、工具调用摘要),
  `readThreadTurns` 读自己的转录。sessions.json 只存索引与 AnchorRecord,不存正文。
- **codex → 引擎携带历史(v1)**:对话中途切换后端时弹选择卡「携带对话历史继续(推荐)/
  开新会话」。携带 = `readThreadTurns(codex 线程)` → 仅取 user/assistant 文本轮次
  (跳过工具调用与推理细节)→ 以 role 对应的消息序列作为新引擎线程的开场历史,首条
  system 注记「以下为从先前会话迁移的历史」→ 走统一截断策略。
- **不对称明示**:引擎 → codex 只能开新会话(可选附前文摘要);UI 文案说明。
- **锚点跨迁移行为**:旧锚点的 threadId/turnRange 冻结,跳转回看原 codex 转录照常;
  迁移后在旧锚点「继续对话」,追问落在当前活跃引擎线程(带该锚点选区上下文);新锚点
  正常绑定引擎线程。

## 六点五、远程 Codex(SSH 传输变体)

目标:用户在远端 Linux 上已登录 codex(订阅可用),Mac 上的 Zotero 直接借用该登录态。

- **机制**:协议与客户端零改动。helper `spawnPipe` 的 argv 换为
  `ssh -T [-p <port>] [-i <keyPath>] [-o BatchMode=yes] <user>@<host> -- <remoteCodexPath> app-server --stdio`,
  JSONL 走 SSH stdio 管道。helper 无命令白名单,无需改动(已核实)。
- **认证两式**:
  - 密钥(推荐):`-i` 指定私钥,私钥无口令或已加入 ssh-agent;`BatchMode=yes` 保证
    绝不落入交互提示。
  - 密码:macOS 12+ 自带 OpenSSH ≥ 8.6,用 `SSH_ASKPASS_REQUIRE=force` + 插件捆绑的
    askpass 脚本;密码存 Login Manager(realm `zotkit-ssh:<profileId>`),经 spawnPipe
    的 env 传给 askpass;此模式不设 BatchMode。
  - **host key**:不做指纹确认 UI;要求 `known_hosts` 已含目标主机(用户先在终端手动
    ssh 一次)。未知主机 → 连接失败,错误文案给出「先在终端 ssh 一次以确认主机指纹」
    指引。禁用 `StrictHostKeyChecking=no` 之类的降级。
- **SshCodexProfile**:`{ id, name, host, port(默认22), user, auth: "key"|"password",
  keyPath?, remoteCodexPath(默认 "codex") }`,存 prefs(不含密码)。注意 ssh 远程命令
  不加载 login shell 的完整 PATH,`codex` 可能解析失败——连接测试失败时提示改填绝对
  路径(如 `~/.local/bin/codex`)。
- **语义边界**(与本地 codex 的差异,UI 需体现):
  - 账户/模型/推理:全部来自远端已登录的 codex——这正是目的。
  - `zotero_*` 动态工具仍在**插件本地**执行,论文上下文与检索照常。
  - codex 自身的文件/shell 操作发生在**远端文件系统**:远程模式下 cwd 固定为远端
    `~`,不传本地 workspaceRoots;**Agent 模式禁用**(`capabilities.supportsAgentMode
    = false`),Ask-only;附件项中略去本地 PDF 路径/目录(远端不可读),indexed 全文
    (纯文本)照附。
  - 高级 PTY 终端不随远程模式提供(范围外)。
- **生命周期**:SSH 断开表现为会话关闭,复用现有 CodexDisconnectedError/重启路径;
  重连 = 重新 spawn。远端 codex 版本需满足与本地相同的 app-server 协议兼容,
  initialize 时校验。
- **后端选择模型**:pref `extensions.zotkit.backend` 仍为 `"engine" | "codex"`;codex
  后端内部有 `target: "local" | <sshProfileId>`。线程记录 backend + target,恢复回到
  原处。模型菜单显示为 `Codex(本机)` / `Codex(远程 · <name>)` 两个分组。
  codex(远程)→ 引擎的历史迁移与本地 codex 同机制(转录在协议层读取,与传输无关)。
- **测试**:argv/env 构造(两种认证、端口、绝对路径)与密码脱敏单测;契约测试不区分
  传输(mock socket 已覆盖);真机 smoke 增补「远程 Linux codex 全流程」。

## 七、安全模型

- **确定性写入保证原样成立**(ADR-0002):引擎与 codex 共用同一个只读工具注册表与
  执行器;模型(任何 provider 的)拿到的工具清单里没有任何 Zotero 写工具。工具注册表
  组合测试扩展为**对两个后端同时断言**。
- 引擎只向用户显式配置的 baseUrl 发起请求;不内置任何默认远端。
- key 全生命周期:Login Manager 存取、UI 尾号显示、日志与错误脱敏。
- 数据外发知情:provider 添加界面明示 + README 说明(与 codex 同类别的外发,区别是
  端点由用户自选)。
- 注入面不变:论文内容在 prompt 中仍按既有 untrusted 包装策略处理(Noting 的
  `<untrusted_paper_content>` 机制照旧,与后端无关)。

## 八、测试与验收

- **AgentClient 契约测试**(双后端不漂移的关键):同一套契约用例分别跑
  CodexAppServerClient(mock socket)与 EngineClient(fake HTTP):线程/轮次生命周期、
  事件顺序、turnFailed 必 reject、interrupt、readThreadTurns、runUtilityTurn 超时。
- wire 适配器:构造 SSE fixture(OpenAI chunk 与 Anthropic event 两套)单测请求构造
  与流解析,含工具调用增量拼装、中途 error 事件、畸形块。
- agent loop:fake 适配器测工具循环、8 次上限、中断、工具执行抛错 → toolCallEnd(isError)。
- 迁移:codex 转录 → 消息序列转换(过滤工具轮)、超长截断、锚点冻结行为。
- 现有 365 测试在重构里程碑(M1)后保持全绿。

**验收标准(用户旅程)**:

1. 干净机器(无 codex/Node/Python):装 XPI → 设置里选 DeepSeek 预设粘 key →
   打开 PDF 提问、留痕、已理解、Note 出 `.md`——全流程可用。
2. codex 订阅用户:升级后行为不变;模型菜单选 DeepSeek 两级项 + 确认「携带历史」,
   在同一对话上下文里无缝续聊,账户卡切换显示。
3. 无 provider、无 codex:不报错,显示引导卡。
4. 断网/401/限流:轮次以可读错误失败,不吞成半截成功;留痕要点降级路径(答案首段
   截断)照常工作。
5. 远程 codex 用户:配置 SSH profile(密钥或密码)→ 连接测试通过 → 模型菜单选
   `Codex(远程)` → 提问、留痕、Noting 全流程走远端订阅;SSH 断开报可读错误,重连
   恢复。

## 九、实施顺序

1. **M1 重构**:萃取 AgentClient 接口,codex-service 泛化为 session-service,
   CodexAppServerClient 适配接口。纯重构,365 测试全绿。
2. **M0.5 spike(与 M1 并行)**:Zotero 内 fetch 流式验证,定 fetch/XHR 路线。
3. **M2**:OpenAIWire + agent loop + EngineClient + 契约测试。
4. **M3**:ProviderProfile + Login Manager 存取 + 设置面板(含预设与连通性测试)。
5. **M4**:UI 两级模型菜单、账户卡、capability 隐藏、引导卡、启动去 codex 依赖。
6. **M5**:引擎线程 JSONL 持久化 + 留痕/Noting 经 `runUtilityTurn` 接通 + codex → 引擎
   历史迁移。
7. **M6**:AnthropicWire(Anthropic key / Kimi For Coding)。
8. **M7**:远程 Codex(SSH 传输):SshCodexProfile + argv/env 构造 + askpass + 设置
   面板 + 远程语义边界(Ask-only、远端 cwd)。仅依赖 M1,可与 M2–M6 并行。
9. **M8**:macOS 真机 smoke:流式手感、Kimi/DeepSeek 实测、迁移旅程、错误路径、
   远程 Linux codex 全流程。

## 范围外(明确不做)

- ACP 协议适配、claude CLI 作为 Reader 聊天后端(将来在 AgentClient 上演化)
- 引擎内 Agent 模式(shell/文件写/沙箱)
- 引擎 → codex 的历史迁移
- Web 搜索等 ChatGPT 附加能力
- 自研独立 CLI 产品(本轮已明确还原为插件内置引擎)
