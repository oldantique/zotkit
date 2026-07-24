# Round-3 门槛修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。

**Goal:** 落地 PR #1 round-3 评审的 4 条门槛:Gate1 残留(不可见字符/标签行拆分)、Gate3 残留(relink canonical 断言/replace 目标校验)、note-sync 三件套(条目绑定/首次确认/管理区块合并)、Restore 串行化。

**产品决策(用户已定):** 自动笔记采用"首次弹一次确认"——默认不写,第一次将要写时侧边栏出确认卡,记住选择。

## Global Constraints

- `npm ci --offline`;不跑 build/verify。`npx vitest run` 基线 327 全绿;`npx tsc --noEmit` 干净。
- 提交信息末尾:`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 安全修复全部对抗性 TDD;源文件禁止内嵌原始控制/不可见字节(用 \uXXXX 转义构造)。

### Task 1: Gate 1 残留 — 不可见字符 + 标签行拆分

**Files:** `src/zotero-mutations.ts`(DANGEROUS_DIFF_CHARS ~977、collection 标签 ~858-862);`test/zotero-mutations.test.ts`

- `DANGEROUS_DIFF_CHARS` 追加(regex 用 \uXXXX 转义书写,源文件严禁原始不可见字节):U+200B、U+200C、U+200D(零宽)、U+FEFF(BOM)、U+2060(WJ)、U+2028、U+2029(行/段分隔)、U+061C(ALM)。
- 新 `sanitizeInlineDiffText(value)` = 先 `sanitizeDiffText`,再把换行符替换为 6 字符字面文本 \u000A、制表符替换为 \u0009;collection 标签渲染改用它(标签是单行内插,含换行即可伪造 diff 行)。
- 测试(RED 先,测试输入一律用 "\u200B" 这类转义构造):字段值含 U+200B → diff 中出现字面文本 \u200B;标签含换行 → diff 总行数不变且标签行内含字面文本 \u000A;既有转义测试不回归。
- Commit: `fix(mutations): escape invisible codepoints; inline-escape collection labels`

### Task 2: Gate 3 残留 — canonical 断言 + replace 目标校验

**Files:** `src/zotero-mutations.ts`(relink apply ~603-609、replace_pdf apply ~613-632、validate/fingerprint 区);`test/zotero-mutations.test.ts`

- **relink**:apply 分支重新 `validatePdfPath` 后,`if (inspected.canonicalPath !== operation.newPath) throw new Error("The relink target's real path changed after review. Generate a fresh proposal.")`(operation.newPath 即评审时 canonical)。
- **replace_pdf 目标**:提案校验时对目标 `current.attachment.resolvedPath` 做:叶子 `isSymlink` 拒绝 + `normalize()` 得 canonical,存入 staged binding(新字段 `destinationCanonicalPath`);apply 时重算并断言与存值相等(不等 → throw,不写任何字节),写入时使用 canonical 目标路径。旧 binding 无该字段(理论上不存在,内存态)按缺失拒绝。
- 测试(RED 先):relink 父目录换靶(propose 后改 stub 的 normalize 映射)→ apply 抛错且 `relinkAttachmentFile` 未调用;replace 目标叶子 symlink → 提案拒绝;propose 后目标 canonical 变化 → apply 抛错且未发生写入(spy 断言 write/rename 未调用)。
- Commit: `fix(mutations): pin relink and replace targets to their reviewed canonical paths`

### Task 3: note-sync — 条目绑定 + 首次确认 + 管理区块合并

**Files:** `src/plugin.ts`(turn origin、consent 流)、`src/note-sync.ts`(merge 重构)、`src/sidebar.ts`(确认卡)、`src/styles.css`、`prefs.js`、`CHANGELOG.md`;`test/note-sync.test.ts`、`test/plugin-state.test.ts`、`test/sidebar.test.ts`

1. **条目绑定**:`turnOrigin: Map<threadId, string>`,running false→true 时记 `${libraryID}-${attachment.key}`(取自 `this.context.attachment`;context 为空记 ""),完成时若与当前 context 身份不符 → 跳过写入 + `debug` 日志;清理与 turnStartedAt 同步。测试:开始后切换 context 身份 → syncChatNote 不被调用。
2. **首次确认**:pref `noteSyncConsent`(字符串 "": 未决 / "granted" / "denied",prefs.js 注册默认 "")。`onTurnCompleted` 写入条件改为 `noteSync !== false && consent === "granted"`;若 consent 为 "" 且本轮本可写 → 置 sidebar state `noteConsentPrompt: true`。侧边栏渲染确认卡(样式随现有 card):文案"把问答自动保存为该条目的笔记?"+ 按钮「开启」/「不用」→ callbacks `onNoteConsent(granted: boolean)`;plugin 设 pref("granted"/"denied")、清 prompt,granted 时立即对当前线程执行一次 syncChatNote。denied 后不再打扰(prompt 只在 consent==="" 时出现)。测试:consent 空→完成一轮→prompt 出现且未写;点「开启」→pref granted+立即同步;点「不用」→pref denied+不写不再提示;consent granted→直接写。
3. **管理区块合并**(丢数据修复):note 结构改为
   `[用户前缀(原样保留)] <h1 data-zotkit-chat="begin">AI 研究笔记 — 标题</h1> [线程分节们] <hr data-zotkit-chat="end"> [用户后缀(原样保留)]`
   - 定位 begin/end 标记;仅重建标记之间的内容(分节合并逻辑沿用现 data-zotkit-thread/标题回退);begin 有而 end 缺 → 管理区延伸到文末(降级,文档注明)。
   - 迁移:无标记但含 `data-zotkit-thread` 的 h2 → 视为全托管旧格式,整篇重建并补标记;无标记且无 zotkit h2(用户自己打了 zotkit-chat 标签的笔记)→ 整篇保留为前缀,在末尾追加管理区块,不清洗用户内容。
   - 测试:前缀/后缀跨两次 sync 保留;旧格式升级;外来标签笔记不被清洗;幂等(同数据两次 merge 字节相同)。
4. CHANGELOG:本任务三条 + Task1/2/4 各一条(集中在此提交)。
- Commit: `fix(note-sync): bind writes to the originating item, one-time consent, managed-block merge`

### Task 4: Checkpoint Restore 与 Apply 串行

**Files:** `src/zotero-mutations.ts`(restore 入口 ~344-368、resolveQueue 复用)、`src/sidebar.ts`(Restore 按钮禁用 ~1181-1194);`test/zotero-mutations.test.ts`、`test/sidebar.test.ts`

- 抽取 `private runExclusive<T>(run: () => Promise<T>): Promise<T>`(现 resolveReview 的队列逻辑),restore 检查点入口同样经它执行;restore 执行期间 resolveReview 的同步 pending 检查不受影响(状态机不变)。
- 侧边栏:存在 `state === "resolving"` 的 review 时禁用所有 Restore 按钮(反向亦然可选,不强制)。
- 测试(RED 先):restore 与 accept 并发 → host 调用严格串行(deferred 排序);resolving 期间 Restore 按钮 disabled。
- Commit: `fix(mutations): serialize checkpoint restore with review resolution`
