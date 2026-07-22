# Zotero Reader and Codex integration

zotkit has two coequal product surfaces with independent runtimes and trust boundaries:

- `zotero-plugin/` is an installable Zotero 9 XPI for interactive reading. Its default surface is a Cursor-style Research Chat backed by the locally installed Codex app-server; a real PTY Terminal is available as an advanced surface.
- The root Python package is a headless CLI/library backed by the Zotero Web API and optional WebDAV/Zotero Storage. It works without the desktop app.

Neither surface is the “primary” or “optional” form of the other. The XPI does not install, launch, or configure the Python package, and the Python package is not part of the XPI build. They share the Zotkit name and research-library domain while serving different environments.

## Reader-to-Research-Chat flow

```text
Zotero Reader
  ├── active attachment and parent-item metadata
  ├── original PDF path and containing directory
  ├── visible page and latest selected text
  ├── annotations and bounded PDF text access
  └── user-attached selection/annotation/library context
          │
          ▼
right-sidebar Research Chat
  ├── fixed composer, model + reasoning controls
  ├── per-paper threads and history
  ├── streamed Markdown + LaTeX
  ├── Plan / Tool / command / approval cards
  └── Diff / Apply / Checkpoint cards
          │ authenticated local pipe (JSONL)
          ▼
locally installed `codex app-server`
  ├── Ask: read-only, no network, no approval escalation
  └── Agent: workspace-write only in Zotkit private staging
          │
          ├── live read-only Reader tools
          ├── live read-only Reader tools
          └── zotero_propose_changes (proposal only)
```

The helper and app-server start lazily when the user opens Research Chat. Codex login remains owned by the installed Codex CLI; the sidebar uses app-server account methods so the user can sign in/out without Zotkit copying a token file. Models, supported reasoning efforts, thread state, streamed items, plan updates, tool calls, command approvals, and diffs come from the app-server protocol.

`codex app-server` is experimental. Zotkit treats connection/protocol failures as a visible recoverable state and offers the advanced Terminal fallback.

The current paper context is refreshed when the Reader tab, page, or selection changes. The user can also attach explicit `@` context such as the current page, selection, annotations, or configured PDF library. Context from the PDF is untrusted input and never counts as an approval.

## Cursor-compatible interaction

The default pane keeps the composer visible at narrow Zotero widths and separates research progress into cards rather than displaying raw terminal control sequences. On macOS the Reader handlers mirror Cursor's chat shortcuts:

- `⌘I`: open/focus Research Chat;
- `⌘L`: attach the current selection to a new chat (or open Chat when no selection exists);
- `⌘⇧L`: attach the current selection to the current chat;
- `⌘⇧J`: open/focus the advanced Terminal.

Selection text is captured as bounded plain text and normalized before it enters a prompt. It is not auto-submitted from the advanced Terminal insertion flow and cannot synthesize an Apply click.

## Ask and Agent policies

Ask mode is the default. It uses a read-only sandbox, disables network access, sets `approvalPolicy: never`, and exposes only read-only research tools. A request that needs a write must be restarted in Agent mode; Ask does not offer an approval route that silently upgrades the same turn.

Agent mode uses `workspace-write` with Zotkit's private per-paper workspace as its writable root and keeps network access disabled. The original PDF path and directory remain available as Reader context, but the original directory is not a writable sandbox root. Command/file approval requests are surfaced to the user only when they remain inside the private staging boundary; requests outside it are rejected.

Private-workspace changes and app-server turn diffs are useful for drafting or producing a staged PDF. They do not themselves modify Zotero or the source PDF. Conversation checkpoints can fork a thread before a previous turn, but cannot restore files.

## Diff, Apply, and mutation checkpoints

Zotero and source-PDF changes use a separate capability provided only in Agent mode:

```text
zotero_propose_changes(arguments)
        │ validate active paper, paths, collections, and operation shape
        ▼
pending Diff card (no mutation yet)
        ├── Reject → no write
        └── Apply
              │ revalidate the active identity and reviewed snapshot
              │ create a mutation checkpoint
              ▼
        Zotero API / atomic PDF replacement
```

The tool supports a small allowlist: selected bibliographic fields, exact membership in existing same-library collections, relinking a linked-file attachment to a validated PDF, and replacing the active PDF from a validated staged PDF. It does not create collections, edit the Zotero database directly, mutate stored-attachment paths, or accept arbitrary file writes.

