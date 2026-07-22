# zotkit

Tools for working with a Zotero library alongside AI agents. One repo, two shipped
components with deliberately different trust boundaries (see ADR-0001).

## Language

### Components

**zotkit (Python package)**:
The headless CLI + library at the repo root that talks to the Zotero Web API and
WebDAV. Cross-platform, needs no desktop app.
_Avoid_: "the CLI" alone when the Reader plugin is in scope — say which component.

**Reader plugin**:
The Zotero 9 desktop add-on in `zotero-plugin/` (XPI). Puts an agent-CLI terminal in
the PDF Reader's sidebar. Does not install or invoke the Python package.
_Avoid_: "the XPI" in docs prose; "Codex plugin" (it drives Codex *or* Claude Code).

**agent CLI**:
The external coding-agent binary the Reader plugin drives in its terminal — Codex CLI
or Claude Code, chosen in settings. Authenticated by the user, never by the plugin.

**native helper**:
The macOS helper binary (compiled from `zotero-plugin/native/`) that owns PTY sessions
for the Reader plugin and talks to it over an authenticated local socket.

### Interfaces

**Reader MCP**:
The plugin's built-in read-only MCP server exposing the *active reading context*:
current paper, page snapshot, text selection, PDF paths.

**metadata MCP**:
The plugin's bundled read-only MCP server exposing *library-wide metadata* discovery
(`zotkit_find_items`, `zotkit_get_item`, `zotkit_list_collections`, `zotkit_list_tags`).
Implemented natively inside the plugin — it is **not** the Python package.
_Avoid_: "zotkit MCP" without qualification; the planned MCP wrapper around the Python
package is a different, future thing.

**metadata snapshot**:
The plugin's per-library read-only cache of Zotero metadata that the metadata MCP
serves from.

### Boundaries

**headless**:
Never needs the Zotero app or any window open; talks straight to the Web API. Property
of the Python package only — the Reader plugin is by definition not headless.

**read-only guarantee**:
The Reader plugin's core promise: it never mutates items, collections, tags,
annotations, attachment links, original PDFs, or files beside them; generated files
stay under the add-on's private profile directory.
