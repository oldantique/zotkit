# Security model

Zotero plugins run with elevated local privileges, so Zotkit keeps the paper-assistant path deliberately narrow:

- It never calls Zotero item save, collection mutation, attachment relink, annotation/note creation, database write, or index-update APIs.
- Reader access is observational. Automatic context capture reads only the visible PDF.js page or Zotero's existing indexed text. When terminal activation finds no usable Zotero index for the active attachment, PDFWorker may prepare the bounded private fallback described below. The terminal MCP exposes bounded context, active-PDF search/page reads, and filename/path discovery only.
- The interactive Codex terminal starts with `sandbox: read-only` and `approvalPolicy: untrusted`. This is read-only by default, but it is not unconditional OS-level containment: the user can explicitly approve an escalation. Only the two XPI-bundled, annotated read-only MCP servers are pre-approved; shell commands and user-configured MCP servers retain the visible approval path.
- The Claude Code terminal starts with `--permission-mode plan`. Plan mode is a Claude Code policy, not an OS sandbox imposed by Zotkit, and is not advertised as filesystem-level read-only containment.
- The separate structured Codex app-server implementation uses `sandbox: read-only` with `approvalPolicy: never`; its client handlers decline command and file-change requests and grant no requested permissions. Unlike the interactive TUI, that path does not offer an approval route to escalation.
- The real Codex PTY runs behind the authenticated native helper. It opens no TCP port: transport uses a mode-0600 Unix-domain socket inside the plugin's mode-0700 profile runtime directory, rejects pre-existing socket nodes, and verifies the connecting peer UID with `getpeereid()`.
- Each launch receives a fresh high-entropy secret through a mode-0600 temporary file that is consumed and unlinked. The Reader WebSocket protocol authenticates plugin and helper with per-connection HMAC proofs tied to the WebSocket key; that protocol never places the secret in process arguments, URLs, headers, or socket payloads. The helper's optional diagnostic `/health` endpoint separately accepts an `Authorization: Bearer` header over the same private Unix socket and is not used by the plugin.
- Helper, accepted-client, PTY, pipe, token, and directory descriptors are close-on-exec, so Codex and Claude children inherit only standard input/output/error. The helper terminates owned child processes when Zotero or the client disconnects.
- Login remains owned by the installed Codex CLI. Zotkit never opens, parses, copies, or persists `~/.codex/auth.json`, API keys, or browser cookies.
- Generated context, shared library snapshots, and session files are confined below a mode-0700 `<Zotero Profile>/zotkit/` directory; sensitive context and terminal MCP files are additionally mode 0600. Original PDFs are never copied. Existing Zotero `.zotero-ft-cache` text is referenced in place; only when an active attachment lacks an index may one bounded `current-pdf-text.txt` fallback be created in the private, automatically pruned workspace. Each Zotero library has one bounded metadata snapshot rather than per-paper metadata copies, and cleanup fails closed on symlinks or unknown files.
- Original attachment folders, Zotero `storage`, attachment links, and configured external PDF folders are read-only references. Zotkit never places helper files beside a PDF.
- External-library discovery returns PDF filename/path metadata only. Hidden components, traversal, non-PDF files, off-root canonical paths, and symlinks are rejected.

Zotkit's own Reader integration and bundled tools are observational and do not mutate the Zotero library or paper files. Agent execution has the distinct policies described above: interactive Codex is read-only unless the user approves escalation, Claude Code is in plan mode without a Zotkit-enforced OS sandbox, and the structured app-server path is read-only with escalation automatically declined. The XPI-bundled `zotkit_library` MCP surface exposes exactly four discovery-only tools: `zotkit_find_items`, `zotkit_get_item`, `zotkit_list_collections`, and `zotkit_list_tags`. It reads a local Zotero Desktop metadata snapshot and requires no Python runtime, external Zotkit installation, Zotero Web API key, `.env`, or WebDAV credentials.

The native Reader MCP exposes exactly eight annotated read-only tools: the recommended atomic
`get_reader_context` call plus `get_active_paper`, `get_current_page`,
`get_current_selection`, `search_current_pdf`, `read_pdf_pages`,
`list_library_files`, and `search_library_files`. Full-text tools accept only the
validated active-attachment text reference and enforce query, result, page-range,
file-size, and output limits. It does not expose annotations, cross-attachment page
reads, Zotero writes, or arbitrary filesystem access.

The bundled universal helper receives a local ad-hoc signature. Public distribution outside this local build should additionally use an Apple Developer ID signature and notarization.
