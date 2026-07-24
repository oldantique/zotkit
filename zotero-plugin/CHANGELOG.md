# Changelog

## Unreleased

- 新增 ⌘K 浮动提问窗：Spotlight 式毛玻璃卡片悬浮于 PDF 之上，自动携带当前选区，与侧边栏共享同一会话；Esc/⌘K 关闭，可拖动。
- 全部界面改为 Apple 风格：系统蓝主题（浅色 #007AFF / 深色 #0A84FF）、系统灰阶、iMessage 式用户气泡、毛玻璃顶栏与登录遮罩。
- 浮窗内新增模型切换器，与侧边栏共用同一模型偏好。
- 修复：浮窗中 AI 回答误入侧边栏头像栅格的 22px 列导致文字竖排（一字一行）；发送按钮箭头图标路径画出画布外显示残缺。
- 新增 CLI 式活动状态行：思考、调用工具、执行命令期间实时显示当前动作与计时，回合结束后折叠为可展开的步骤数与总耗时摘要；浮窗与侧边栏共用同一套逻辑。
- 回答气泡新增一键复制按钮，仅出现在助手消息上，使用特权剪贴板辅助避免受限上下文里复制失败。
- 渲染后的数学公式支持点击复制其原始 LaTeX 源码。
- 新增问答自动同步到 Zotero 笔记：为当前条目维护一篇打有 `zotkit-chat` 标签的笔记，按会话分节追加最新问答，安全转换为笔记可用的 HTML 并与已有分节匹配合并，而非重复创建。
- 修复全文检索在 Zotero 索引默认按 100 页截断时被误判为完整的问题：新增基于 `Zotero.Fulltext.getPages` 的权威索引/总页数校验，一旦索引不完整即回退到无页数上限的 PDFWorker 提取，确保 `zotero_search_current_pdf` 与终端 MCP 都能看到全文而非被截断的前 100 页。
- 新增 `zotero_get_pdf_outline` 工具：返回当前 PDF 的目录（大纲/书签），含一开始编号的页码与嵌套深度，便于长论文先规划章节再用 `zotero_read_pdf_pages` 精读；没有内嵌目录时会提示改用 `zotero_search_current_pdf`。
- 修复：审批变更（`resolveReview`）在检查 `pending` 状态前就已跨越多个 `await`，双击 Apply（或任何并发的第二次调用）都会重跑 snapshot → checkpoint → apply，`replace_pdf` 场景下第二次运行会用已替换后的字节覆盖 checkpoint，永久销毁唯一可用的回滚备份。现在同步检查状态并在第一个 `await` 之前即置为 `resolving`；全部 accept/reject 都串行经过同一队列，不同审批之间也不会交错执行 apply。
- 修复：提议变更的 Diff 视图会把字段值截断到 800 字符并拍平换行，collection 标签也未经净化直接插入——提示注入可以让审阅看到的内容和 Apply 实际写入的字节不一致。现在 Diff 完整呈现每个字符、逐行保留换行（控制字符与 bidi 覆盖字符转义为可见的 `\uXXXX`），collection 标签同样经过净化，单字段超过 20000 字符时会直接拒绝提案而不再静默截断。
- 修复：relink 校验把包含根传成 `null`，库根之外的任意 `.pdf` 路径都会被接受（可与 `replace_pdf` 链式利用为任意文件覆盖）；symlink 检查又排在 `normalize()` 之后，对已解析路径判断等于恒假；Apply 还直接复用未重新校验的原始路径，评审通过到点击 Apply 之间换靶（TOCTOU）会附加与审阅时不同的字节。现在 relink 目标必须落在配置的 PDF 库根内，symlink 叶子在 `normalize()` 之前即被拒绝，校验得到的 canonical 路径会写回提案（Diff 与 Apply 保持一致），Apply 执行前还会用同样的 roots 重新校验一次再 relink。
- 修复：浮窗（⌘K 快速提问）挂载在 XUL 宿主窗口上，未显式声明 `user-select` 时正文与回答一律无法框选/复制；现在浮窗正文可正常选中与系统复制，拖拽栏与工具栏仍保持不可选中，点击公式一键复制也不再与拖拽选中互相误触发。
- 浮窗新增可调整大小：右下角原生拖拽手柄支持在 380–760px 宽、220px 至 85vh 高之间自由调整，尺寸变更防抖 500ms 后持久化，下次打开自动按上次尺寸恢复。
- 浮窗拖拽栏新增背景透明度滑块（60%–100%，随手柄悬停显现）：调节实时生效并持久化，仅影响背景毛玻璃透明度、不影响文字可读性。

