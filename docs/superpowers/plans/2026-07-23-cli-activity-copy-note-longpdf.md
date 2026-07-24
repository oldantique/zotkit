# CLI 式状态行、复制体验、Note 同步与长 PDF 支持 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把聊天过程事件收敛为 CLI 式原位状态行(浮窗+侧边栏),补齐回答/公式复制,自动把问答沉淀为 Zotero note,并修复全文 100 页截断、新增 PDF 大纲工具。

**Architecture:** 纯视图层分组(`exchanges.ts` 共享工具)+ 插件控制器的轮次计时,note 同步为独立模块(纯合并函数 + 薄 Zotero 壳),reader-context 修截断判定并加大纲适配器。

**Tech Stack:** TypeScript strict(tsc 7)、Vitest 4 + happy-dom、esbuild;不新增 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-07-23-cli-activity-copy-note-sync-design.md`(必读,含用户已确认的决策)

## Global Constraints

- 本机 `npm ci --offline` 装依赖;**绝不运行** `npm run build`、`npm run verify`、`npm run native:*`(需 macOS)。测试:`npx vitest run`;类型:`npx tsc --noEmit`。
- 视图遵循现有模式:`constructor(host, callbacks)` + `setState(partial)` + `destroy()`;渲染用 DOM API,不用 innerHTML 拼接不可信文本。
- 所有用户可见新文案用中文,与现有 UI 一致(如"思考中…"、"已复制")。
- 提交信息末尾:`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 基线:现有测试全绿(≈195 项)。每任务结束跑全套 `npx vitest run` 确认无回归。
- KaTeX 已内置(`katex` 0.18.1),浮窗与侧边栏共用 `renderMarkdown`(`src/markdown.ts`)。

---

### Task 1: `exchanges.ts` 分组与格式化工具

**Files:**
- Create: `zotero-plugin/src/exchanges.ts`
- Test: `zotero-plugin/test/exchanges.test.ts`

**Interfaces (Produces):**
```ts
export interface Exchange { id: string; entries: ChatEntry[] }
export function groupEntries(entries: ChatEntry[]): Exchange[];
export function isProcessKind(kind: ChatEntry["kind"]): boolean; // reasoning|tool|command
export function processEntries(exchange: Exchange): ChatEntry[];
export function contentEntries(exchange: Exchange): ChatEntry[]; // 其余(user/assistant/error/status)
export function activityLabel(entries: ChatEntry[]): string;
export function friendlyToolName(tool: string): string;
export function formatElapsed(ms: number): string; // "28s" / "1m 42s"
```

- [ ] **Step 1: 失败测试** — `test/exchanges.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  activityLabel, contentEntries, formatElapsed, friendlyToolName,
  groupEntries, processEntries,
} from "../src/exchanges";
import type { ChatEntry } from "../src/sidebar";

const e = (id: string, kind: ChatEntry["kind"], extra: Partial<ChatEntry> = {}): ChatEntry =>
  ({ id, kind, text: "", ...extra }) as ChatEntry;

describe("groupEntries", () => {
  it("splits before each user entry and keeps a preamble group", () => {
    const groups = groupEntries([
      e("s1", "status"), e("u1", "user"), e("r1", "reasoning"), e("a1", "assistant"),
      e("u2", "user"), e("t1", "tool"), e("a2", "assistant"),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["preamble", "u1", "u2"]);
    expect(groups[1]!.entries.map((x) => x.id)).toEqual(["u1", "r1", "a1"]);
    expect(processEntries(groups[2]!).map((x) => x.id)).toEqual(["t1"]);
    expect(contentEntries(groups[2]!).map((x) => x.id)).toEqual(["u2", "a2"]);
  });
});

describe("activityLabel", () => {
  it("labels the latest running entry by kind", () => {
    expect(activityLabel([e("r", "reasoning", { state: "running" })])).toBe("思考中…");
    expect(activityLabel([
      e("r", "reasoning", { state: "complete" }),
      e("t", "tool", { state: "running", title: "zotero_read_pdf_pages" }),
    ])).toBe("正在调用 读取论文页面");
    expect(activityLabel([e("c", "command", { state: "running" })])).toBe("执行命令…");
    expect(activityLabel([e("a", "assistant", { state: "running" })])).toBe("正在撰写回答…");
    expect(activityLabel([e("a", "assistant", { state: "complete" })])).toBe("思考中…");
  });
});

describe("friendlyToolName / formatElapsed", () => {
  it("maps known tools and passes through unknown ones", () => {
    expect(friendlyToolName("zotero_search_current_pdf")).toBe("检索本篇 PDF");
    expect(friendlyToolName("unknown_tool")).toBe("unknown_tool");
  });
  it("formats seconds and minutes", () => {
    expect(formatElapsed(4_200)).toBe("4s");
    expect(formatElapsed(102_000)).toBe("1m 42s");
    expect(formatElapsed(500)).toBe("1s"); // 向上取整,不显示 0s
  });
});
```

- [ ] **Step 2:** `npx vitest run test/exchanges.test.ts` → FAIL(模块不存在)。
- [ ] **Step 3: 实现** `src/exchanges.ts`:

