# Instructions for AI agents

This repository has two coequal, runtime-independent product surfaces:

- the Python `zotkit` CLI for headless or external-terminal Zotero Web API/WebDAV work;
- the Zotero XPI under `zotero-plugin/`, which provides Research Chat and an advanced
  local terminal inside Zotero Desktop without requiring Python or API credentials.

Use the section below when the user asks for the external CLI or remote/headless
library management. For XPI, Reader, sidebar, Codex app-server, or bundled local-query
work, operate in `zotero-plugin/` and follow its README and security boundary instead.

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
zotkit create --file x.json          # dry-run; add --apply to execute
zotkit attach --from x.created.json --all
zotkit fetch --key KEY --out downloads
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
