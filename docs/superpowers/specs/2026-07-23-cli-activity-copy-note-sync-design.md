# CLI 式活动状态行、复制体验与 Zotero Note 同步 — 设计文档

日期:2026-07-23
分支:`feature/zotero-reader-codex-integration`
涉及范围:`zotero-plugin/`(浮窗 + 侧边栏聊天、markdown 渲染、插件控制器、新增 note 同步模块)

## 背景与问题

当前浮窗和侧边栏把一轮对话中的每个过程事件(reasoning、工具调用、命令执行)都渲染成独立的折叠卡片。长回合会产生十几张卡片,把正在流式输出的回答推出可视区(浮窗 transcript 上限 55vh),用户观感是"AI 输出跑到窗口外面"、"重要信息被刷屏"。

同时:回答内容缺少一键复制;KaTeX 公式已能渲染但无法拿回 LaTeX 源码;对话内容离开 Zotero 即丢失,没有沉淀为条目笔记。

## 用户决策(已确认)

1. 运行中:过程事件收敛为一行原位更新的小字转圈状态行;结束后只留回答 + 一行可点击展开过程明细的耗时小字。
2. 浮窗与侧边栏统一采用此交互。
3. Zotero note 只保存问答(Q + 最终回答 + 元信息),不含思考过程与工具明细。
4. 一条 note 挂在论文条目下,按线程分节组织。

## 设计

### 1. 活动状态行(浮窗 + 侧边栏)

**视图层分组。**两个视图都把 `entries: ChatEntry[]` 按轮次(exchange)分组:每个 `kind: "user"` 开启一轮;轮内 `reasoning` / `tool` / `command` 为过程条目,`assistant` / `error` 为内容条目。`kind: "status"` 条目、plan 卡片、审批卡片、diff review、checkpoint 卡片一律保持现状,不参与分组改造。

**运行中(`state.running` 为真且该轮是最后一轮):**

- 该轮的过程条目不渲染卡片;transcript 末尾渲染一行活动状态行:
  `◌ 正在调用 检索本篇 PDF · 12s`
- 转圈图标持续旋转(复用 `zc-spin`),文字带 shimmer 微光动画;文字取自最新的 running 条目并**原位更新**:
  - `reasoning` → `思考中…`
  - `tool` → `正在调用 <友好名>`
  - `command` → `执行命令…`
  - `assistant`(流式中)→ `正在撰写回答…`
  - 无 running 条目时回退 `思考中…`
- 已知工具的友好中文名映射(未知工具显示原始名):
  | 工具 | 显示名 |
  |---|---|
  | zotero_get_reader_context | 读取阅读器上下文 |
  | zotero_get_current_page | 读取当前页 |
  | zotero_get_current_selection | 读取选中文本 |
  | zotero_search_current_pdf | 检索本篇 PDF |
  | zotero_read_pdf_pages | 读取论文页面 |
  | zotero_search_library | 检索文库 |
  | zotero_read_library_pdf_pages | 读取文库论文页面 |
  | zotero_search_library_pdf | 检索文库 PDF |
  | zotero_list_annotations | 查看批注 |
- 秒数每秒自增:视图在 `running` 时启动 1s interval,只更新状态行文字节点,不触发整个 transcript 重渲;`destroy()` 与 `running` 结束时清除。
- **钉底自动滚动**:running 期间每次渲染后滚动到底;用户向上滚动即解除钉底,滚回底部自动恢复。这是"输出跑到窗口外"的直接修复。

**结束后:**

- 每个已完成轮次在回答之后渲染一行小字摘要(与状态行同字号):
  - 有耗时与步骤:`⏱ 28s · 4 个步骤`
  - 仅步骤(历史轮次,无耗时数据):`4 个步骤`
  - 仅耗时(无过程条目):`⏱ 28s`
  - 两者皆无:不渲染此行
- 耗时格式:小于 60s 显示 `28s`;否则 `1m 42s`。
- 点击该行展开/收起当轮过程明细,明细复用现有 `zc-tool-card` 折叠卡片渲染。展开状态由视图按轮次 id(该轮 user 条目 id)记忆,重渲不丢,线程切换后各线程独立。

**插件端计时。**`ZoteroChatPlugin` 维护:

- `turnStartedAt: Map<threadId, number>`:该线程 `running` 从 false→true 时记录(用 `Date.now()`)。
- `turnDurations: Map<threadId, Record<userEntryId, number>>`:running 结束时,以该轮 user 条目 id 为键写入耗时(毫秒),并清除 `turnStartedAt`。
- 视图 state 新增:`turnStartedAt: number | null`(活跃线程当前轮)与 `turnDurations: Record<string, number>`(活跃线程)。仅本会话完成的轮次有耗时;重启后加载的历史轮次无。

### 2. 复制体验

**整段回答复制。**两个视图的 assistant 条目 hover 时右上角浮现幽灵复制按钮;点击复制该条目的 **markdown 源码**(`entry.text`,公式即为 `$$…$$` 原文);按钮文字/图标切换为"已复制"约 1.5s 后还原。正文文字保持可选中(不新增任何 `user-select: none`)。

**公式点击复制。**`renderMarkdown` 的数学输出外包一层容器:

