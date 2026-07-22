# Zotero Reader and Codex integration

This repository contains the existing root project and the installable add-on with
deliberately different trust boundaries:

- `zotero-plugin/` is the installable Zotero add-on. It observes the active Reader,
  hosts a real Codex terminal in the right sidebar, and includes the read-only Zotkit
  metadata CLI/MCP used by that terminal.
- The root `zotkit` Python package predates this integration. The XPI does not install,
  launch, configure, or depend on it; no external Zotkit CLI is part of the Reader
  workflow.

The plugin does not replace Zotero's database, relink attachments, or copy PDFs into
a second library.

## Reader-to-terminal flow

```text
Zotero Reader
  ├── bibliographic metadata and attachment key
  ├── original PDF path and containing directory
  ├── visible page
  └── selected text
          │
          ▼
right-sidebar xterm.js terminal
          │ authenticated local PTY
          ▼
real `codex` CLI
  ├── `--no-alt-screen --sandbox read-only --ask-for-approval untrusted`
  ├── cwd/`--cd` = directory containing the active PDF
  └── live Reader MCP + bundled read-only Zotkit metadata MCP
```

The terminal starts lazily when the user opens the assistant, rather than starting
one process for every viewed paper. The PDF's containing directory is used as the
working directory so that Codex sees the same local research context the user sees.
If that directory is missing or unusable, the terminal falls back to its private
profile context workspace. The original directory is always a read-only reference:
the add-on must not place `AGENTS.md`, indexes, notes, or any other generated files
beside the original PDF.

When the user selects text in the Reader, the add-on captures the extractable text,
page number, and current item identity. “Send to Codex” inserts a bounded plain-text
context block into the terminal input together with the user's question. Control
characters and line breaks are normalized so the insertion cannot submit itself. The
user can review the visible one-line input before it is submitted. Live Reader tools
remain authoritative after a tab, page, or selection change.

## Zotkit boundary

The paper-reading path and Zotero-library discovery/query path are intentionally separate:

| Surface | Intended operations | Default policy |
| --- | --- | --- |
| Reader MCP | Active-paper metadata/PDF path, bounded current-page and latest-selection snapshots, PDF filename/path listing and search | Read-only |
| Bundled Zotkit MCP | Search and inspect the local Zotero library metadata snapshot | Read-only |

Codex should use the structured read-only Zotkit MCP tools for ordinary paper chat.
The XPI starts its bundled native metadata server directly; it does not search for an
external `zotkit` executable or Python runtime. Its deliberately small tool surface is:

- `zotkit_find_items`
- `zotkit_get_item`
- `zotkit_list_collections`
- `zotkit_list_tags`

The native Reader MCP likewise has an intentionally fixed six-tool surface. Ordinary
paper questions should use the atomic first tool; granular calls must be awaited
serially:

- `get_reader_context`
- `get_active_paper`
- `get_current_page`
- `get_current_selection`
- `list_library_files`
- `search_library_files`

It does not expose annotations, arbitrary PDF page reads, automatic whole-PDF extraction, Zotero
writes, or arbitrary filesystem access. Page and selection text come from bounded
profile snapshots maintained by the plugin; the two library tools return PDF filenames
and relative paths only.

Do not expose an unrestricted shell wrapper as a tool, and do not make mutating Zotkit
commands available through the automatic Reader context.

This division preserves the useful fusion:

1. Reader tools identify what the user is reading and supply local PDF context.
2. Zotkit tools search and inspect the wider Zotero library.
3. The real Codex CLI can combine both sources in one terminal conversation.
4. The add-on cannot turn a paper question into a Zotero write.

## Credentials and local state

The bundled metadata tools read Zotero Desktop's local, public read-only APIs and the
snapshot produced inside the add-on. They require no Zotero Web API key, Python
installation, `pipx`, `.env`, or `~/.config/zotkit/env`, and the XPI never searches for
those inputs. Codex authentication continues to belong to the locally installed Codex
CLI; the plugin never opens or copies its token files.

Small session and live-context files are confined below
`<Zotero Profile>/zotkit/`. Metadata for each Zotero library is written to one bounded,
shared snapshot and reused as the user opens different papers in that library. Live
Reader state may be replaced in place, but the plugin does not create per-paper PDF,
full-text, or library-metadata copies. Stored context may refer to the original PDF by
absolute path, but nothing is written beside that PDF.

## Add-on identity

The add-on has the independent manifest ID `zotkit@oldantique.github.io`. It does not
retain or upgrade the earlier local ZoteroChat identity. If both are present, remove
or disable the old add-on to avoid duplicate Reader panes.

## Build and verification

To build and verify only the XPI from the repository root:

```bash
make plugin-install
make plugin-check
make plugin-test
make plugin-native-test
make plugin-build
```

These targets do not install, check, or package the root Python package. `make verify`
and `make package` are XPI-only entry points; Python is not part of the plugin build or
runtime.

The installable XPI embeds a universal macOS native helper. Its packaging step uses
Apple's `xcrun`, `lipo`, and `codesign`, so `make plugin-build` and `make package` must
run on macOS. Linux can run the TypeScript/frontend tests but cannot compile this
Darwin-specific helper or produce the release XPI. CI mirrors that split: Node 20
checks run on Linux, while helper tests and the final XPI build run on a macOS runner;
the resulting XPI is uploaded with its SHA-256 file.
