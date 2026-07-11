# zotkit

**Headless Zotero library management — no desktop app required.**

"Headless" simply means zotkit never needs the Zotero app (or any window) open: it is a
Python library + CLI that talks straight to the
[Zotero Web API](https://www.zotero.org/support/dev/web_api/v3/start), so you can
search, create, tag, and organize items from any terminal — macOS, Windows, or Linux,
your laptop or a remote server. Uniquely, if your attachments sync to a **personal
WebDAV server**, zotkit can **upload and download the files themselves** by speaking
Zotero's WebDAV storage format directly — the one capability the Web API does not
provide, and (as far as we know) not offered by any other headless tool.

Built for servers, scripts, and **LLM agents**: every write is dry-run by default,
batched, and version-checked, and you can define a tag taxonomy that is *enforced in
code* so an agent (or a tired human) can't pollute your library with inconsistent tags.

## Why zotkit

| | Desktop app | Other CLI/MCP tools | zotkit |
|---|---|---|---|
| Works headless (server, SSH, CI) | ❌ | ✅ read-mostly | ✅ |
| Write items/tags/collections | ✅ | ⚠️ usually needs the desktop app running | ✅ |
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
- **Using Zotero Storage instead of WebDAV?** Leave the `WEBDAV_*` lines out — every
  feature works except `attach`/`fetch` (the file bytes). Zotero-Storage upload/download
  is on the roadmap (the Web API supports it).

Optionally, copy [`conventions.example.toml`](conventions.example.toml) to
`conventions.toml` next to your `.env` to define a namespaced tag taxonomy
(`field:physics`, `status:to-read`, …). With it in place, `zotkit create` / `zotkit tag`
**reject** violations; without it, tags are unrestricted.

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

## Using zotkit with AI agents

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

## Safety model

- `create` is **dry-run by default**; `--apply` to execute.
- Writes go through fetch→modify→update (carries the item version, so concurrent edits
  fail loudly with 412 instead of clobbering), in batches of ≤ 50.
- `zotkit backup` snapshots every item, collection, tag, and membership to one JSON
  file — run it before bulk operations.
- Remember: writes propagate to zotero.org and **all your synced devices**.

## How WebDAV attachments work

Zotero's WebDAV storage format is undocumented but simple: each attachment item `K` is
stored as `K.zip` (the file, zipped) plus `K.prop` (its md5 + mtime). zotkit creates the
attachment item via the Web API and PUTs both objects directly — after which every
desktop client syncs the file down normally. Details in
[`docs/webdav-format.md`](docs/webdav-format.md).

The format was determined by interoperability inspection of the author's own library.
This project is not affiliated with or endorsed by Zotero.

## License

[MIT](LICENSE). If you build on the WebDAV implementation, a link back is appreciated.