- 块级:`<div class="zc-math-display zc-math-copy" data-latex="…">`
- 行内:`<span class="zc-math-inline zc-math-copy" data-latex="…">`
- `data-latex` 存 LaTeX 原文(不含定界符);容器带 `title="点击复制 LaTeX"`。
- 两个视图在 transcript 根节点做事件委托:点击命中 `.zc-math-copy` 即复制 `data-latex`,并给该容器加临时 `.is-copied` 样式(短暂高亮 + "已复制" 角标,~1.2s 后移除)。hover 时背景轻微高亮提示可点。

**剪贴板工具。**`platform.ts` 新增 `copyToClipboard(text: string): boolean`:优先 `@mozilla.org/widget/clipboardhelper;1`(`nsIClipboardHelper.copyString`,失焦窗口也可靠),异常时回退 `navigator.clipboard.writeText`。复制按钮与公式复制共用。

### 3. Zotero note 自动同步

**新模块 `src/note-sync.ts`**,职责单一:把线程问答渲染为 Zotero note HTML 并写回条目。

**触发。**每轮 running 结束(与耗时记录同处)后异步执行,`try/catch` 包裹并 `Zotero.debug` 记录失败,绝不影响聊天流程。流式过程中不写。偏好 `noteSync`(布尔,默认 `true`)可关闭;本轮不做设置 UI。

**目标条目。**Reader 当前 item 的顶层条目(`item.parentItem ?? item`,取 top-level)。在其子笔记中查找带 Zotero 标签 `zotkit-chat` 的 note;找到则更新第一条,否则新建子 note 并打上该标签。库不可写(如只读群组库)时捕获错误并跳过。

**Note 结构。**

```html
<h1>AI 研究笔记 — <论文标题></h1>
<h2 data-zotkit-thread="<threadId>"><线程名> · <创建日期></h2>
  <p><strong>Q:</strong> <问题文本></p>
  <回答 HTML>
  <p><em>2026-07-23 14:32 · gpt-5-codex · 28s</em></p>
  <hr>
  …(下一轮)
<h2 data-zotkit-thread="…">…</h2>
```

- 元信息行仅包含本会话已知字段(时间/模型/耗时);历史轮次全部未知时整行省略。
- **分节合并**而非整篇覆写:解析既有 note HTML,按 `<h2>` 边界切分;分节以 `data-zotkit-thread` 匹配,属性丢失时按 H2 标题文本回退匹配。输出 = 重新生成的 H1 + 原有顺序的各分节(本次有数据的线程整节重建,其余原样保留)+ 末尾追加新线程分节。H1 之前/分节结构之外的用户自写内容不做保留承诺(spec 边界:用户笔记请写在别的 note)。
- 核心为纯函数 `mergeChatNoteHtml(existingHtml, paperTitle, sections)`,便于测试;Zotero 读写(`item.getNotes()`、`new Zotero.Item("note")`、`setNote`、`saveTx`)隔离在薄壳 `syncChatNote()` 中。

**markdown → note HTML。**`markdown.ts` 新增 `markdownToNoteHtml(markdown: string): string`,输出 Zotero 笔记编辑器兼容子集:

- 标题降级:`#`/`##` → `<h3>`,`###`/`####` → `<h4>`(H1/H2 保留给 note 自身结构)。
- 段落、`<ul>`/`<ol>`、`<blockquote>`、代码围栏 → `<pre>`、行内代码 → `<code>`、粗体/斜体、链接(仅 http/https,其余按纯文本)。
- **公式不渲染**:块级输出 `<p>$$…$$</p>`、行内保留 `$…$` 文本(LaTeX 源码原样、HTML 转义)。
- **表格不用 `<table>`**(Zotero 笔记编辑器 schema 不支持):整个表格块以 markdown 原文放入 `<pre>`。
- 所有文本 HTML 转义。

### 4. 不改的部分

会话/线程模型、codex app-server 协议、审批/diff/plan/checkpoint 卡片、上下文芯片、模型与推理力度选择器、终端面板。不新增 npm 依赖(KaTeX 已在)。

## 测试计划(Vitest + happy-dom)

- **分组与状态行**:running 时过程条目不渲染卡片、状态行文字随最新 running 条目切换、1s 计时(fake timers)、running 结束后状态行消失。
- **摘要行**:四种组合(耗时×步骤)的渲染;点击展开/收起;展开状态跨 `setState` 保留。
- **钉底滚动**:running 渲染后 `scrollTop` 到底;模拟用户上滚后不再强制钉底。
- **复制**:回答复制按钮调用 `copyToClipboard` 且参数为 markdown 源码;`.zc-math-copy` 点击复制 `data-latex`;clipboardhelper 打桩。
- **markdownToNoteHtml**:标题降级、公式保留源码、表格进 `<pre>`、HTML 转义、链接白名单。
- **mergeChatNoteHtml**:新建、单分节重建、多分节保序、未知分节保留、`data-zotkit-thread` 丢失时按标题回退。
- **syncChatNote**:打桩 Zotero item API 验证找 note/建 note/打标签/`saveTx`;库不可写时静默跳过;`noteSync=false` 时不执行。
- 既有 195 项测试保持全绿;`tsc --noEmit` 零错误。

## 约束

- 本机 `npm ci --offline`(registry 被墙,缓存已备);不跑 `npm run build`/`verify`(需 macOS)。
- TypeScript strict;视图遵循现有 `constructor(host, callbacks)` + `setState` + `destroy()` 模式。
- 版本号保持 0.3.0,发布时再统一升级。
