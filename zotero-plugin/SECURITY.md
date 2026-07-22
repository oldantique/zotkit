# Security model

Zotero plugins run with elevated local privileges, so Zotkit keeps the paper-assistant path deliberately narrow:

- It never calls Zotero item save, collection mutation, attachment relink, annotation/note creation, database write, or index-update APIs.
- Reader access is observational. Automatic context capture reads only the visible PDF.js page or Zotero's existing indexed text; PDFWorker extraction is reserved for explicit user-requested search. The terminal MCP exposes only bounded current-page and latest-selection snapshots.
- The interactive Codex terminal is fixed to `sandbox: read-only` and `approvalPolicy: untrusted`.
- The real Codex PTY runs behind the authenticated native helper. No unauthenticated Codex TCP or WebSocket listener is exposed.
- The helper listens only on `127.0.0.1`, requires a fresh high-entropy bearer token, and terminates child processes when Zotero or the client disconnects.
- The bearer secret is transferred through a mode-0600 temporary file, consumed and unlinked by the helper; it is not placed in process arguments.
- Login remains owned by the installed Codex CLI. Zotkit never opens, parses, copies, or persists `~/.codex/auth.json`, API keys, or browser cookies.
- Generated context, shared library snapshots, and session files are confined below a mode-0700 `<Zotero Profile>/zotkit/` directory; sensitive context and terminal MCP files are additionally mode 0600. No PDF or full-text copy is materialized. Each Zotero library has one bounded metadata snapshot rather than per-paper metadata copies, and cleanup fails closed on symlinks or unknown files.
- Original attachment folders, Zotero `storage`, attachment links, and configured external PDF folders are read-only references. Zotkit never places helper files beside a PDF.
- External-library discovery returns PDF filename/path metadata only. Hidden components, traversal, non-PDF files, off-root canonical paths, and symlinks are rejected.

The right Item Pane terminal starts Codex read-only with untrusted-command approvals; Claude Code starts in plan mode. The XPI-bundled `zotkit_library` MCP surface exposes exactly four discovery-only tools: `zotkit_find_items`, `zotkit_get_item`, `zotkit_list_collections`, and `zotkit_list_tags`. It reads a local Zotero Desktop metadata snapshot and requires no Python runtime, external Zotkit installation, Zotero Web API key, `.env`, or WebDAV credentials.

The native Reader MCP exposes exactly six read-only tools: the recommended atomic
`get_reader_context` call plus `get_active_paper`, `get_current_page`,
`get_current_selection`, `list_library_files`, and `search_library_files`. It does
not expose annotations, arbitrary PDF page reads, automatic whole-PDF extraction,
Zotero writes, or arbitrary filesystem access.

The bundled universal helper receives a local ad-hoc signature. Public distribution outside this local build should additionally use an Apple Developer ID signature and notarization.
