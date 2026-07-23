# Changelog

## Unreleased

- 新增 ⌘K 浮动提问窗：Spotlight 式毛玻璃卡片悬浮于 PDF 之上，自动携带当前选区，与侧边栏共享同一会话；Esc/⌘K 关闭，可拖动。
- 全部界面改为 Apple 风格：系统蓝主题（浅色 #007AFF / 深色 #0A84FF）、系统灰阶、iMessage 式用户气泡、毛玻璃顶栏与登录遮罩。

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