## 0.3.0

- Made a Cursor-style Research Chat the default Reader surface while retaining the real Codex/Claude terminal as an advanced mode with a one-click return to Chat.
- Connected the structured UI to the local Codex `app-server`, reusing the Codex CLI login and adding streaming Markdown/LaTeX, model and reasoning controls, paper-scoped history, plans, tool cards, approvals, and conversation checkpoints.
- Added Cursor-compatible Reader shortcuts: `⌘I` focuses Chat, `⌘L` starts a new chat with the PDF selection, `⌘⇧L` attaches the selection to the current chat, and `⌘⇧J` opens Terminal.
- Automatically supplies the active paper metadata, original PDF path and directory, current page text, selection, annotations, and library tools without copying PDFs into the profile workspace.
- Added Agent-mode Zotero changes through `zotero_propose_changes`: metadata, collection membership, linked-attachment paths, and staged PDF replacements are validated, shown as a Diff, applied only after a user click, and checkpointed immediately beforehand.
- Kept Ask mode read-only and constrained Agent filesystem writes to the private staging workspace; requests to write directly outside it are rejected so original-library mutations cannot bypass Apply/Checkpoint.
- Marked paper/page/selection material as untrusted app-server context, canonicalized modern filesystem approval grants (including symlinks), and bound every staged PDF Diff to its size and SHA-256 before Apply.
- Invalidated Zotero and plugin full-text caches and reloaded matching Reader views after approved PDF/link changes; failed applies keep a visible checkpoint and report any rollback failure.
- Bounded retained checkpoints to 20 entries and 1 GiB of PDF backups; normal reading still creates no PDF copies, and restore itself first creates an undo checkpoint.
- Coalesced streaming UI updates to reduce CPU use and kept Reader refreshes scoped to an expanded Zotkit pane.

## 0.2.3

- Replaced the loopback TCP bridge with a profile-private Unix-domain socket, verified the local peer identity, kept the bearer token out of URLs, and rejected pre-existing socket nodes.
- Marked every helper, client, PTY, pipe, directory, and token descriptor close-on-exec, with adversarial tests proving Codex and Claude child processes inherit only standard input, output, and error.
- Added authenticated graceful helper shutdown, per-session error isolation, helper-death propagation, HTTP handshake deadlines, and bounded HUP → TERM → KILL cleanup so stubborn child processes cannot survive an idle close or Zotero shutdown.
- Exposed bounded `search_current_pdf` and `read_pdf_pages` tools to the terminal MCP, reusing Zotero's existing full-text cache in place and eliminating unreliable `textutil`/shell PDF fallbacks. Whole-PDF search is now a single pass, and final JSONL responses remain bounded even for control-heavy text.
- Made private PDFWorker fallback references an existence-checked, bounded LRU that is evicted with its pruned paper workspace and rebuilt safely when needed.
- Isolated malformed attachment properties while building the bundled Zotkit snapshot so one broken linked attachment can no longer disable library search.
- Added a compact, container-responsive research-workbench surface and a collapsible, safe KaTeX preview—with bundled fonts—for recent terminal formulas without changing the real PTY interaction.
- Clarified the difference between interactive-agent approvals, Claude plan mode, and the strictly read-only app-server path, and made every XPI build recompile the native helper from source.

## 0.2.2

- Fixed MCP stdio JSONL framing so pretty-printed Reader context can never split one JSON-RPC response across physical lines.
- Pre-approved only the two XPI-bundled read-only MCP servers and added a 10-second tool timeout, eliminating hidden multi-minute approval waits while preserving approval rules for shell commands and user MCPs.
- Marked all bundled Reader and Zotkit tools with explicit read-only, non-destructive, idempotent, closed-world annotations.
- Negotiated MCP `2025-06-18`, the protocol revision that defines structured tool results, and fail closed if a result cannot be serialized as one valid JSONL message.
- Loaded Zotero annotation data before item data when building the bundled Zotkit library snapshot, matching Zotero 9's required lazy-data order.
- Preserved useful messages from cross-realm Zotero exceptions so snapshot failures no longer appear only as “unknown error”.

## 0.2.1

