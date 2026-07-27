# zotkit

Tools for working with a Zotero library alongside AI agents. Two shipped components with
deliberately different trust boundaries, now in **two repos** (see ADR-0003, which supersedes
ADR-0001): the Python package here, the Reader plugin at
[oldantique/zotkit-reader](https://github.com/oldantique/zotkit-reader).

The plugin-side entries below are kept because the vocabulary is shared across both repos and
docs here still refer to it; **the plugin's own terms are owned by its repo now**, and paths
given for it are relative to *that* repo.

## Language

### Components

**zotkit (Python package)**:
The headless CLI + library at the repo root that talks to the Zotero Web API and
WebDAV. Cross-platform, needs no desktop app.
_Avoid_: "the CLI" alone when the Reader plugin is in scope — say which component.

**Reader plugin**:
The Zotero 9 desktop add-on shipped from [oldantique/zotkit-reader](https://github.com/oldantique/zotkit-reader)
(XPI). Puts an agent-CLI terminal — and a structured Research Chat — in the PDF Reader's
sidebar. Does not install or invoke the Python package.
_Avoid_: "the XPI" in docs prose; "Codex plugin" (it drives Codex *or* Claude Code);
`zotero-plugin/` as a path (that directory no longer exists here — the plugin is its own repo).

**agent CLI**:
The external coding-agent binary the Reader plugin drives in its terminal — Codex CLI
or Claude Code, chosen in settings. Authenticated by the user, never by the plugin.

**native helper**:
The macOS helper binary (compiled from `native/` in the zotkit-reader repo) that owns PTY
sessions for the Reader plugin and talks to it over an authenticated local socket.

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

**deterministic-write guarantee**:
The Reader plugin's core promise, superseding the original read-only guarantee:
the model is never given a Zotero write tool; every Zotero mutation (highlight
anchors, note attachments, approved metadata changes) is executed by
deterministic plugin code in response to an explicit user gesture, and is
individually undoable. Generated files still stay under the add-on's private
profile directory until the user applies them.
_Avoid_: calling the plugin "read-only" without qualification.
