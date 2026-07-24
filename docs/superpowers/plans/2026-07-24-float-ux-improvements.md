# 浮窗 UX 改进(可选中文字 / 可调大小 / 透明度)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. 单任务计划。

**Goal:** 修复浮窗文字不可选中(XUL 宿主默认),新增用户可调窗口大小与背景透明度,均持久化。

**背景:** 浮窗 host 挂在 Zotero 主窗口(XUL 文档)`documentElement` 上(plugin.ts:723),XUL 环境下文本默认不可选;用户报告浮窗内文字与公式无法用鼠标选中复制。用户另要求:浮窗可调大小、可调面板透明度。

## Global Constraints

- `npm ci --offline`;不跑 build/verify(需 macOS)。`npx vitest run` 基线 304 全绿;`npx tsc --noEmit` 干净。
- 提交信息末尾:`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 视图模式沿用 `setState`/`destroy`;prefs 用 `prefString`/`setPrefString`(platform.ts 现有)。

### Task 1: 浮窗可选中 + resize + 透明度

**Files:** Modify `src/float-panel.ts`、`src/styles.css`、`src/plugin.ts`(prefs 读写与恢复)、`zotero-plugin/CHANGELOG.md`;Test `test/float-panel.test.ts`、`test/build-assets.test.ts`(CSS 断言风格已有先例)

**要求:**

1. **可选中**(bug 修复,XUL 宿主需显式声明):styles.css 增
   ```css
   .zc-float-transcript, .zc-float-transcript * { user-select: text; -moz-user-select: text; cursor: auto; }
   .zc-float-bar { user-select: none; -moz-user-select: none; }
   ```
   (bar 现有 user-select:none 保留/补 -moz 前缀。)`.zc-math-copy` 的点击复制与文本选中并存:点击复制仅在 `window.getSelection()?.isCollapsed !== false` 时不触发(选中拖拽经过公式时不误复制——两个视图的委托 handler 都加该 guard)。
2. **可调大小**:`.zc-float` 增 `resize: both; overflow: hidden; min-width: 380px; max-width: 760px; min-height: 220px; max-height: 85vh;`。内部布局改为纵向 flex:bar 固定、note 固定、transcript `flex: 1 1 auto; min-height: 0; max-height: none;`(替换现 55vh 上限)、composer 固定。未手动调整时保持现有默认尺寸(width 由现有规则给出;height 初始 auto——`resize` 拖动后浏览器写入内联 width/height)。持久化:view 构造时挂 `ResizeObserver`(host window 的),500ms 防抖回调 `callbacks.onPanelResize(width, height)`;plugin 存 `setPrefString("floatSize", `${w}x${h}`)`,mount 时若 pref 存在则以内联样式恢复(解析失败忽略)。仅当用户拖动导致尺寸区别于初始值时写 pref(首次 observe 的初始回调跳过)。
3. **透明度**:float bar 内(title 与 close 之间)加 `input.zc-float-alpha[type=range][min=60][max=100][step=5]`,`title="背景透明度"`。change/input → `callbacks.onOpacityChange(value)`;plugin 存 `setPrefString("floatOpacity", value)` 并 `renderChatViews()`。视图 state 增 `opacity: number`(默认 100);render 时设 `panel.style.setProperty("--zc-float-alpha", String(opacity / 100))`。styles.css:`.zc-float` 背景改用 `opacity` 不可行(会影响文字)——将现有背景色/backdrop 规则改造为 `background: color-mix(in srgb, <现底色> calc(var(--zc-float-alpha, 1) * 100%), transparent);`(保持现有色值,只引入 alpha 变量;backdrop-filter 保留不动)。滑块本身样式:窄(88px)、细轨道,随 bar hover 才显示(`opacity: 0; .zc-float-bar:hover & { opacity: 1 }` 风格,遵循现有 CSS 习惯)。
4. **CHANGELOG** Unreleased:三条(浮窗文字可选中修复、可调大小、透明度调节)。
5. **测试**(先 RED):
   - build-assets:bundle 后 CSS 含 `user-select: text`(float transcript 规则)与 `resize: both`。
   - float-panel:滑块存在、change 触发 `onOpacityChange(85)`;`setState({ opacity: 85 })` 后 panel style 含 `--zc-float-alpha: 0.85`;选中未收起时点击 `.zc-math-copy` 不复制(stub getSelection 返回 isCollapsed:false),收起时复制。
   - sidebar:同样的 selection-guard 测试一条。
   - plugin-state:mount 恢复 floatSize pref(stub pref → 断言 host/panel 内联尺寸);onPanelResize 写 pref(防抖用 fake timers)。
   - ResizeObserver 在 happy-dom 缺失时:视图需 `typeof ResizeObserver !== "undefined"` 守卫(测试断言无 ResizeObserver 环境不抛错)。