```ts
import type { ChatEntry } from "./sidebar";

export interface Exchange { id: string; entries: ChatEntry[] }

const PROCESS_KINDS = new Set<ChatEntry["kind"]>(["reasoning", "tool", "command"]);

const FRIENDLY_TOOL_NAMES: Record<string, string> = {
  zotero_get_reader_context: "读取阅读器上下文",
  zotero_get_current_page: "读取当前页",
  zotero_get_current_selection: "读取选中文本",
  zotero_search_current_pdf: "检索本篇 PDF",
  zotero_read_pdf_pages: "读取论文页面",
  zotero_search_library: "检索文库",
  zotero_read_library_pdf_pages: "读取文库论文页面",
  zotero_search_library_pdf: "检索文库 PDF",
  zotero_list_annotations: "查看批注",
  zotero_get_pdf_outline: "读取论文目录",
};

export function isProcessKind(kind: ChatEntry["kind"]): boolean {
  return PROCESS_KINDS.has(kind);
}

export function groupEntries(entries: ChatEntry[]): Exchange[] {
  const groups: Exchange[] = [];
  let current: Exchange | null = null;
  for (const entry of entries) {
    if (entry.kind === "user" || !current) {
      current = { id: entry.kind === "user" ? entry.id : "preamble", entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}

export function processEntries(exchange: Exchange): ChatEntry[] {
  return exchange.entries.filter((entry) => isProcessKind(entry.kind));
}

export function contentEntries(exchange: Exchange): ChatEntry[] {
  return exchange.entries.filter((entry) => !isProcessKind(entry.kind));
}

export function friendlyToolName(tool: string): string {
  return FRIENDLY_TOOL_NAMES[tool] ?? tool;
}

export function activityLabel(entries: ChatEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.state !== "running") continue;
    if (entry.kind === "reasoning") return "思考中…";
    if (entry.kind === "tool") return `正在调用 ${friendlyToolName(entry.title || "工具")}`;
    if (entry.kind === "command") return "执行命令…";
    if (entry.kind === "assistant") return "正在撰写回答…";
  }
  return "思考中…";
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}
```

注意:`ChatEntry` 的 `state`/`title` 为可选字段,以 `src/sidebar.ts` 的实际接口为准。
- [ ] **Step 4:** `npx vitest run test/exchanges.test.ts` → PASS;`npx tsc --noEmit` 干净。
- [ ] **Step 5:** `git add -A && git commit -m "feat(plugin): exchange grouping and activity formatting helpers"`

---

### Task 2: 插件轮次计时与元数据

**Files:**
- Modify: `zotero-plugin/src/plugin.ts`
- Test: `zotero-plugin/test/plugin-state.test.ts`(追加)

**Interfaces:**
- Consumes: `CodexService.state.activeThreadId/running`(src/codex-service.ts:95-106)、`getChatEntries()`。
- Produces: `TurnMeta { elapsedMs: number; completedAt: string; model: string }`;私有 `turnMeta: Map<threadId, Map<userEntryId, TurnMeta>>`;view state 新字段 `turnStartedAt: number | null`、`turnDurations: Record<string, number>`(仅活跃线程,key 为该轮 user 条目 id)。Task 8 消费 `turnMeta` 与新钩子 `onTurnCompleted(threadId: string)`(protected 方法,本任务先留空实现)。

- [ ] **Step 1: 失败测试** — 在 `test/plugin-state.test.ts` 的现有 stub 风格上追加(参考该文件已有的 renderFloatPanels stub 写法;codex stub 需含 `state: { running, activeThreadId, ... }` 与 `getChatEntries()`):

```ts
it("records turn duration keyed by the opening user entry when running flips off", () => {
  const plugin = createPluginForRenderTests(); // 复用该文件既有工厂/stub 模式
  plugin.codex.state.activeThreadId = "th1";
  plugin.codex.state.running = true;
  plugin.codex.getChatEntries = () => [
    { id: "u1", kind: "user", text: "问" },
    { id: "a1", kind: "assistant", text: "答" },
  ];
  vi.setSystemTime(new Date("2026-07-23T10:00:00Z"));
  plugin.renderChatViews();
  vi.setSystemTime(new Date("2026-07-23T10:00:28Z"));
  plugin.codex.state.running = false;
  plugin.renderChatViews();
  expect(plugin.turnDurationsForActiveThread()).toEqual({ u1: 28_000 });
});
```

(测试内用 `vi.useFakeTimers()`/`vi.useRealTimers()` 包裹;若既有工厂不暴露 codex stub 可写字段,按该文件已有做法调整。)
- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3: 实现** `plugin.ts`:

```ts
interface TurnMeta { elapsedMs: number; completedAt: string; model: string }

private readonly turnStartedAt = new Map<string, number>();
private readonly turnMeta = new Map<string, Map<string, TurnMeta>>();

turnDurationsForActiveThread(): Record<string, number> {
  const threadId = this.codex?.state.activeThreadId;
  const meta = threadId ? this.turnMeta.get(threadId) : undefined;
  const out: Record<string, number> = {};
  if (meta) for (const [id, value] of meta) out[id] = value.elapsedMs;
  return out;
}

private trackTurnTiming(): void {
  const threadId = this.codex?.state.activeThreadId;
  if (!threadId) return;
  const running = Boolean(this.codex?.state.running);
  const started = this.turnStartedAt.get(threadId);
  if (running && started === undefined) {
    this.turnStartedAt.set(threadId, Date.now());
    return;
  }
  if (!running && started !== undefined) {
    this.turnStartedAt.delete(threadId);
    const entries = this.codex?.getChatEntries() ?? [];
    let lastUserId: string | null = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.kind === "user") { lastUserId = entries[i]!.id; break; }
    }
    if (!lastUserId) return;
    const perThread = this.turnMeta.get(threadId) ?? new Map<string, TurnMeta>();
    perThread.set(lastUserId, {
      elapsedMs: Date.now() - started,
      completedAt: new Date().toISOString(),
      model: this.selectedModel,
    });
    this.turnMeta.set(threadId, perThread);
    this.onTurnCompleted(threadId);
  }
}

protected onTurnCompleted(_threadId: string): void {} // Task 8 填充 note 同步
```

`renderChatViews()` 第一行调用 `this.trackTurnTiming()`。侧边栏与浮窗的 setState(plugin.ts:792、907 附近)各追加:

```ts
turnStartedAt: (this.codex?.state.running
  ? this.turnStartedAt.get(this.codex.state.activeThreadId ?? "") ?? null
  : null),
turnDurations: this.turnDurationsForActiveThread(),
```