Apply is a UI action, not a tool argument, so the model and PDF content cannot approve a proposal. If the current paper or relevant snapshot changes after the Diff was prepared, Apply fails and the model must prepare a new proposal. If a write throws, Zotkit attempts to restore the just-created checkpoint.

Mutation checkpoints record the relevant metadata, collection membership, and attachment state. PDF replacement additionally stores the original bytes. Retention is bounded to 20 checkpoints, about 1 GiB of PDF backups in total, and 512 MiB for an individual PDF. Restore creates an undo checkpoint before reverting. This is a focused recovery aid, not a full-library backup system.

## Read-only research tools

Research Chat receives structured dynamic tools directly through app-server. They cover:

- the atomic current Reader context;
- current page and latest selection;
- bounded search and page reads for the active PDF;
- search/read access to another PDF only after it is validated against the configured library root and uniquely matched to a Zotero attachment;
- annotations for the active PDF;
- active-item metadata and validated PDF-path discovery in the configured library.

Research Chat and the advanced Terminal share four discovery tools from the XPI-bundled Zotkit query layer:

- `zotkit_find_items`
- `zotkit_get_item`
- `zotkit_list_collections`
- `zotkit_list_tags`

The XPI starts its own bundled local query implementation. It does not search for an external `zotkit` executable, Python runtime, `.env`, Zotero Web API key, or WebDAV credentials. For the advanced Terminal, the same bundled implementation is also available as the read-only `zotkit find`, `get`, `collections`, and `tags` commands.

Page/selection snapshots are bounded and maintained in the plugin profile. Full text normally references Zotero's existing `.zotero-ft-cache` in place. If no index is usable, an explicit full-text operation may create one bounded text fallback in an automatically pruned private workspace. Browsing papers does not create PDF copies; an original PDF is copied only when an approved PDF replacement requires a mutation checkpoint.

## Advanced PTY Terminal

The Terminal is intentionally separate from structured Research Chat:

```text
Zotero Reader
  └── xterm.js
       │ authenticated local Unix-socket helper
       ▼
     real PTY → codex / claude
       ├── cwd = directory containing the active PDF
       ├── live Reader MCP
       └── bundled read-only Zotkit CLI/MCP
```

Codex starts with `--no-alt-screen --sandbox read-only --ask-for-approval untrusted`; Claude Code starts with `--permission-mode plan`. The Codex TUI can ask the user to approve escalation, and Claude plan mode is not an OS sandbox. Therefore an action explicitly approved inside the advanced Terminal can write outside Zotkit's Research Chat staging area and does not receive a Research Chat Diff or checkpoint. The Terminal is for users who intentionally want the full CLI; reviewed Zotero/PDF edits should use structured Agent mode.

## Credentials and local state

Small context, shared library snapshots, thread/session records, staging files, and checkpoints live below `<Zotero Profile>/zotkit/`. The profile tree uses restrictive permissions where supported and is automatically pruned according to resource-specific bounds. Zotkit does not place `AGENTS.md`, indexes, prompts, generated notes, or other helper files beside the source PDF.

The local helper uses a private Unix-domain socket for PTY sessions and a pipe for app-server. It applies peer, secret, permission, descriptor, and child-cleanup defenses described in [`zotero-plugin/SECURITY.md`](../zotero-plugin/SECURITY.md). Those controls are defense in depth, not a claim that a user-approved local agent is fully isolated from the user's account.

## Add-on identity

The add-on ID is `zotkit@oldantique.github.io`. It does not retain or upgrade the earlier local ZoteroChat identity. Remove or disable the old add-on if both are installed, otherwise duplicate Reader panes can appear.

## Build and verification

To build and verify only the XPI from the repository root:

```bash
make plugin-install
make plugin-check
make plugin-test
make plugin-native-test
make plugin-build
```

These targets do not install, check, or package the coequal root Python surface. `make verify` and `make package` are XPI-only entry points; Python is not part of the plugin build or runtime.

The XPI embeds a universal macOS native helper. Packaging uses Apple's `xcrun`, `lipo`, and `codesign`, so release XPI builds must run on macOS. Linux can run TypeScript/frontend checks but cannot compile the Darwin helper. CI mirrors that split: Node checks run on Linux, while helper tests and the final signed package build run on macOS.
