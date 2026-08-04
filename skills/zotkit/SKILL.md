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
attachment files go to the user's WebDAV server or Zotero Storage (auto-detected
from the `.env`). Credentials load from an
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

# create from identifiers (auto-fetched metadata; dry-run first, then --apply)
zotkit create --arxiv 2401.12345                        # id, id+version, or abs/pdf URL
zotkit create --arxiv 2401.12345 --apply --tags field:ai,status:to-read --collection "ML"
#   --apply downloads and attaches the arXiv PDF too; add --no-pdf to skip
zotkit create --arxiv id1 id2 id3 --apply               # batch (space- or comma-separated)
#   batching + arXiv/CrossRef rate limits are handled INTERNALLY — never add sleeps
#   or split a batch into repeated single-id calls; a bad id fails alone with its
#   own error and the rest proceed (exit code non-zero iff something failed)
#   version of record is automatic: an arXiv paper with a journal DOI becomes a
#   journal record (CrossRef metadata), with `arXiv: <id>` kept in Extra, the abs
#   page as url, and the PDF still fetched from arXiv; a repository DOI (arXiv
#   10.48550/*, SSRN 10.2139/*, bioRxiv, …) is NOT a journal DOI — those items
#   stay preprints (SSRN's "SSRN Electronic Journal" is not a real journal),
#   and the output states why. Do not "fix" either form by hand.
#   Extra may also carry `abstract-source: arxiv|crossref` — leave that line alone
zotkit create --doi 10.1038/nature14539 --apply --tags field:ai
zotkit create --doi doi1 doi2 --apply                   # DOIs batch the same way
#   DOI mode never downloads a PDF (paywalls) — attach one manually afterwards;
#   unknown CrossRef types error out: fall back to --file for those

# create items (JSON list; dry-run first, then --apply; saves x.created.json)
zotkit create --file x.json
zotkit create --file x.json --apply

# complete EXISTING items in place (dry-run first, then --apply)
zotkit enrich --key AB12CD34 EF56GH78
zotkit enrich --key AB12CD34 --rebuild-record --apply   # preprint→journal record upgrade
#   To update an existing item, ALWAYS enrich — NEVER delete and recreate it: the
#   item key must stay stable (downstream manifests reference it). enrich only
#   fills empty fields (existing values are never overwritten), extends author
#   lists only when the current list is a prefix of the authoritative one, and
#   never touches tags/collections/attachments. "NEEDS OWNER" lines in its output
#   are decisions for the user — surface them, don't work around them.

# batch enrich + library health
zotkit audit                                   # read-only report: missing abstracts /
zotkit audit --json                            #   DOIs / PDFs, abstract-source hygiene
zotkit enrich --missing abstract --apply       # enrich only the gaps (also --missing doi,
zotkit enrich --all                            #   repeatable; --all for everything)
#   batching + rate limits stay INTERNAL — never split the set or add sleeps

# store an abstract the user provides (CNKI, publisher page, their own words)
zotkit abstract --key <itemKey> --source cnki --file abs.txt   # or pipe via stdin
#   `abstract` is for relaying OWNER-PROVIDED text — you paste what the user gives
#   you, with --source naming where THEIR text came from (cnki, ssrn, publisher,
#   manual = user-written; any lowercase slug). It cleans web-copy artifacts
#   automatically. It refuses to overwrite an existing abstract or stamp:
#   --force may ONLY be used when the user explicitly says to replace.

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