- Added one atomic `get_reader_context` call and explicit serial-call guidance to prevent Codex MCP queue deadlocks.
- Disabled the embedded Codex `code_mode_host` feature, which was issuing concurrent calls against the same Reader server.
- Completed the Finder-launched Zotero `PATH` with standard Homebrew/local locations so existing Node-based Codex MCP plugins can start normally.
- Queued bounded PDF selections until the Codex/Claude prompt is ready, so startup output can no longer overwrite the inserted passage; Codex never force-flushes queued text on a timer.
- Removed automatic PDFWorker fallback from page-change refreshes; whole-PDF extraction now remains an explicit search-only operation.
- Fixed bundled Zotkit snapshots by bulk-loading Zotero 9's lazy item metadata before serialization and surfacing snapshot failures in `context.json`.
- Reused each in-memory Zotero library snapshot for 24 hours unless the user explicitly refreshes it, avoiding repeated large-library enumeration.
- Avoided PDF-directory and snapshot filesystem validation on basic live Reader context calls.

## 0.2.0

- Replaced the custom app-server chat UI with a real PTY-backed Codex terminal directly in Zotero's right Item Pane.
- Made the original PDF directory the read-only Codex working directory, with the bounded profile workspace as fallback.
- Added visible, non-submitting selection insertion with paper metadata, PDF path, directory, and page context.
- Bundled Zotkit's four read-only metadata tools in the XPI alongside the five-tool live Reader MCP; no external Python, `pipx`, API key, or Zotkit configuration is required.
- Added one bounded, shared metadata snapshot per Zotero library instead of copying library data into per-paper workspaces.
- Kept process startup lazy, bounded per-paper sessions, and idle cleanup for low-power use.
- Followed Zotero's per-Reader Item Pane lifecycle so A → B → A tab switches remount the matching terminal session and refresh the matching context.
- Made the no-write boundary unconditional in Codex instructions; mutating Zotkit commands are not bundled in the Reader CLI.
- Removed the generic zsh mode; the terminal selector is limited to Codex and Claude Code.
- Renamed the product and XPI artifact to Zotkit and adopted the independent add-on ID `zotkit@oldantique.github.io`; the old ZoteroChat ID is not retained.
- Moved private plugin state to `<Zotero Profile>/zotkit/` and kept original PDFs and their containing directories free of generated files.

## 0.1.3

- Fixed Zotero Fluent localization so section titles, fixed-width sidenav buttons, and section actions keep their native DOM and no longer overflow or erase the chat UI.
- Made Codex, the native helper, and Reader context capture lazy; repeated page notifications are deduplicated and whole-PDF extraction runs only for an explicit search.
- Stopped copying full text into per-paper folders, bounded page/selection mirrors, added a three-paper in-memory LRU, and safely pruned profile workspaces to 24 entries or 14 idle days.
- Bounded terminal resources to four sessions, reclaimed hidden sessions after 15 minutes, reduced scrollback, paused hidden cursor animation, and made helper/child shutdown resilient to Zotero termination.
- Verified the complete sidebar and composer in an isolated Zotero 9.0.6 profile at a 304-pixel pane width.

## 0.1.2

- Fixed the Zotero 9 Reader pane lifecycle so the chat interface mounts during `onRender` instead of leaving an empty section.
- Kept the paper question composer and CLI entry visible in compact or short Reader panes.
- Replaced font-dependent toolbar glyphs with bundled SVG icons and added native section-header shortcuts for new chat and terminal.

## 0.1.1

- Added Zotero's required `applications.zotero.update_url` manifest field so Zotero 9 accepts the XPI. The reserved `.invalid` host intentionally provides no remote update channel for this local build.
- Resolved the macOS home directory through Gecko's directory service instead of the unavailable `PathUtils.homeDir` property in Zotero 9.

## 0.1.0

- Added a Cursor-style Codex chat section to Zotero 9 PDF Reader.
- Added ChatGPT OAuth through Codex app-server with shared CLI authentication.
- Added per-paper threads, thread history, streaming content, tool cards, model selection, reasoning effort, interrupt, and follow-up steering.
- Added read-only current PDF, page, selection, full-text search, page reading, library filename search, and annotation tools.
- Added a real xterm.js terminal drawer backed by a universal macOS PTY helper.
- Added Codex, Claude Code, and zsh terminal sessions with per-paper workspaces and Reader MCP configuration.
- Added strict Zotero/library non-mutation boundaries and automated tests.
- Routed Codex app-server over authenticated helper stdio, moved helper secrets out of process arguments, and made paper chat permanently read-only.
- Added safe cross-PDF page reading and full-text search across existing user/group-library attachments.
- Added bundled KaTeX rendering, incremental streamed-entry reconciliation, and persisted model, reasoning, terminal-agent, and terminal-height preferences.