同时在 `sidebar.ts` 的 state 接口、初始值上加 `turnStartedAt: number | null`(初始 `null`)与 `turnDurations: Record<string, number>`(初始 `{}`);`float-panel.ts` 同样(本任务只加字段与初始值,渲染逻辑在 Task 3/4)。
- [ ] **Step 4:** 目标测试 PASS;`npx vitest run` 全绿;tsc 干净。
- [ ] **Step 5:** `git commit -m "feat(plugin): per-turn timing metadata keyed by opening user entry"`

---

### Task 3: 侧边栏状态行/摘要行/钉底

**Files:**
- Modify: `zotero-plugin/src/sidebar.ts`(`renderTranscript`、`renderEntry` 周边)、`zotero-plugin/src/styles.css`
- Test: `zotero-plugin/test/sidebar.test.ts`(追加)

**Interfaces:** Consumes Task 1 全部导出与 Task 2 state 字段。CSS 类(浮窗 Task 4 复用):`.zc-activity`、`.zc-activity-spinner`、`.zc-activity-label`、`.zc-activity-elapsed`、`.zc-turn-summary`、`.zc-turn-detail`。

- [ ] **Step 1: 失败测试** — `test/sidebar.test.ts` 追加(沿用该文件现有 mount/setState 帮手):

```ts
describe("SidebarView activity line", () => {
  it("collapses running process entries into a single activity line", () => {
    const { view, host } = mountSidebar();
    view.setState({
      running: true, turnStartedAt: Date.now(),
      entries: [
        { id: "u1", kind: "user", text: "问" },
        { id: "r1", kind: "reasoning", title: "思考过程", text: "…", state: "complete" },
        { id: "t1", kind: "tool", title: "zotero_read_pdf_pages", text: "", state: "running" },
      ],
    });
    expect(host.querySelectorAll(".zc-tool-card").length).toBe(0);
    const label = host.querySelector(".zc-activity-label")!;
    expect(label.textContent).toBe("正在调用 读取论文页面");
  });

  it("renders an expandable summary line after completion", () => {
    const { view, host } = mountSidebar();
    view.setState({
      running: false, turnDurations: { u1: 28_000 },
      entries: [
        { id: "u1", kind: "user", text: "问" },
        { id: "t1", kind: "tool", title: "zotero_read_pdf_pages", text: "done", state: "complete" },
        { id: "a1", kind: "assistant", text: "答", state: "complete" },
      ],
    });
    expect(host.querySelector(".zc-activity")).toBeNull();
    const summary = host.querySelector(".zc-turn-summary")!;
    expect(summary.textContent).toContain("28s");
    expect(summary.textContent).toContain("1 个步骤");
    expect(host.querySelector(".zc-turn-detail")).toBeNull();
    (summary as HTMLElement).click();
    expect(host.querySelectorAll(".zc-turn-detail .zc-tool-card").length).toBe(1);
    (summary as HTMLElement).click();
    expect(host.querySelector(".zc-turn-detail")).toBeNull();
  });

  it("omits the summary line when there is nothing to report", () => {
    const { view, host } = mountSidebar();
    view.setState({ running: false, turnDurations: {}, entries: [
      { id: "u1", kind: "user", text: "问" },
      { id: "a1", kind: "assistant", text: "答", state: "complete" },
    ]});
    expect(host.querySelector(".zc-turn-summary")).toBeNull();
  });
});
```

- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3: 实现**(sidebar.ts):
  - `renderTranscript()` 改为:`const groups = groupEntries(this.state.entries)`;逐组渲染 `contentEntries`(沿用 `cachedEntryNode` 与现有 `renderEntry`;plan/approval/diff/checkpoint 卡片的现有插入逻辑不动)。
  - 每组(`preamble` 除外)在内容之后按规则渲染摘要行:`const steps = processEntries(group).length; const elapsed = this.state.turnDurations[group.id];` 组是最后一组且 `state.running` → 不渲染摘要;否则 steps>0 或 elapsed 存在时渲染 `<button class="zc-turn-summary">`,文本:`⏱ ${formatElapsed(elapsed)} · ${steps} 个步骤`(无 elapsed 省略前段,无 steps 省略后段)。点击 toggle `this.expandedTurns: Set<string>`(以 group.id 为键)并重渲;展开时其后插入 `<div class="zc-turn-detail">`,内含该组 process 条目的现有卡片渲染(直接调用现有 `renderEntry(entry)`)。摘要行节点参与 `cachedEntryNode` 缓存,fingerprint 含 elapsed/steps/expanded。
  - 最后一组且 `state.running`:该组 process 条目不渲染;transcript 末尾 append 单个 `.zc-activity` div(不进缓存):`<span class="zc-activity-spinner">` + `<span class="zc-activity-label">{activityLabel(group.entries)}</span>` + `<span class="zc-activity-elapsed">{formatElapsed(Date.now() - turnStartedAt)}</span>`(turnStartedAt 为 null 时省略)。
  - 计时器:`private activityTimer` — render 时若 running 且未启动,`this.doc.defaultView?.setInterval(() => 更新 .zc-activity-elapsed 文本, 1000)`;running 结束或 `destroy()` 时 clearInterval。只改文本节点,不整树重渲。
  - 钉底:`private pinnedToBottom = true`;构造时给 transcript 挂 scroll 监听:`pinned = scrollTop + clientHeight >= scrollHeight - 4`;render 末尾若 `state.running && pinnedToBottom` → `transcript.scrollTop = transcript.scrollHeight`。
  - CSS(styles.css,置于浮窗样式之前的公共区):

