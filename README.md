# zotkit

[![PyPI](https://img.shields.io/pypi/v/zotkit)](https://pypi.org/project/zotkit/)
[![Python](https://img.shields.io/pypi/pyversions/zotkit)](https://pypi.org/project/zotkit/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**English** | [简体中文](README.zh-CN.md)

zotkit ships two coequal components with deliberately different runtimes and trust
boundaries. They share a repository and product name, but neither depends on the other.

## Reader plugin (Zotero 9 on macOS)

Install the XPI from [`zotero-plugin/`](zotero-plugin/README.md) to add a
Cursor-style **Research Chat** to Zotero 9's PDF Reader. It drives the locally
installed Codex through `codex app-server`, reuses the Codex CLI login, and exposes
model/reasoning controls, per-paper history, Plan and Tool cards, streamed Markdown,
and LaTeX rendering. The current paper metadata, PDF path and containing directory,
page, selection, and other explicitly attached research context travel with each
question. A real PTY-backed Codex/Claude terminal remains available as an advanced
surface rather than the default interface.

Research Chat starts in **Ask** mode, which is read-only. **Agent** mode may work only
inside Zotkit's private staging workspace. A model cannot directly write to the
original PDF directory or silently change Zotero. Metadata, existing-collection
membership, linked-attachment paths, and PDF replacement use the dedicated
`zotero_propose_changes` tool: it creates a visible Diff, waits for the user's
**Apply** click, and creates a bounded restorable checkpoint immediately before the
write.

The XPI also embeds the read-only `zotkit` query layer shared by Research Chat and the advanced Terminal
agent (`find`, `get`, `collections`, `tags`), so plugin users need no Python package,
Zotero Web API key, `.env`, or separately installed Zotkit command.

Build it with `make bootstrap && make package`, then install
`zotero-plugin/dist/Zotkit-<version>.xpi` from Zotero's Add-ons manager. Research Chat
requires the local `codex` CLI; the advanced Claude Code Terminal additionally requires
`claude`.

## Headless Python package (macOS, Windows, and Linux)

**Headless Zotero library management — no desktop app required.**

"Headless" simply means zotkit never needs the Zotero app (or any window) open: it is a
Python library + CLI that talks straight to the
[Zotero Web API](https://www.zotero.org/support/dev/web_api/v3/start), so you can
search, create, tag, and organize items from any terminal — macOS, Windows, or Linux,
your laptop or a remote server. If your attachments sync to a **personal WebDAV
server**, zotkit can **upload and download the files themselves** by speaking
Zotero's WebDAV storage format directly — a capability the Web API itself does not
provide. The format is documented in [docs/webdav-format.md](docs/webdav-format.md).

Built for servers, scripts, and **LLM agents**: every write is dry-run by default,
batched, and version-checked, and you can define a tag taxonomy that is *enforced in
code* so an agent (or a tired human) can't pollute your library with inconsistent tags.

## Why the headless CLI

| | Desktop app | Other CLI/MCP tools | Headless zotkit CLI |
|---|---|---|---|
| Works headless (server, SSH, CI) | ❌ | ✅ read-mostly | ✅ |
| Write items/tags/collections | ✅ | ⚠️ usually needs the desktop app running | ✅ |
| Attachment files (Zotero Storage) | ✅ | ⚠️ some | ✅ upload + download |
| Attachment files on **WebDAV** | ✅ | ⚠️ download at best | ✅ **upload + download** |
| Tag conventions enforced in code | ❌ | ❌ | ✅ optional `conventions.toml` |

## Install

Pure Python (3.11+), no platform-specific bits — the same package works on macOS,
Windows, and Linux:

```bash
pipx install zotkit        # or: uv tool install zotkit / pip install zotkit
uvx zotkit --help          # …or try it without installing anything
```

## Configure

Copy [`.env.example`](.env.example) to `./.env`, `~/.config/zotkit/env`, or any path in
`$ZOTKIT_ENV`, and fill in:

- **Zotero Web API**: create a key (with write access) at
  <https://www.zotero.org/settings/keys> — your numeric `ZOTERO_LIBRARY_ID` is shown on
  the same page.
- **WebDAV** (only for `attach`/`fetch`): copy the exact values from the Zotero desktop
  app on any of your machines — **Settings → Sync → File Syncing** — and append
  `/zotero/` to the URL (the desktop does this implicitly).
- **Using Zotero Storage instead of WebDAV?** Just leave the `WEBDAV_*` lines out —
  `attach`/`fetch` automatically use Zotero Storage through the Web API's upload/download
  endpoints instead. The storage mode is detected from your `.env`, nothing to configure.

After filling it in, run **`zotkit doctor`** — it validates the config file, API
access, and attachment storage, and tells you exactly what to fix if anything fails.

Optionally, copy [`conventions.example.toml`](conventions.example.toml) to
`conventions.toml` next to your `.env` to define a namespaced tag taxonomy
(`field:physics`, `status:to-read`, …). With it in place, `zotkit create` / `zotkit tag`
**reject** violations; without it, tags are unrestricted.

## Zotero Reader plugin (macOS)

The installable Zotero 9 add-on in [`zotero-plugin/`](zotero-plugin/README.md) is the
desktop Reader surface of zotkit; the headless Python package and the XPI are coequal
entry points with independent runtimes. Research Chat is the default XPI experience.
It connects to the local Codex app-server and supplies current-paper metadata, the
original PDF path and directory, the bounded current-page snapshot, the latest
bounded selection, and user-attached library context.

To build and install it on macOS:

```bash
make plugin-install
make plugin-build
```

Then open Zotero **Tools → Add-ons**, choose **Install Add-on From File…**, and select
`zotero-plugin/dist/Zotkit-<version>.xpi`. Open a PDF and expand **Zotkit Research
Chat**. The helper and app-server start lazily. The XPI already embeds the read-only
Zotkit metadata query layer used by Research Chat and the advanced Terminal: plugin users do **not** need Python,
`pipx`, a Zotero Web API key, `~/.config/zotkit/env`, or another Zotkit installation.

Ask mode uses a read-only sandbox and never offers write approvals. Agent mode can
stage edits in Zotkit's private workspace and shows command/tool approvals in the
sidebar. Changes to Zotero metadata, collection membership, a linked attachment path,
or the active PDF are a separate reviewed workflow: Codex calls
`zotero_propose_changes`, Zotkit validates the target and renders a Diff, and nothing
changes until the user clicks **Apply**. Zotkit then records a bounded checkpoint;
**Restore** can revert that applied change. The original PDF directory is context, not
an Agent writable root.

The advanced terminal starts Codex with
`--sandbox read-only --ask-for-approval untrusted`, so a user can still approve an
escalation inside the real TUI; Claude Code's `--permission-mode plan` is a CLI policy,
not an OS sandbox. The bundled Zotkit metadata MCP remains discovery-only. Metadata is
reused from one shared snapshot per Zotero library rather than duplicated per paper.
The add-on ID is `zotkit@oldantique.github.io`. See the
[`zotero-plugin` guide](zotero-plugin/README.md) and the
[integration/security boundary](docs/zotero-plugin-integration.md) for details.

## Quickstart

```bash
zotkit find --title "boson sampling"        # search by title/tag/collection
zotkit find --tag status:to-read

zotkit create --file papers.json            # dry-run: shows what would be created
zotkit create --file papers.json --apply    # create (dedups by DOI/title)
zotkit attach --from papers.created.json --all   # upload the PDFs to WebDAV

zotkit attach --key AB12CD34 --pdf paper.pdf     # single attach
zotkit fetch --key AB12CD34 --out downloads      # download attachment from WebDAV

zotkit tag AB12CD34 topic:qaoa prio:high    # validated against conventions.toml
zotkit status AB12CD34 read                 # replaces the status: tag
zotkit move AB12CD34 "Algorithms"           # or "Parent :: Child"; --add keeps old home

zotkit backup                               # full JSON snapshot -> backups/
zotkit lint field:physics topic:new-idea    # offline tag check
```

Item JSON for `zotkit create` (a list, one object per reference):

```json
[{"itemType": "journalArticle", "title": "…",
  "creators": [{"creatorType": "author", "firstName": "A", "lastName": "B"}],
  "date": "2024", "publicationTitle": "…", "DOI": "10.x/y",
  "tags": ["field:physics", "status:to-read"],
  "collection": "Algorithms", "file_path": "/abs/path/paper.pdf"}]
```

## From Python

```python
from zotkit import Zot

z = Zot()                                   # reads .env automatically
z.find(tag="status:to-read")
z.create_items([...])                       # dedup + convention checks
z.attach("AB12CD34", "paper.pdf")           # PDF -> WebDAV
z.fetch("AB12CD34", "downloads")
z.set_status("AB12CD34", "read")
z.backup()
```

`z.z` is the underlying [pyzotero](https://github.com/urschrei/pyzotero) client for
anything not wrapped.

## Using the headless CLI with AI agents

zotkit is designed to be driven by coding agents (Claude Code and similar): dry-run
defaults, code-enforced tag conventions, and a ready-made **Claude Code skill** in
[`skills/zotkit/`](skills/zotkit/SKILL.md) — copy it to `~/.claude/skills/zotkit/` and
any Claude session can search, file, and attach papers for you while respecting your
taxonomy. (An MCP server is planned.)

Want to clean up a messy library, not just maintain one? The battle-tested method —
taxonomy design, parallel read-only analysis, serial reviewed writes — is written up in
[`docs/organizing-with-agents.md`](docs/organizing-with-agents.md).

```bash
mkdir -p ~/.claude/skills && cp -r skills/zotkit ~/.claude/skills/
```

## Headless CLI safety model

- `create` is **dry-run by default**; `--apply` to execute.
- Writes go through fetch→modify→update (carries the item version, so concurrent edits
  fail loudly with 412 instead of clobbering), in batches of ≤ 50.
- `zotkit backup` snapshots every item, collection, tag, and membership to one JSON
  file — run it before bulk operations.
- Remember: writes propagate to zotero.org and **all your synced devices**.

## How WebDAV attachments work

(With Zotero Storage, zotkit simply uses the Web API's official file endpoints — this
section is about the WebDAV mode.) Zotero's WebDAV storage format is undocumented but
simple: each attachment item `K` is stored as `K.zip` (the file, zipped) plus `K.prop`
(its md5 + mtime). zotkit creates the attachment item via the Web API and PUTs both
objects directly — after which every desktop client syncs the file down normally.
Details in [`docs/webdav-format.md`](docs/webdav-format.md).

The format was determined by interoperability inspection of the author's own library.
This project is not affiliated with or endorsed by Zotero.

## Limits & roadmap

- `find` currently lists the library client-side — instant for hundreds of items,
  sluggish for many thousands. Server-side search is planned.
- Group libraries should work for item operations (untested); WebDAV file sync is
  personal-libraries-only (a Zotero limitation).
- Planned: an MCP server wrapper, server-side search, DOI/arXiv one-shot import.

## License

[MIT](LICENSE). If you build on the WebDAV implementation, a link back is appreciated.
