# 审批模型完整性修复(PR #1 round-2 合并门槛)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 落地 round-2 评审的三条合并门槛修复:diff 保真、resolveReview 单次化/串行化、relink_attachment 路径收容,全部带对抗性回归测试。

**Architecture:** 全部在 `zotero-plugin/src/zotero-mutations.ts`(+ sidebar 的 diff 视图滚动样式、CHANGELOG)。不改协议、不改审批 UI 结构。

**评审原文依据:** PR #1 round-2 review(oldantique,2026-07-23)三条 [med]:①1 diff 只渲染前 800 字符且拍平换行、collection 标签未净化;②2 `resolveReview` 不检查 `pending`、跨 await 无锁,双击重跑 snapshot→checkpoint→apply,`replace_pdf` 二跑毁掉回滚备份;③3 `validatePdfPath(newPath, null, …)` 全盘放行、`normalize()` 先于 `isSymlink()`(检查恒假)、canonical path 被丢弃(TOCTOU)。

## Global Constraints

- 本机 `npm ci --offline`;不跑 `npm run build`/`verify`(需 macOS)。测试 `npx vitest run`,类型 `npx tsc --noEmit`,基线 284 项全绿。
- 提交信息末尾:`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 这是安全修复:每项都要有"攻击者视角"的失败测试(双击、隐藏尾巴、bidi、symlink 换靶),先 RED 后 GREEN。
- 错误文案沿用该文件现有英文风格。

---

### Task 1: `resolveReview` 单次化与串行化

**Files:** Modify `src/zotero-mutations.ts`(resolveReview ~216);Test `test/zotero-mutations.test.ts`

**要求:**
- `DiffReview.state` 增加 `"resolving"`(同步补充 sidebar.ts 的类型与按钮禁用条件:`state !== "pending"` 时 Apply/Ignore 禁用)。
- `resolveReview` 入口**同步**检查 `pending.review.state === "pending"`,否则抛 `"This change review was already resolved or is being applied"`;检查通过后**在第一个 await 之前**置 `state = "resolving"` 并 `onState()`。
- reject 分支同样要求 pending 状态。
- 成功 → 既有终态(applied/rejected);任何失败路径保持既有 `"failed"` 语义。终态一旦离开 `pending` 不可再次进入 apply(重入即抛)。
- 串行化:`private resolveQueue: Promise<unknown> = Promise.resolve();` 全部 resolveReview 执行体通过 `this.resolveQueue = this.resolveQueue.catch(() => {}).then(run)` 链接,并返回该次 run 的结果(全局串行即可,不需要按附件分键——变更稀少,简单正确优先)。同步 state 检查必须在入队前完成(否则两次点击都排进队列)。
- 测试(先 RED):
  1. 双击:同一 review 并发两次 accept,第二次同步抛错,`host.createCheckpoint`/apply 只执行一次(spy 计数)。
  2. replace_pdf 二跑防护:第一次 accept 完成后再次 accept → 抛错,checkpoint 不再创建(回滚备份不被覆盖)。
  3. reject 后 accept → 抛错。
  4. 串行:两个不同 review 并发 accept,host.apply 调用顺序严格串行(用可分辨的 deferred 断言无交错)。

### Task 2: diff 保真(所见即所写)

**Files:** Modify `src/zotero-mutations.ts`(diffValue ~891、buildMutationDiff ~781、set_fields 接受上限 ~723)、`src/sidebar.ts`/`src/styles.css`(.zc-diff-view 滚动)、Test `test/zotero-mutations.test.ts`

**要求:**
- 新 `sanitizeDiffText(value: string): string`:C0/C1 控制字符(保留 `\n`、`\t`)与 bidi 覆盖字符(U+202A–U+202E、U+2066–U+2069、U+200E、U+200F)替换为可见转义(如 `‮` 字面量);其余原样。
- `diffValue` 不再截断、不再拍平换行:值先 `sanitizeDiffText`,按 `\n` 拆行,首行接在 `- `/`+ ` 后,续行以 `-   `/`+   `(同符号缩进)逐行输出——diff 呈现的就是将写入的完整字节(转义后)。空值仍 `(empty)`。
- `set_fields` 接受上限从 `slice(0, 100_000)` 改为**超限拒绝**:`> 20_000` 字符抛 `"Field ${field} exceeds the 20000-character reviewable limit"`(不再静默截断——静默截断本身就是"所见非所写")。
- collection 标签经 `sanitizeDiffText` 后进 diff;relink/replace 的路径行同样过 sanitizer。
- `.zc-diff-view` 必须可滚动:检查 styles.css,若无则加 `max-height: 320px; overflow: auto;`。
- 测试(先 RED):
  1. 隐藏尾巴:801+ 字符的 abstractNote 提案,diff 包含完整值(断言尾部内容出现在 diff 中)。
  2. 多行值:含 `\n` 的值逐行呈现且行前缀正确,不拍平。
  3. bidi:含 U+202E 的值在 diff 中以 `‮` 字面转义出现。
  4. 超限:20001 字符字段 → 提案被拒。
  5. collection 标签含控制字符 → diff 中已转义。

### Task 3: `relink_attachment` 收容 + symlink/TOCTOU 修复

**Files:** Modify `src/zotero-mutations.ts`(validateOperations ~432、apply 分支 ~723、validatePdfPath ~933);Test `test/zotero-mutations.test.ts`;`CHANGELOG.md`(本轮三条修复一并记 Unreleased)

**要求:**
- `validatePdfPath` 修 symlink 次序:`makeLocalFile(path)` 后**先** `isSymlink?.()` 检查(normalize 之前,此时针对未解析的叶子),再 `normalize()` 得 canonical;canonical 与原 path 不同目录树时依然以 canonical 做 roots 包含检查(现状)。错误文案参数化:新增可选参数 `containmentError?: string`,replace 用现文案,relink 用 `"Relink targets must live under the configured PDF library root"`。
- relink 校验:`validatePdfPath(operation.newPath, [configuredLibraryRoot()], ioUtils, …)`(从 `./platform` 导入 `configuredLibraryRoot`),**不再传 null**;校验后把 `operation.newPath` 规范化为返回的 `canonicalPath`(存回 operation,后续 diff 与 apply 都用 canonical)。
- apply 分支(`relinkAttachmentFile`):不再直接用 `operation.newPath` —— 先以相同 roots **重新** `validatePdfPath`(apply 时二次校验,与 replace_pdf 的模式对齐,封死评审→应用之间的换靶窗口),将返回的 `canonicalPath` 传给 `attachment.relinkAttachmentFile`。
- 测试(先 RED):
  1. 库根之外的绝对路径 `.pdf` 提案 → 拒绝(信息含 "library root")。
  2. symlink 叶子(stub `isSymlink: () => true`)→ 校验时拒绝,即使 normalize 后的目标是合法文件。
  3. TOCTOU:提案时合法,apply 前把 stub 改为 symlink/移出库根 → apply 抛错,`relinkAttachmentFile` 未被调用。
  4. canonical 传递:stub normalize 改写路径(如 `/root/./a.pdf` → `/root/a.pdf`),断言 `relinkAttachmentFile` 收到 canonical。
- CHANGELOG Unreleased 增三条(diff 保真/审批单次化/relink 收容),风格随现有条目。