```css
.zc-activity { display: flex; align-items: center; gap: 7px; padding: 2px 2px 4px; color: var(--zc-muted); font-size: 11px; }
.zc-activity-spinner { width: 11px; height: 11px; border: 1.5px solid color-mix(in srgb, var(--zc-muted) 35%, transparent); border-top-color: var(--zc-accent); border-radius: 50%; animation: zc-spin .8s linear infinite; }
.zc-activity-label { animation: zc-pulse 1.6s ease-in-out infinite; }
.zc-activity-elapsed { margin-left: auto; font-variant-numeric: tabular-nums; }
.zc-turn-summary { display: inline-flex; align-items: center; gap: 5px; margin: 2px 0 10px; padding: 0; border: 0; background: none; color: var(--zc-muted); font: inherit; font-size: 11px; cursor: pointer; }
.zc-turn-summary:hover { color: var(--zc-text); }
.zc-turn-detail { display: grid; gap: 8px; margin: 0 0 12px; }
```

- [ ] **Step 4:** 目标测试 PASS;全套测试绿;tsc 干净。
- [ ] **Step 5:** `git commit -m "feat(sidebar): CLI-style activity line with expandable turn summary"`

---

### Task 4: 浮窗状态行/摘要行/钉底

**Files:**
- Modify: `zotero-plugin/src/float-panel.ts`
- Test: `zotero-plugin/test/float-panel.test.ts`(追加)

**Interfaces:** 同 Task 3(消费 Task 1/2;复用 Task 3 的 CSS 类,不新增样式)。

- [ ] **Step 1: 失败测试** — `test/float-panel.test.ts` 追加,断言与 Task 3 Step 1 相同的三个行为(该文件已有 createView/callbacks 工厂;浮窗 state 用 `entries` + `running` + `turnStartedAt`/`turnDurations`)。浮窗额外断言:running 时 `.zc-float-entry.zc-entry-tool` 等过程卡片不存在。
- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3: 实现**(float-panel.ts):`renderTranscript()` 按 Task 3 同样的分组规则改写(浮窗 entries 已是 `latestExchange` 切片,通常只有一组,但实现按分组通用写);摘要行/展开明细/活动行/计时器/钉底逻辑与 Task 3 一致(浮窗无 `cachedEntryNode` 缓存,直接重建即可;展开状态仍用 `expandedTurns: Set<string>` 保持跨 setState)。`destroy()` 清计时器。
- [ ] **Step 4:** 测试 PASS;全套绿;tsc 干净。
- [ ] **Step 5:** `git commit -m "feat(float): CLI-style activity line and turn summary in the quick-ask panel"`

---

### Task 5: `copyToClipboard` 与回答复制按钮

**Files:**
- Modify: `zotero-plugin/src/platform.ts`、`zotero-plugin/src/sidebar.ts`、`zotero-plugin/src/float-panel.ts`、`zotero-plugin/src/styles.css`
- Test: `zotero-plugin/test/platform.test.ts`、`test/sidebar.test.ts`、`test/float-panel.test.ts`(追加)

- [ ] **Step 1: 失败测试**:

`test/platform.test.ts` 追加:

```ts
it("copies via nsIClipboardHelper and falls back to navigator.clipboard", () => {
  const copyString = vi.fn();
  (globalThis as any).Components = {
    classes: { "@mozilla.org/widget/clipboardhelper;1": { getService: () => ({ copyString }) } },
    interfaces: { nsIClipboardHelper: {} },
  };
  expect(copyToClipboard("hello")).toBe(true);
  expect(copyString).toHaveBeenCalledWith("hello");
  delete (globalThis as any).Components;
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  expect(copyToClipboard("world")).toBe(true);
  expect(writeText).toHaveBeenCalledWith("world");
  vi.unstubAllGlobals();
});
```

`test/sidebar.test.ts` 追加:assistant 条目渲染后存在 `.zc-copy-answer` 按钮;click 后 `copyToClipboard` 被以 `entry.text` 调用(用 `vi.mock("../src/platform", …)` 或在视图 callbacks 注入——按实现方式二选一,见 Step 3)。`test/float-panel.test.ts` 同样一条。
- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3: 实现**:
  - `platform.ts`:

```ts
export function copyToClipboard(text: string): boolean {
  try {
    const components = (globalThis as Record<string, unknown>).Components as any;
    const helper = components?.classes?.["@mozilla.org/widget/clipboardhelper;1"]
      ?.getService(components.interfaces.nsIClipboardHelper);
    if (helper?.copyString) { helper.copyString(text); return true; }
  } catch { /* fall through */ }
  try {
    const clipboard = (globalThis as any).navigator?.clipboard;
    if (clipboard?.writeText) { void clipboard.writeText(text); return true; }
  } catch { /* ignore */ }
  return false;
}
```

  - 两个视图 `renderEntry` 的 assistant 分支:content 容器 `position: relative`(CSS),append `<button class="zc-copy-answer" title="复制回答">`(内联 SVG 复制图标,参考 SIDEBAR_ICON_PATHS 的画法;侧边栏可新增 `copy: [...]` 图标路径:`["M9 9h10v12H9z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"]`)。click → `copyToClipboard(entry.text)`,成功则按钮加 `.is-copied` 且 title 变"已复制",`setTimeout` 1500ms 还原。视图直接 `import { copyToClipboard } from "./platform"`(测试用 `vi.mock` 打桩)。
  - CSS:

```css
.zc-entry-content { position: relative; }
.zc-copy-answer { position: absolute; top: 0; right: 0; display: none; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px; color: var(--zc-muted); background: var(--zc-bg-subtle); cursor: pointer; }
.zc-entry-content:hover .zc-copy-answer { display: grid; }
.zc-copy-answer.is-copied { color: var(--zc-accent); }
.zc-copy-answer svg { width: 12px; height: 12px; }
```

- [ ] **Step 4:** 测试 PASS;全套绿;tsc 干净。
- [ ] **Step 5:** `git commit -m "feat(plugin): one-click answer copy with privileged clipboard helper"`

---

### Task 6: 公式点击复制 LaTeX

