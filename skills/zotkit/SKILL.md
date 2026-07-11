---
name: zotkit
description: >
  Use when the user wants to add, create, upload/attach, download/fetch, search, tag,
  or organize references (papers, PDFs) in their Zotero library via the zotkit CLI —
  headless Zotero management through the Web API + WebDAV, no desktop app. Covers task
  recipes and safety rules. Requires zotkit installed and a configured .env (README).
---

# Managing a Zotero library with zotkit

The `zotkit` CLI manages the user's Zotero library headless via the Zotero Web API;
attachment files go directly to the user's WebDAV server. Credentials load from an
`.env` (`./.env`, `~/.config/zotkit/env`, or `$ZOTKIT_ENV`) — **never cat/echo/print
the .env, the API key, or the WebDAV password.**

## Golden rules (writes)

1. **`zotkit backup` before any bulk write** (many items). Single-item ops don't need it.
2. `zotkit create` is **dry-run by default**; inspect the output, then add `--apply`.
3. Writes sync to zotero.org and all the user's devices — after a big change, tell the
   user to sync and spot-check on one client.
4. If a `conventions.toml` is configured, tag rules are **enforced in code** —
   `zotkit create`/`zotkit tag` reject violations. Check candidates offline with
   `zotkit lint <tag>…`, and **reuse existing tags** (visible in `zotkit find` output)
   instead of coining near-synonyms.

## Recipes

```bash
# search
zotkit find --title "boson sampling"
zotkit find --tag status:to-read
zotkit find --collection "Algorithms"

# create items (JSON list; dry-run first, then --apply; saves x.created.json)
zotkit create --file x.json
zotkit create --file x.json --apply

# upload / attach PDFs (WebDAV or Zotero Storage — auto-detected from .env)
zotkit attach --key <itemKey> --pdf /abs/paper.pdf
zotkit attach --from x.created.json --all      # batch; skips already-attached

# download / fetch PDFs (same auto-detection)
zotkit fetch --key <itemKey> --out downloads
zotkit fetch --title "size and value"

# organize
zotkit tag <itemKey> topic:qaoa prio:high      # add (validated); --rm to remove
zotkit status <itemKey> read                   # replaces the status: tag
zotkit move <itemKey> "Algorithms"             # or "Parent :: Child"; --add for extra home

# safety / hygiene
zotkit doctor                                  # validate config/API/storage
zotkit backup
zotkit lint field:physics topic:new-idea
```

Item JSON for `zotkit create` (one object per paper):

```json
[{"itemType":"journalArticle","title":"...","creators":[{"creatorType":"author","firstName":"A","lastName":"B"}],
  "date":"2024","publicationTitle":"...","DOI":"10.x/y","language":"en",
  "tags":["field:physics","status:to-read"],
  "collection":"Algorithms","file_path":"/abs/paper.pdf"}]
```

`collection` = exact name, or `"Parent :: Child"` for subcollections. For Chinese-name
authors put the full name in `lastName` and leave `firstName` empty.

## From Python

```python
from zotkit import Zot
z = Zot()   # .find / .create_items / .attach / .fetch / .add_tags
            # .set_status / .move / .backup ; z.z = raw pyzotero client
```

For anything not wrapped, use `z.z` (pyzotero): prefer fetch→modify→update per item
(carries the item version) and keep batches ≤ 50.

## When something is blocked

If a source is behind a paywall or bot-wall while fetching a paper or metadata,
**stop and tell the user** — do not attempt to bypass it.
