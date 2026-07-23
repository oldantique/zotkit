# 设计:⌘K 浮动提问窗 + Apple 风格 UI 改造

日期:2026-07-23
分支:`feature/float-chat-apple-ui`(基于 `8bb35ab`,即 PR #1 当前 head)
范围:仅 `zotero-plugin/`(TypeScript 前端与样式;不涉及 macOS 原生 helper 与 Python CLI)

## 目标

1. 新增一个悬浮于 PDF 阅读器之上的半透明快速提问窗(下称「浮窗」),由 ⌘K 呼出/关闭;呼出时自动携带用户在 PDF 中选中的文本作为上下文。
2. 将插件全部界面(侧边栏、终端面板、浮窗、Reader 划词按钮)改造为 Apple 风格视觉设计。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 浮窗与侧边栏会话关系 | **共享同一会话**——同一对话的两个视图,消息双向实时同步 |
| 快捷键 | **⌘K** 呼出/关闭(toggle);Esc 也可关闭 |
| 布局形态 | **Spotlight 式**:水平居中、偏上三分之一、约 600px 宽的毛玻璃卡片;可拖动并记住位置 |
| 主题色 | **Apple 系统蓝**(浅色 `#007AFF` / 深色 `#0A84FF`),替换现有紫色 `#6c5ce7` |

## 一、交互行为

- **⌘K**(在主窗口或 Reader 窗口按下)呼出浮窗;再按 ⌘K 或 Esc 关闭。呼出时输入框自动聚焦;关闭后焦点交还 PDF。
- **选区芯片**:呼出时若 PDF 存在选中文本,浮窗顶部显示芯片(`已选 N 字 · p.X`),该选区作为下一条消息的上下文自动附带(复用 `buildSelectionPrompt`,沿用 32k 字符上限)。芯片带 ✕ 可移除。无选区时不显示芯片,仅携带当前论文上下文。
- **共享会话**:浮窗发送 → 现有 `plugin.sendChat` → `CodexService.send`;回答流式渲染同时出现在浮窗与侧边栏(同一 `getChatEntries()` 数据源)。
- **浮窗只展示当前线程最近一轮问答**(用户消息 + 助手回答);完整历史在侧边栏查看。回答区最大高度约可视区 55%,超出内部滚动。
- **点击 PDF 不关闭浮窗**(支持边看回答边翻页);仅 ⌘K / Esc / 关闭按钮收起。
- **拖动**:标题栏区域可拖动;位置按主窗口记忆(会话内存,不持久化到磁盘);位置钳制在可视区内,窗口 resize 时修正。
- 生成中允许关闭浮窗:回答继续在侧边栏进行,不中断 turn。

## 二、架构

### 新组件:`src/float-panel.ts` — `FloatPanelView`

- 与现有视图同构:`constructor(host: HTMLElement, callbacks: FloatPanelCallbacks)`、`setState(partial)`、`destroy()`;纯 HTML DOM(`host.ownerDocument.createElement`),零 `Zotero`/全局依赖 → happy-dom 可直接测试。
- 回调面(初版):`onSend(text)`、`onStop()`、`onClose()`、`onRemoveSelection()`。
- 状态面(`FloatPanelState`,`SidebarState` 的子集 + 自有字段):`visible`、`entries`(插件层已裁剪为最近一轮)、`running`、`selection`(芯片数据)、`signedIn`、`paperTitle`。
- DOM:`<section class="zc-float">` → 拖动条(含论文名与关闭按钮)、选区芯片、composer(textarea + 发送/停止按钮)、回答区(复用现有 markdown 渲染管线)。

### 挂载与生命周期(plugin 层)

- **挂载到 Zotero 主窗口文档**(非 Reader iframe),`position: fixed` 覆于阅读器区域;完全绕开 Reader iframe `resource://` 源不能加载 `chrome://` 样式的限制,样式沿用 `injectWindowAssets` 已注入的样式表。
- 每个主窗口一个实例:`floatPanels: Map<Window, FloatPanelView>`,在 `onMainWindowUnload` / 宿主 `!isConnected` 时销毁,镜像现有 `chatViews` 清理模式。
- 注册进 `chatViews` 渲染管线:`renderChatViews()` 推送状态时同步更新浮窗(浮窗条目由插件层裁剪为最近一轮)。**`CodexService` 零改动。**

### 快捷键与选区

- ⌘K 绑定加入现有 `installShortcutHandler`(已同时安装于主窗口与各 Reader 窗口,capture 阶段,带 `isEditableEventTarget` 守卫)。浮窗输入框内按 ⌘K 例外放行(允许在浮窗内关闭)。
- Reader 窗口内触发时通过已有的窗口归属关系找到外层主窗口再 toggle。
- 选区获取:呼出瞬间调用 `ReaderContextService.getCurrentSelection()`(划词时已被 `renderTextSelectionPopup` 钩子预捕获,通常为缓存命中)。

## 三、Apple 风格视觉改造(`src/styles.css`)

功能与 DOM 结构不动,仅样式层。

### 设计 token 翻新

- 主题色:`--zc-accent` 浅色 `#007AFF`、深色 `#0A84FF`;派生 `--zc-accent-strong`(pressed,约 −8% 亮度)、`--zc-accent-soft`(选中底,`color-mix` 12–16%)、hover 态。
- 字体:`-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif`;正文 13px/1.45,辅助 11px,标题 13px semibold——对齐 macOS 控件字号。
- 灰阶:浅色 `#ffffff / #f5f5f7 / #ececee`,深色 `#1e1e1e / #2c2c2e / #3a3a3c`;边框极淡(`rgba` 低透明度),层次靠底色深浅与阴影。
- 圆角:卡片/浮窗 12–14px,按钮/输入 8–10px,芯片全圆;阴影为低透明度双层软阴影(接近 macOS 浮层)。

### 材质

- 浮窗:`backdrop-filter: blur(24px) saturate(1.4)` + 半透明底(浅色约 78% 白,深色约 70% `#2c2c2e`),1px 内描边高光——仿 macOS vibrancy;浅/深两套完整适配(沿用现有 `prefers-color-scheme` 机制)。
- 侧边栏顶栏改半透明模糊吸顶;登录遮罩沿用现有 blur 并统一参数。

### 组件重绘清单

侧边栏(顶栏、线程标签、上下文卡、消息气泡、composer、`<select>` 改胶囊分段控件样式)、终端面板配色、Reader 划词弹出按钮、新浮窗。用户气泡改为 accent 实底白字(iMessage 蓝气泡语义);助手内容保持无框排版。

## 四、边界与错误处理

- 无 Reader 标签页(如图书馆视图)按 ⌘K:浮窗照常呼出、居中于窗口、无选区芯片,行为与 ⌘I 语义一致。
- 未登录:浮窗内显示与侧边栏一致的登录引导(复用现有 login 状态与文案)。
- 多主窗口:实例、可见性、位置各自独立。
- 选区超长:沿用 32k 截断;芯片显示原始字数。
- ⌘K 与 Zotero 默认键位无冲突(现有 ⌘I/⌘L/⌘⇧L/⌘⇧J 不变)。

## 五、测试

- 新增 `test/float-panel.test.ts`,按 `sidebar.test.ts` 模式(happy-dom + `vi.fn()` 回调):挂载/显隐、选区芯片渲染与移除回调、发送/停止回调、最近一轮条目渲染、destroy 幂等。
- plugin 层补用例:⌘K toggle 分发、呼出时选区注入、窗口卸载清理。
- 样式改造不改 DOM 结构与既有类名 → 现有 13 文件 / 172 测试保持通过为回归门槛。
- 发布前仍需真实 Mac smoke test(毛玻璃渲染、拖动手感、快捷键在 Reader 内生效)——Linux/CI 无法覆盖,沿用仓库既有四层验证流程。

## 不做的事(YAGNI)

- 不做浮窗内的线程切换、模式/模型选择(去侧边栏操作)。
- 不做位置/尺寸的磁盘持久化与多显示器记忆。
- 不做选区锚定气泡与底部悬浮条形态。
- 不改 `CodexService`、app-server 协议、原生 helper。