**Files:**
- Modify: `zotero-plugin/src/markdown.ts`(`appendMath`)、`src/sidebar.ts`、`src/float-panel.ts`、`src/styles.css`
- Test: `zotero-plugin/test/markdown.test.ts`、`test/sidebar.test.ts`(追加)

- [ ] **Step 1: 失败测试**:

`test/markdown.test.ts` 追加:

```ts
it("wraps math output with a copyable container carrying the LaTeX source", () => {
  const fragment = renderMarkdown(document, "$$E = mc^2$$\n\n行内 $a+b$ 检查");
  const display = document.createElement("div");
  display.appendChild(fragment);
  const block = display.querySelector(".zc-math-display.zc-math-copy")!;
  expect(block.getAttribute("data-latex")).toBe("E = mc^2");
  expect(block.getAttribute("title")).toBe("点击复制 LaTeX");
  const inline = display.querySelector(".zc-math-inline.zc-math-copy")!;
  expect(inline.getAttribute("data-latex")).toBe("a+b");
});
```

`test/sidebar.test.ts` 追加:渲染含 `$$x$$` 的 assistant 条目后,对 `.zc-math-copy` 派发 click → `copyToClipboard` 被以 `"x"` 调用,且元素短暂持有 `.is-copied`(用 fake timers 断言 1200ms 后移除)。
- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3: 实现**:
  - `markdown.ts` `appendMath`(块级与行内都经过它):在现有 `.zc-math-display`/`.zc-math-inline` 包装元素上追加 `classList.add("zc-math-copy")`、`setAttribute("data-latex", expression)`、`setAttribute("title", "点击复制 LaTeX")`。KaTeX 渲染失败的回退分支(如有纯文本回退)同样加属性。
  - 两个视图:transcript 根节点构造时挂一次 click 委托:

```ts
this.transcript.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement | null)?.closest?.(".zc-math-copy");
  if (!target) return;
  const latex = target.getAttribute("data-latex");
  if (!latex || !copyToClipboard(latex)) return;
  target.classList.add("is-copied");
  this.doc.defaultView?.setTimeout(() => target.classList.remove("is-copied"), 1200);
});
```

  - CSS:

```css
.zc-math-copy { cursor: pointer; border-radius: 6px; transition: background .15s ease; }
.zc-math-copy:hover { background: color-mix(in srgb, var(--zc-accent) 10%, transparent); }
.zc-math-copy.is-copied { background: color-mix(in srgb, var(--zc-accent) 18%, transparent); }
```

- [ ] **Step 4:** 测试 PASS;全套绿;tsc 干净。
- [ ] **Step 5:** `git commit -m "feat(markdown): click-to-copy LaTeX source on rendered formulas"`

---

### Task 7: `markdownToNoteHtml`

**Files:**
- Modify: `zotero-plugin/src/markdown.ts`(新增导出;可复用其内部行级正则,但输出为字符串)
- Test: `zotero-plugin/test/markdown.test.ts`(追加)

**Interfaces (Produces):** `export function markdownToNoteHtml(markdown: string): string` — Zotero 笔记编辑器兼容子集。

- [ ] **Step 1: 失败测试**:

```ts
describe("markdownToNoteHtml", () => {
  it("demotes headings and keeps structure Zotero-safe", () => {
    expect(markdownToNoteHtml("# 标题\n\n正文 **粗** *斜* `code`")).toBe(
      "<h3>标题</h3><p>正文 <strong>粗</strong> <em>斜</em> <code>code</code></p>",
    );
    expect(markdownToNoteHtml("### 小节")).toBe("<h4>小节</h4>");
  });
  it("keeps LaTeX as literal escaped text", () => {
    expect(markdownToNoteHtml("$$E < mc^2$$")).toBe("<p>$$E &lt; mc^2$$</p>");
    expect(markdownToNoteHtml("内联 $a<b$ 完")).toBe("<p>内联 $a&lt;b$ 完</p>");
  });
  it("renders lists, quotes and fenced code", () => {
    expect(markdownToNoteHtml("- 一\n- 二")).toBe("<ul><li>一</li><li>二</li></ul>");
    expect(markdownToNoteHtml("> 引用")).toBe("<blockquote><p>引用</p></blockquote>");
    expect(markdownToNoteHtml("```js\nconst a = 1 < 2;\n```")).toBe(
      "<pre>const a = 1 &lt; 2;</pre>",
    );
  });
  it("emits markdown tables as preformatted text and whitelists links", () => {
    expect(markdownToNoteHtml("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(
      "<pre>| a | b |\n| --- | --- |\n| 1 | 2 |</pre>",
    );
    expect(markdownToNoteHtml("[官网](https://example.com) [坏](javascript:x)")).toBe(
      '<p><a href="https://example.com">官网</a> 坏</p>',
    );
  });
});
```

- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3: 实现**:独立的字符串渲染器(~120 行,与 `renderMarkdown` 共用 `TABLE_DIVIDER` 等正则常量):逐行扫描,块级顺序:代码围栏 → `$$`/`\[` 数学块(原样保 `$$…$$`,内容转义)→ 表格(收集至 `<pre>`)→ 标题(`#/##`→h3,`###/####`→h4)→ 列表 → 引用 → 段落。行内:先转义 HTML(`&`, `<`, `>`, `"`),再依次替换 `` `code` ``、`**bold**`、`*em*`、`[label](http(s)://…)`(非 http/https 的链接只保留 label 文本);行内 `$…$` 保留原样(转义即可,不再处理内部标记)。空输入返回 `""`。
- [ ] **Step 4:** 测试 PASS;全套绿;tsc 干净。
- [ ] **Step 5:** `git commit -m "feat(markdown): note-safe HTML rendering for Zotero note export"`

---

### Task 8: note-sync 模块与自动同步

**Files:**
- Create: `zotero-plugin/src/note-sync.ts`
- Modify: `zotero-plugin/src/plugin.ts`(`onTurnCompleted`)、`src/settings.ts`(如需注册 pref 默认值,按现有 prefString/prefBool 模式)
- Test: `zotero-plugin/test/note-sync.test.ts`(新建)

