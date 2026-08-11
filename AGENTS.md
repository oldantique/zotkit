# Instructions for AI agents

You (an AI agent) were likely given this repo because your user wants you to manage
their Zotero library with **zotkit**. Here is exactly how to proceed.
(Developing zotkit itself instead? Read [CLAUDE.md](CLAUDE.md), not this file.)

## 1. Install

```bash
pipx install zotkit    # or: uv tool install zotkit / pip install zotkit
```

Requires Python 3.11+. Works on macOS, Windows, Linux — no Zotero desktop app needed.

## 2. Configure (interactive — involve the user)

Create the credentials file from [.env.example](.env.example) at `./.env`,
`~/.config/zotkit/env`, or `$ZOTKIT_ENV`:

- Ask the user to create an API key (with write access) at
  <https://www.zotero.org/settings/keys> and tell you the key + the numeric userID
  shown on that page.
- If they sync attachment files via WebDAV, ask them to open the Zotero desktop app →
  **Settings → Sync → File Syncing** and read you the WebDAV URL/username/password;
  append `/zotero/` to the URL. (If they use Zotero Storage, skip the `WEBDAV_*` lines
  entirely — `attach`/`fetch` automatically use Zotero Storage instead.)
- **Never print, cat, echo, or commit the .env or any credential.**

After writing the .env, run `zotkit doctor` — it validates config, API access, and
attachment storage, and says what to fix. Don't proceed until it prints "all good".

Optionally set up tag conventions from
[conventions.example.toml](conventions.example.toml) — do this WITH the user; read
[docs/organizing-with-agents.md](docs/organizing-with-agents.md) first for the design
principles (shallow single-axis collections, namespaced facet tags).

If the user asks you to **clean up or reorganize their library** — whether it's a mess
or already organized — [docs/organizing-with-agents.md](docs/organizing-with-agents.md)
is the complete playbook: design principles, the backup → read-only proposals → reviewed
serial writes loop, and the audit checklist for second passes.

## 3. Operate

Full task recipes live in [skills/zotkit/SKILL.md](skills/zotkit/SKILL.md) — if your
harness supports skills, install it (`cp -r skills/zotkit ~/.claude/skills/`); otherwise
just read it. Quick reference:

```bash
zotkit find --title "..." | --tag ns:value | --collection "Name"
zotkit find --any TEXT [--abstract TEXT]  # metadata-wide (title+abstract+creators+
                                     #   tags+extra); filters AND together. Non-
                                     #   visible matches get a `hit: field "..."` line.
                                     #   Existence check before create: --any <lastname>
zotkit show KEY [KEY...] [--json]    # read-only lookup by key, one line each;
                                     #   unknown key -> one stderr line + exit 1
                                     #   (--verbose for the full API exception)
zotkit create --arxiv <id|url> ...   # fetch arXiv metadata; --apply attaches PDFs too
zotkit create --doi <doi> ...        # fetch CrossRef metadata (no PDF; attach manually)
zotkit create --file x.json          # batch from JSON
                                     # all three: dry-run; add --apply to execute
                                     # dedup (DOI/title) is the default: the dry run
                                     #   prints "already in library as <KEY>" for
                                     #   items --apply would skip; --no-dedup forces
zotkit enrich --key K [K...]         # complete EXISTING items in place — never
                                     #   delete+recreate (item keys must stay stable)
zotkit enrich --missing abstract|doi | --all   # batch enrich (rate limiting internal)
zotkit audit [--json]                # read-only library health report
zotkit abstract --key K --source SLUG   # store an OWNER-PROVIDED abstract with
                                     #   provenance; --force only on owner's say-so
zotkit attach --from x.created.json --all
zotkit fetch --key KEY --out downloads   # prefer an explicit --out OUTSIDE any git
                                     #   repo (default ./downloads; it warns in a repo)
zotkit export --key K [K...] [-o refs.bib]   # BibTeX; cite key = Zotero item key
zotkit tag KEY topic:foo | zotkit status KEY read | zotkit move KEY "Collection"
zotkit backup | zotkit lint tag...
```

## Safety rules (non-negotiable)

1. **`zotkit backup` before any bulk write.** Writes sync to zotero.org and ALL the
   user's devices.
2. `create` is dry-run by default — show the user the dry output before `--apply`.
3. Reuse the user's existing tags/collections (see `zotkit find` output) instead of
   inventing new ones; if conventions.toml exists, violations are rejected in code.
4. If a paper/metadata source is paywalled or bot-walled, stop and ask the user —
   never try to bypass it.
