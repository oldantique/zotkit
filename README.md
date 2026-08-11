# zotkit

[![PyPI](https://img.shields.io/pypi/v/zotkit)](https://pypi.org/project/zotkit/)
[![Python](https://img.shields.io/pypi/pyversions/zotkit)](https://pypi.org/project/zotkit/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Headless Zotero library management — no desktop app required.**

**English** | [简体中文](README.zh-CN.md)

"Headless" simply means zotkit never needs the Zotero app (or any window) open: it is a
Python library + CLI that talks straight to the
[Zotero Web API](https://www.zotero.org/support/dev/web_api/v3/start), so you can
search, create, tag, and organize items from any terminal — macOS, Windows, or Linux,
your laptop or a remote server. If your attachments sync to a **personal WebDAV
server**, zotkit can **upload and download the files themselves** by speaking
Zotero's WebDAV storage format directly — a capability the Web API itself does not
provide. The format is documented in [docs/webdav-format.md](docs/webdav-format.md).

Built for servers, scripts, and **LLM agents**: bulk writes are dry-run by default,
batched, and version-checked, and you can define a tag taxonomy that is *enforced in
code* so an agent (or a tired human) can't pollute your library with inconsistent tags.

## Why zotkit

| | Desktop app | Other CLI/MCP tools | zotkit |
|---|---|---|---|
| Works headless (server, SSH, CI) | ❌ | ✅ read-mostly | ✅ |
| Write items/tags/collections | ✅ | ⚠️ usually needs the desktop app running | ✅ |
| Attachment files (Zotero Storage) | ✅ | ⚠️ some | ✅ upload + download |
| Attachment files on **WebDAV** | ✅ | ⚠️ download at best | ✅ **upload + download** |
| Tag conventions enforced in code | ❌ | ❌ | ✅ optional `conventions.toml` |

## The zotkit family

Two independent, complementary projects — use either on its own, or both together:

| | What it is |
|---|---|
| **zotkit** (this repo) | Headless Python CLI + library. Runs anywhere, needs no Zotero app. |
| **[zotkit-reader](https://github.com/oldantique/zotkit-reader)** | A Zotero Reader sidebar that embeds a Codex/Claude agent beside the PDF you're reading. Maintained by [@ChanceSiyuan](https://github.com/ChanceSiyuan). |

They share a name and a philosophy, not a codebase: zotkit-reader can call zotkit over MCP
for library-wide operations, but neither requires the other to be installed.

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

## Quickstart

```bash
zotkit find --title "boson sampling"        # search by title/tag/collection
zotkit find --tag status:to-read
zotkit find --any vaswani                   # metadata-wide: title, abstract,
                                            #   creators, tags, extra ("All
                                            #   Fields & Tags"); --abstract
                                            #   for the abstract field only
zotkit show AB12CD34 EF56GH78               # one line per key (read-only);
                                            #   --json for the full item data

zotkit create --arxiv 2401.12345            # fetch arXiv metadata, dry-run preview
zotkit create --arxiv 2401.12345 --apply --tags field:ai   # create + download & attach the PDF
zotkit create --arxiv 2401.12345 1706.03762 math/0211159 --apply   # batch: one metadata
                                            #   request, PDFs politely spaced ≥3 s apart
zotkit create --doi 10.1038/nature14539     # fetch CrossRef metadata by DOI (no PDF —
                                            #   usually paywalled; attach manually after)

zotkit create --file papers.json            # batch from JSON: dry-run preview —
                                            #   flags items already in the library
zotkit create --file papers.json --apply    # create (dedups by DOI/title)
zotkit attach --from papers.created.json --all   # upload the PDFs (WebDAV or Zotero
                                                 #   Storage — auto-detected from .env)

zotkit enrich --key AB12CD34 EF56GH78       # fill missing fields on existing items
                                            #   in place (dry-run; --apply to write)
zotkit enrich --missing abstract --apply    # …or batch: every item missing an
                                            #   abstract (also --missing doi, --all)
zotkit audit                                # read-only health report: what's missing
                                            #   where, stamp hygiene (--json for agents)
zotkit abstract --key AB12CD34 --source cnki --file abs.txt   # paste an abstract
                                            #   with provenance (owner's tool)

zotkit attach --key AB12CD34 --pdf paper.pdf     # single attach
zotkit fetch --key AB12CD34 --out downloads      # download attachments (same auto-detection)

zotkit export --key AB12CD34 EF56GH78 -o refs.bib   # BibTeX; cite key = item key

zotkit tag AB12CD34 topic:qaoa prio:high    # validated against conventions.toml
zotkit status AB12CD34 read                 # replaces the status: tag
zotkit move AB12CD34 "Algorithms"           # or "Parent :: Child"; --add keeps old home

zotkit backup                               # full JSON snapshot -> backups/
zotkit lint field:physics topic:new-idea    # offline tag check
```

`--arxiv` takes ids or abs/pdf URLs (several, space- or comma-separated) and maps
the full record (all authors, abstract, date, DOI); `--doi` maps CrossRef records
(journal articles, conference papers, books, chapters, …) and refuses to guess on
CrossRef types it doesn't know. Both accept `--collection` and `--tags`, and
`--no-pdf` skips the arXiv PDFs. Rate limiting is built into the request layer —
batches use one arXiv metadata request and space PDF downloads per arXiv's terms
of use, so callers (humans or agents) never pace themselves. A bad id fails
alone, not the batch; the exit code is non-zero only if something failed.
Fetching metadata from arbitrary web pages is out of scope (zotkit stays a
daemon-free CLI — no translation-server). CrossRef requests identify themselves
to the polite pool with a contact address; that should be reachable, so if you
distribute a tool built on zotkit, set your own via `ZOTKIT_MAILTO`.

**Duplicates**: before creating, check existence with
`zotkit find --any <first-author-lastname>` — one call across title, abstract,
creators, tags, and extra beats guessing at title wording (title-substring
searches routinely take several attempts before a zero-hit answer can be
trusted). Then: `create` checks every candidate against the library by exact DOI and
by normalized title, and skips the ones already there — that has always been the
`--apply` behavior, and the dry run now runs the same check up front, printing
`!! already in library as <KEY> — --apply will skip it (use --no-dedup to force)`
so you see the collision before writing anything. The apply path names the existing
item's key in its skip messages too. `--no-dedup` turns the check off and creates
the item regardless.

**Version of record**: when arXiv reports a *journal* DOI (the paper was formally
published), `--arxiv` builds the journal record from CrossRef instead of a
`preprint`: proper item
type, venue, volume/pages, formal date. The arXiv identity is kept — `arXiv: <id>`
goes in Extra, the `url` stays the open-access abs page (the journal link lives in
the DOI field), the arXiv abstract fills in when CrossRef has none, and the PDF
still comes from arXiv. If the CrossRef lookup fails, the item falls back to the
preprint record with a warning rather than failing. A *repository* DOI is never
mistaken for a journal one: DOIs under the preprint servers' own prefixes
(arXiv `10.48550`, SSRN `10.2139`, bioRxiv/medRxiv `10.1101`, Research Square,
OSF, ChemRxiv, TechRxiv, Preprints.org) don't trigger the upgrade, and neither
does a CrossRef record that turns out to be a repository posting in disguise
(SSRN registers working papers as articles in a fake "SSRN Electronic
Journal") — those stay preprints, with the reason stated. The same predicate
gates `enrich --rebuild-record`. Items whose abstract zotkit
wrote also carry an `abstract-source: arxiv|crossref` line in Extra, naming where
it actually came from.

### Looking items up: `find`, `show` and `export`

`zotkit find --any TEXT` matches a case-insensitive substring across title,
abstract, creator names, tags, and extra — the Zotero client's "All Fields &
Tags" mode — and composes (AND) with `--title`/`--tag`/`--collection`.
`--abstract TEXT` is the same match restricted to the abstract, for when
`--any` hits too much via creators or extra. When a match isn't visible in the
one-line result (abstract, extra, or a creator name), an indented
`hit: <field> "..."` line names the field, with ~±60 chars of context for
abstract/extra — so you never have to `show --json` a result just to learn why
it matched. Deliberate non-goals: no PDF full-text search (once you need the
full text you've already identified the paper — fetch it, don't search it) and
no server-side `q=` search (its index coverage is unreliable — measured on
this library it returned 26 hits where 37 abstract-level matches exist — and a
zero-hit `find` answer is used to conclude "not in the library", so
completeness is a hard requirement; `find` stays a local filter over the full
library).

`zotkit show K [K …]` is the read-only lookup by item key: one line per key —
`KEY · itemType · FirstAuthor Year · Title · DOI-or-arXiv-id` — or `--json` for the
full item data. An unknown key is reported on stderr as a single sanitized line
(`error: KEY: not found (404)` — no request URL, so nothing private lands in CI
logs; `--verbose` restores the full API exception) and the exit code is 1, while
the remaining keys still print. This deliberately supersedes requests for a
`find --key` flag and a `verify --manifest` subcommand: verifying a manifest is a
loop over `show` on the project side, and manifest-file parsing is too
project-specific to belong in zotkit.

`zotkit export --key K [K …]` emits BibTeX for those items, to stdout or to `-o
refs.bib`; keys are also accepted on stdin, one per line, so it composes with
whatever produced them. Every entry's cite key is **always** rewritten to the
Zotero item key — that is the point of the command: item keys are the identity in
the manifest model, and author-year cite keys don't join against them. An unknown
key errors on stderr (exit 1) without stopping the other entries from exporting.
The output starts with a fixed provenance comment (`% Generated by zotkit <version>
-- do not hand-edit. …`) so a regenerated file is never mistaken for a hand-kept
one. Entries come raw off the Zotero Web API, preserving Zotero's field order, tab
indentation, and `month = jan` abbreviations — so the first textual diff against a
file that went through bibtexparser (or any other reflowing tool) is large even
when the entries are semantically identical. That's expected, not a bug.

`zotkit fetch` still defaults to `./downloads` and prints the absolute path of every
file it saves. If you omit `--out` while the current directory sits inside a git
repository, it warns on stderr and suggests an explicit destination: loose PDF
copies committed into a repo break a library-of-record setup, where the library is
the one place a file lives.

### Enriching existing items

`zotkit enrich --key K [K …]` completes incomplete items — missing abstracts,
DOIs, truncated author lists — from the same arXiv/CrossRef sources, **in
place**. The item key never changes (keys are the stable handle downstream
tooling references; delete-and-recreate is not an option), and writes carry the
item version, so a concurrent edit fails that item loudly instead of clobbering.

The merge is deliberately conservative: only empty fields are filled; creators
are extended only when the current list is a same-order prefix of the
authoritative one (the classic truncated-list case — any other difference is
reported, not touched); tags, collections, relations, and attachments are never
modified; Extra only gains lines. Abstracts zotkit writes are stamped
`abstract-source: …` in Extra — a stamp with no abstract means someone
deliberately removed it, and enrich will not re-add it (reported as NEEDS
OWNER). Items with no DOI or arXiv id are reported as needs-identifier.

`--rebuild-record` additionally upgrades a preprint whose paper has since been
published (journal DOI present) to the journal record **in the same item**:
itemType, published title/date/venue/volume/pages — with `arXiv: <id>` appended
to Extra and attachments untouched.

Instead of `--key`, `--all` runs over every top-level scholarly item and
`--missing abstract` / `--missing doi` (repeatable) over just the gaps —
batching and arXiv/CrossRef rate limiting stay internal, so no pacing or
batch-splitting on the caller's side. **`zotkit audit`** is the read-only
companion: counts and key lists for missing abstracts, missing DOI/arXiv id,
missing PDF attachments, and `abstract-source` stamp hygiene (`--json` for
agents).

For text enrich *can't* fetch — CNKI, publisher pages, your own summary —
**`zotkit abstract --key K --source <slug>`** stores a pasted abstract
(stdin or `--file`) with provenance: the text is cleaned (hidden tags,
`&nbsp;`, soft hyphens, hard-wrapped lines) and an `abstract-source: <slug>`
line records where it came from (`cnki`, `ssrn`, `publisher`, `manual` = your
own words — any lowercase slug). It is the owner's tool, so unlike enrich it
may *replace* an existing abstract — but only with `--force`, which also
rewrites the stamp line in place; all other Extra lines stay untouched.

Item JSON for `zotkit create --file` (a list, one object per reference):

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
z.attach("AB12CD34", "paper.pdf")           # PDF -> WebDAV / Zotero Storage
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
taxonomy.

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

(With Zotero Storage, zotkit simply uses the Web API's official file endpoints — this
section is about the WebDAV mode.) Zotero's WebDAV storage format is undocumented but
simple: each attachment item `K` is stored as `K.zip` (the file, zipped) plus `K.prop`
(its md5 + mtime). zotkit creates the attachment item via the Web API and PUTs both
objects directly — after which every desktop client syncs the file down normally.
Details in [`docs/webdav-format.md`](docs/webdav-format.md).

The format was determined by interoperability inspection of the author's own library.
This project is not affiliated with or endorsed by Zotero.

## Limits & roadmap

- `find` lists the library client-side — instant for hundreds of items, sluggish
  for many thousands. That's by design, not debt: server-side `q=` search has
  unreliable index coverage, and `find`'s zero-hit answers must be trustworthy.
- Group libraries should work for item operations (untested); WebDAV file sync is
  personal-libraries-only (a Zotero limitation).
- `--doi`/`--arxiv` import covers arXiv + CrossRef; DataCite-only DOIs and
  arbitrary-URL scraping (translation-server territory) are out of scope.
- Planned: an MCP server wrapper.

## License

[MIT](LICENSE). If you build on the WebDAV implementation, a link back is appreciated.