**Interfaces:**
- Consumes: Task 7 `markdownToNoteHtml`;Task 2 `turnMeta`;`codex.getChatEntries()`、`codex.getThreadOptions()`(取活跃线程 id/title)、`codex.state.activeThreadId`;Task 1 `groupEntries/contentEntries`。
- Produces:

```ts
export interface NoteExchange {
  question: string;
  answerMarkdown: string;
  meta?: { completedAt?: string; model?: string; elapsedMs?: number };
}
export interface NoteThreadSection {
  threadId: string;
  title: string;
  dateLabel: string; // "2026-07-23",新建分节时的日期;合并时优先沿用已有分节的日期
  exchanges: NoteExchange[];
}
export interface ExchangeMeta { elapsedMs?: number; completedAt?: string; model?: string }
export function buildExchangesFromEntries(
  entries: ChatEntry[],
  meta: ReadonlyMap<string, ExchangeMeta> | undefined, // plugin.ts 的 TurnMeta 结构兼容,直接传入
): NoteExchange[];
export function mergeChatNoteHtml(
  existingHtml: string | null,
  paperTitle: string,
  sections: NoteThreadSection[],
): string;
export async function syncChatNote(deps: {
  zotero: any;                 // 全局 Zotero(测试打桩)
  readerItem: any;             // 当前附件 item
  paperTitle: string;
  section: NoteThreadSection;
}): Promise<void>;
```

- [ ] **Step 1: 失败测试** — `test/note-sync.test.ts`(核心用例;stub 风格参考 `zotero-mutations.test.ts`):

```ts
describe("buildExchangesFromEntries", () => {
  it("keeps only completed Q&A pairs and attaches meta", () => {
    const meta = new Map([["u1", { elapsedMs: 28_000, completedAt: "2026-07-23T10:00:28Z", model: "gpt-5-codex" }]]);
    const out = buildExchangesFromEntries([
      { id: "u1", kind: "user", text: "问一" },
      { id: "r1", kind: "reasoning", text: "…", state: "complete" },
      { id: "a1", kind: "assistant", text: "答一", state: "complete" },
      { id: "u2", kind: "user", text: "悬空问题" },
    ] as any, meta);
    expect(out).toEqual([
      { question: "问一", answerMarkdown: "答一",
        meta: { elapsedMs: 28_000, completedAt: "2026-07-23T10:00:28Z", model: "gpt-5-codex" } },
    ]);
  });
});

describe("mergeChatNoteHtml", () => {
  const section = {
    threadId: "th1", title: "主线程", dateLabel: "2026-07-23",
    exchanges: [{ question: "问", answerMarkdown: "**答**" }],
  };
  it("creates a fresh note body", () => {
    const html = mergeChatNoteHtml(null, "论文A", [section]);
    expect(html).toContain("<h1>AI 研究笔记 — 论文A</h1>");
    expect(html).toContain('<h2 data-zotkit-thread="th1">主线程 · 2026-07-23</h2>');
    expect(html).toContain("<p><strong>Q:</strong> 问</p>");
    expect(html).toContain("<p><strong>答</strong></p>");
  });
  it("replaces the matching section, keeps unknown sections and appends new ones", () => {
    const existing = mergeChatNoteHtml(null, "论文A", [
      { threadId: "old", title: "旧线程", dateLabel: "2026-07-01",
        exchanges: [{ question: "旧问", answerMarkdown: "旧答" }] },
      { threadId: "th1", title: "主线程", dateLabel: "2026-07-20",
        exchanges: [{ question: "老", answerMarkdown: "老" }] },
    ]);
    const html = mergeChatNoteHtml(existing, "论文A", [
      section,
      { threadId: "th2", title: "新线程", dateLabel: "2026-07-23",
        exchanges: [{ question: "新", answerMarkdown: "新" }] },
    ]);
    expect(html).toContain("旧问");                        // 未知分节保留
    expect(html).not.toContain("<p><strong>Q:</strong> 老</p>"); // 匹配分节被重建
    expect(html).toContain("主线程 · 2026-07-20");          // 沿用既有分节日期
    expect(html.indexOf("旧线程")).toBeLessThan(html.indexOf("主线程"));
    expect(html.indexOf("主线程")).toBeLessThan(html.indexOf("新线程"));
  });
  it("falls back to heading-text matching when the data attribute is stripped", () => {
    const stripped = mergeChatNoteHtml(null, "论文A", [
      { ...section, exchanges: [{ question: "老", answerMarkdown: "老" }] },
    ]).replace(' data-zotkit-thread="th1"', "");
    const html = mergeChatNoteHtml(stripped, "论文A", [section]);
    expect((html.match(/主线程/g) ?? []).length).toBe(1);
  });
});

describe("syncChatNote", () => {
  it("updates the tagged child note or creates one", async () => { /* stub: parentItem.getNotes → [id];
       Zotero.Items.get(id) → { getTags: () => [{ tag: "zotkit-chat" }], getNote, setNote, saveTx };
       断言 setNote 收到合并结果、saveTx 调用;无匹配 note 时走 new Zotero.Item("note") 分支:
       libraryID/parentKey 赋值、addTag("zotkit-chat")、saveTx。 */ });
  it("swallows write failures", async () => { /* saveTx 抛错 → 不向外抛 */ });
});
```

- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3: 实现** `note-sync.ts`:
  - `buildExchangesFromEntries`:`groupEntries` 后,每组取 user.text 为 question,`contentEntries` 中 assistant 条目 text 以 `"\n\n"` 连接为 answer;无 assistant 的组丢弃;meta 从 map 取(可 undefined)。
  - 分节 HTML:`<h2 data-zotkit-thread="ID">标题 · dateLabel</h2>` + 每轮 `<p><strong>Q:</strong> {escape(question)}</p>` + `markdownToNoteHtml(answerMarkdown)` + meta 行 `<p><em>{completedAt 本地化 "YYYY-MM-DD HH:mm"} · {model} · {formatElapsed(elapsedMs)}</em></p>`(meta 为空省略;个别字段缺失则省略该字段)+ 轮间 `<hr>`(末轮不加)。
  - `mergeChatNoteHtml`:用 `/<h2\b[^>]*>[\s\S]*?(?=<h2\b|$)/g` 把 existing 切成分节数组;分节的 threadId 取 `data-zotkit-thread="([^"]+)"`,无属性时以 `<h2>` 文本(去标签)与 `${title} · ` 前缀匹配;date 取既有 h2 文本的 ` · (.+)$` 捕获。输出 = `<h1>AI 研究笔记 — {escape(paperTitle)}</h1>` + 保留原顺序的既有分节(命中的以新内容重建、沿用旧 dateLabel)+ 新分节按入参顺序追加。existing 为 null/空 → 全新构建。
  - `syncChatNote`:`const top = readerItem.parentItem ?? readerItem`(再取 `top.topLevelItem ?? top`,按 Zotero API 实际字段防御式处理);`top.getNotes()` → `zotero.Items.get(id)`,`getTags()` 含 `zotkit-chat` 的第一条为目标;`getNote()` 作为 existing 传 merge;`setNote(merged)` + `await note.saveTx()`。新建分支:`new zotero.Item("note")`,`libraryID = top.libraryID`、`parentKey = top.key`、`setNote(merged)`、`addTag("zotkit-chat")`、`saveTx()`。整体 try/catch,失败 `zotero.debug?.(…)` 后静默返回。
  - `plugin.ts` `onTurnCompleted(threadId)`:

```ts
protected onTurnCompleted(threadId: string): void {
  if (!prefBool("noteSync", true)) return; // 按 settings.ts 现有 pref 读取模式
  const context = this.context;
  if (!context || threadId !== this.codex?.state.activeThreadId) return;
  const thread = this.codex.getThreadOptions().find((option) => option.active);
  const section: NoteThreadSection = {
    threadId,
    title: thread?.title || "对话",
    dateLabel: new Date().toISOString().slice(0, 10),
    exchanges: buildExchangesFromEntries(this.codex.getChatEntries(), this.turnMeta.get(threadId)),
  };
  if (!section.exchanges.length) return;
  void syncChatNote({
    zotero: Zotero, readerItem: this.readerContextItem(), // 用插件现有的当前附件获取途径
    paperTitle: paperTitle(context), section,
  }).catch(() => {});
}
```

  (`readerContextItem()`:按 plugin.ts 现有获取当前 reader attachment item 的途径实现;若仅有 metadata 无 item 句柄,则经 `Zotero.Items.get(context.attachment.itemID ?? …)`/`getByLibraryAndKey(libraryID, key)` 解析,以 context.attachment 现有字段为准。)
  - `plugin-state.test.ts` 追加一条:running 翻转为 false 且 pref 开启时,`syncChatNote`(mock)被调用一次;pref 关闭时不调用。
- [ ] **Step 4:** 测试 PASS;全套绿;tsc 干净。
- [ ] **Step 5:** `git commit -m "feat(plugin): auto-sync chat Q&A into a per-item Zotero note"`

---

### Task 9: 全文截断修复 + 搜索保序回归测试

**Files:**
- Modify: `zotero-plugin/src/reader-context.ts`
- Test: `zotero-plugin/test/reader-context.test.ts`(追加)

**Interfaces (Produces):** Zotero 适配器新增可选 `getFullTextPageCounts?(attachment): Promise<{ indexedPages?: number; totalPages?: number } | null>`。

- [ ] **Step 1: 失败测试** — `test/reader-context.test.ts` 追加(沿用该文件的 service/zotero stub 工厂):

```ts
it("falls back to the uncapped pdf worker when the index is truncated", async () => {
  // stub: readIndexedFullText → 100 页缓存文本(\f 分隔);getFullTextPageCounts → { indexedPages: 100, totalPages: 250 };
  // readPdfWorkerText(attachment, null) → 250 页全文
  // 调用 zotero_search_current_pdf(或直接触发 ensureFullText 的既有测试入口)
  // 断言:结果 source === "pdf-worker",且能命中第 200 页的内容
});

it("keeps using the index when the page counts confirm completeness", async () => {
  // getFullTextPageCounts → { indexedPages: 40, totalPages: 40 } → source === "indexed-fulltext",worker 不被调用
});

it("uses db totals when reader page stats are unavailable (library pdf path)", async () => {
  // pageStats 无 pageCount;getFullTextPageCounts → { indexedPages: 100, totalPages: 300 } → 走 worker
});

it("treats a cache as complete when no authoritative counts exist", async () => {
  // getFullTextPageCounts → null 且 pageStats 无 pageCount → 维持 indexed-fulltext,不调 worker
});

it("returns search matches in ascending page order", async () => {
  // 5 页文本,3 页含关键词 → matches 的 pageNumber 单调不减(锁定 searchPageText 现状)
});
```

- [ ] **Step 2:** 运行 → FAIL(前三条;后两条可能直接绿,保留作回归锁)。
- [ ] **Step 3: 实现**:
  - 适配器(reader-context.ts:3057 区域,与 `readIndexedFullText` 同级)新增:

```ts
async getFullTextPageCounts(attachment) {
  const fulltext = zotero.Fulltext ?? zotero.FullText;
  const getPages = method(fulltext, "getPages");
  if (!getPages) return null;
  const { id } = itemIdentity(attachment);
  const record = asRecord(await getPages(id));
  const indexedPages = toFiniteNumber(record.indexedPages);
  const totalPages = toFiniteNumber(record.totalPages);
  if (indexedPages === undefined && totalPages === undefined) return null;
  return { indexedPages, totalPages };
}
```

  (`toFiniteNumber` 若无现成等价 helper 则新增;沿用该文件 `method/asRecord/itemIdentity` 既有工具。接口类型加到 zotero 适配器接口定义与 2723 行附近的 Zotero 全局类型上。)
  - `readIndexedFullText`(3088 行):`return { text, extractedPages: pages.length, totalPages: undefined }` — 不再用缓存页数冒充总页数(接口字段可选,直接省略)。
  - `loadFullText`(1921 行起)改判定:

```ts
const dbCounts = await this.zotero.getFullTextPageCounts?.(attachment).catch(() => null) ?? null;
const indexedPageCount = indexedText
  ? (dbCounts?.indexedPages ?? indexedFullText?.extractedPages ?? splitPdfPages(indexedText).length)
  : 0;
const knownPageCount = pageStats.pageCount ?? dbCounts?.totalPages ?? indexedFullText?.totalPages;
```

  其余逻辑(`indexedLooksComplete`、worker 回退、警告)保持不变。
  - `getIndexedFullTextReference`(3057 行):同样取 `dbCounts`,当 `indexedPages < totalPages` 时返回 `truncated: true`;`ensureCurrentPdfTextReference`(984 行)在 `existing?.truncated` 或新取的 reference `truncated` 时不再原地引用索引,落入 `ensureFullText` 镜像分支,让终端也拿到全量文本。
- [ ] **Step 4:** 测试 PASS;全套绿;tsc 干净。
- [ ] **Step 5:** `git commit -m "fix(reader-context): detect truncated full-text index and fall back to uncapped extraction"`

---

### Task 10: `zotero_get_pdf_outline` 工具 + CHANGELOG

**Files:**
- Modify: `zotero-plugin/src/reader-context.ts`(适配器 + 工具注册)、`zotero-plugin/CHANGELOG.md`
- Test: `zotero-plugin/test/reader-context.test.ts`(追加)

- [ ] **Step 1: 失败测试**:

```ts
describe("zotero_get_pdf_outline", () => {
  it("flattens nested bookmarks with 1-based pages and depth", async () => {
    // stub pdfDocument: getOutline → [{ title: "第一章", dest: [ref1], items: [{ title: "1.1", dest: "named", items: [] }] }]
    // getDestination("named") → [ref2];getPageIndex(ref1) → 0、(ref2) → 4
    // 断言 items = [{ title: "第一章", page: 1, depth: 0 }, { title: "1.1", page: 5, depth: 1 }]
    // 且返回含 totalPages
  });
  it("keeps going when a destination fails to resolve", async () => { /* 该条 page: null,其余正常 */ });
  it("truncates beyond 300 entries with a warning", async () => { /* 301 条 → items.length===300 且 warnings 提示 */ });
  it("suggests search when the pdf has no outline", async () => { /* getOutline → null → items: [],warnings 提示改用检索 */ });
});
```

- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3: 实现**:
  - 适配器新增(`extractPdfJsPage` 同级,3044 行区域):

```ts
async extractPdfOutline(reader) {
  const win = readerPdfWindow(reader);
  const application = asRecord(win.PDFViewerApplication);
  const document = asRecord(application.pdfDocument ?? property(application.pdfViewer, "pdfDocument"));
  const getOutline = method(document, "getOutline");
  if (!getOutline) return null;
  const outline = await getOutline();
  if (!Array.isArray(outline)) return null;
  const items: Array<{ title: string; page: number | null; depth: number }> = [];
  const resolvePage = async (dest: unknown): Promise<number | null> => {
    try {
      const explicit = typeof dest === "string" ? await method(document, "getDestination")?.(dest) : dest;
      const ref = Array.isArray(explicit) ? explicit[0] : null;
      if (ref === null || ref === undefined) return null;
      const pageIndex = await method(document, "getPageIndex")?.(ref);
      return typeof pageIndex === "number" && Number.isInteger(pageIndex) ? pageIndex + 1 : null;
    } catch { return null; }
  };
  const walk = async (nodes: unknown, depth: number): Promise<void> => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (items.length >= 300) return;
      const record = asRecord(node);
      items.push({
        title: cleanText(String(record.title ?? "")) || "(无标题)",
        page: await resolvePage(record.dest),
        depth,
      });
      await walk(record.items, depth + 1);
    }
  };
  await walk(outline, 0);
  return items;
}
```

  - 工具注册(与 `zotero_get_current_page` 定义相邻,~378 行区域):name `zotero_get_pdf_outline`,description:`"Return the current PDF's table of contents (outline/bookmarks) with 1-based page numbers and nesting depth. On long PDFs call this first to plan which sections to read, then use zotero_read_pdf_pages for the chosen ranges. Only works for the PDF open in the active Reader. Read-only."`,inputSchema 空对象。handler:`ensureSnapshot()` → `extractPdfOutline(snapshot.hook.reader)`;返回 `{ items, totalPages: snapshot.context.page.pageCount ?? null, warnings }`;`items === null || items.length === 0` → `items: []` + warning `"This PDF has no embedded outline; use zotero_search_current_pdf to locate sections instead."`;原始条目数≥300 → warning `"Outline truncated to the first 300 entries."`(在 walk 里用计数判断是否触界)。适配器接口类型同步补充。
  - `CHANGELOG.md` Unreleased 追加本轮全部条目:CLI 式状态行与耗时摘要(浮窗+侧边栏)、回答一键复制、公式点击复制 LaTeX、问答自动同步到 Zotero note(`zotkit-chat` 标签)、全文 100 页截断修复、`zotero_get_pdf_outline` 工具。
- [ ] **Step 4:** 目标测试 PASS;`npx vitest run` 全套绿;`npx tsc --noEmit` 干净。
- [ ] **Step 5:** `git commit -m "feat(reader-context): PDF outline tool for structure-aware long-pdf reading"`
