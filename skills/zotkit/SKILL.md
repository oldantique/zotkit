---
name: zotkit
description: >
  Use when the user wants to add, create, upload/attach, download/fetch, search, tag,
  look up by item key, cite, export BibTeX for, or organize references (papers, PDFs) in
  their Zotero library via the zotkit CLI —
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
zotkit find --any vaswani                  # metadata-wide: title+abstract+creators+tags+extra
zotkit find --title "boson sampling"
zotkit find --tag status:to-read
zotkit find --collection "Algorithms"
zotkit find --abstract "surface code"      # abstract only (when --any is too noisy)
#   filters AND together, e.g. --any vaswani --collection "ML". When the match is
#   in a field the one-line output doesn't show, an indented line explains it:
#     hit: abstract "...context around the match..."   /   hit: creator "Bultink"
#   "Is this paper already in the library?" With arXiv ids or DOIs, use find --id
#   (next recipe), never a dry run or a find loop. Without one (a local PDF,
#   hand-built JSON), or for "anything by X?",
#   `find --any <first-author-lastname>` is the check. Do not guess title wordings,
#   and don't ask for PDF full-text search: find covers metadata. A zero hit on an
#   author name means not in the library. A zero hit on a CONCEPT term does NOT: some stored abstracts are
#   short publisher one-liners that omit the paper's key terms.
#   Speed: the first find/audit on a machine downloads the whole library (can take
#   10–20 s for a few hundred items). After that, a local cache reconciled against
#   the server makes calls take seconds, with no loss of completeness. Don't treat
#   a slow first call as a hang.

# existence check by identifier (read-only, local — no arXiv/CrossRef calls)
zotkit find --id 2401.12345 10.1038/nature14539 2310.00001v2
zotkit find --id < ids.txt                     # or one id per line on stdin
#   exactly one line per input, in input order:
#     2401.12345 · AB12CD34 · journalArticle
#     10.1038/nature14539 · absent
#     2310.00001v2 · EF56GH78 · preprint · also IJ90KL12   (library has duplicates)
#   versions are ignored and arXiv ids also match journal records that carry them
#   in Extra; DOIs are case-insensitive. "absent" is an answer (exit 0); exit 1
#   only when an input is neither an arXiv id nor a DOI (that line says "invalid").
#   Use the KEY with show/tag/enrich; create only the absent ones.

# look items up by key (read-only)
zotkit show AB12CD34                           # KEY · itemType · Author Year · Title · id
zotkit show AB12CD34 EF56GH78 --json           # full item data instead of one-liners
#   Under each item, one line per attachment (nothing is downloaded):
#     attachment ATTKEY01 · paper.pdf · application/pdf · md5 <32 hex> · stored
#   "Is this local file already in the library?" → compare `md5sum file` with
#   that md5. Do NOT fetch attachments to find out. Last field: stored / missing
#   (no file on the server) / linked / unknown (…). --json: `attachments` list.
#   THE use case: verifying a manifest of item keys. Loop `show` over the keys and
#   check the exit code — it is 1 if ANY key was unknown (each bad key is reported on
#   stderr; the good ones still print), 0 when every key resolved:
zotkit show $(cat keys.txt) || echo "some keys are missing from the library"
#   zotkit has no `find --key` and no `verify --manifest`: reading the manifest file
#   is the project's job, `show` is the lookup. Don't ask for those flags.
#   Errors are one sanitized stderr line (`error: KEY: not found (404)`) safe for
#   CI logs; pass --verbose only when you need the full API exception.

# short citations (read-only, local)
zotkit cite AB12CD34 EF56GH78                  # one line per key, also keys on stdin
#   → "Laughlin, Phys. Rev. Lett. 50, 1395 (1983)": first author (A & B; A et al.),
#   ISO 4 journal, volume, first page/article number, issue year. Unknown key →
#   stderr line + exit 1, the rest still print.

# export BibTeX
zotkit export --key AB12CD34 EF56GH78          # to stdout
zotkit export --key AB12CD34 -o refs.bib       # or to a file
zotkit export < keys.txt                       # keys on stdin, one per line
#   every cite key is ALWAYS rewritten to the Zotero item key — item keys are the
#   identity everything else joins on; do not "restore" author-year cite keys.
#   The first line is a fixed "% Generated by zotkit …" provenance comment — keep it.
#   Entries are raw Web-API BibTeX (Zotero's field order / tab indent / month = jan),
#   so a large first diff against a bibtexparser-processed file is expected, not a bug.
#   An unknown key errors on stderr and exits 1; the other entries still export.

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
#   Extra may also carry `abstract-source: arxiv|crossref|datacite` and `issue-date: …`
#   lines — leave them alone
zotkit create --doi 10.1038/nature14539 --apply --tags field:ai
zotkit create --doi doi1 doi2 --apply                   # DOIs batch the same way
#   Check existence first with `find --id` (above). The dry run (same command,
#   no --apply) checks again, by exact DOI and then normalized title, and prints
#   for each item already there:
#     !! already in library as AB12CD34 — --apply will skip it (use --no-dedup to force)
#   Do NOT run one `find --any` per candidate. That loop is what made agents
#   time out.
#   DOI mode never downloads a PDF (paywalls) — attach one manually afterwards;
#   a DOI CrossRef doesn't know is looked up at DataCite (theses, datasets,
#   software); unknown types, and DOIs in neither registry (e.g. CNKI), error
#   out: fall back to --file for those. arXiv DOIs (10.48550/arXiv.*) → use --arxiv

# create items (JSON list; dry-run first, then --apply; saves x.created.json)
zotkit create --file x.json
zotkit create --file x.json --apply
#   Hand-built JSON often lacks a DOI, so BEFORE creating, check existence with
#   `zotkit find --any <first-author-lastname>` (one call, no title-wording
#   guesswork; see the search recipe above). Then:
#   dedup (exact DOI + normalized title) is ON by default and the dry run runs the
#   same check --apply does: lines like
#     !! already in library as AB12CD34 — --apply will skip it (use --no-dedup to force)
#   mean the item exists. Show them to the user and use that key (e.g. `zotkit enrich`
#   or `zotkit tag`) instead of creating a second copy. `--no-dedup` exists but is a
#   deliberate choice — only pass it when the user says they want the duplicate.

# complete EXISTING items in place (dry-run first, then --apply)
zotkit enrich --key AB12CD34 EF56GH78
zotkit enrich --key AB12CD34 --rebuild-record --apply   # preprint→journal record upgrade
zotkit enrich --key AB12CD34 --doi 10.1103/x.y --rebuild-record   # same, when arXiv
#   doesn't name the journal DOI and you have it. One key; dry first. Refused with
#   "NEEDS OWNER: … may not be this paper" unless the DOI record's title and first
#   author match the item. There is no override: show both titles to the user,
#   don't hunt for another DOI to make it pass.
#   To update an existing item, ALWAYS enrich — NEVER delete and recreate it: the
#   item key must stay stable (downstream manifests reference it). enrich only
#   fills empty fields (existing values are never overwritten), extends author
#   lists only when the current list is a prefix of the authoritative one, and
#   never touches tags/collections/attachments. "NEEDS OWNER" lines in its output
#   are decisions for the user — surface them, don't work around them.
#   A "NOTE abstract still missing: <source> has none" line means the item is
#   STILL missing an abstract and the source can't supply one — not "nothing
#   missing" (the item stays up-to-date and audit keeps listing it). That's the
#   cue to get the text elsewhere and store it with `zotkit abstract`.

# batch enrich + library health
zotkit audit                                   # read-only report: missing abstracts /
zotkit audit --json                            #   DOIs / PDFs, abstract-source hygiene,
                                               #   journal abbreviations
zotkit enrich --missing abstract --apply       # enrich only the gaps (also --missing doi,
zotkit enrich --all                            #   --missing abbreviation; repeatable)
#   batching + rate limits stay INTERNAL — never split the set or add sleeps
#   journalAbbreviation is dotted ISO 4. Only a "registered" form (zotkit's table,
#   or the user's own ZOTKIT_JOURNALS file) may replace a stored value. A
#   "candidate (rule-derived)" from LTWA rules only fills an empty field. Audit's
#   "unverified" list is every journal without a registered form, even when the
#   stored value equals the candidate. Never tell the user a candidate is the
#   official abbreviation, and don't hand-edit the field to match one.
#   An `issue-date: YYYY-MM` line in Extra is zotkit's record of the print issue
#   date (citation year) — leave it alone, like abstract-source.

# store an abstract the user provides (CNKI, publisher page, their own words)
zotkit abstract --key <itemKey> --source cnki --file abs.txt   # or pipe via stdin
#   `abstract` is for relaying OWNER-PROVIDED text — you paste what the user gives
#   you, with --source naming where THEIR text came from (cnki, ssrn, publisher,
#   manual = user-written; any lowercase slug). It cleans web-copy artifacts
#   automatically. It refuses to overwrite an existing abstract or stamp:
#   --force may ONLY be used when the user explicitly says to replace.

# upload / attach PDFs (WebDAV or Zotero Storage — auto-detected from .env)
zotkit attach --key <itemKey> --file /abs/paper.pdf     # any file type (--pdf = alias)
zotkit attach --key <itemKey> --file /abs/talk.pdf --title "Talk slides" --verify
zotkit attach --from x.created.json --all      # batch; skips already-attached
#   --title sets the attachment's title (default: the filename) — don't rename
#   files first. --verify downloads each upload back and compares md5; on a
#   mismatch it prints `error: verify failed for attachment <KEY>: …` and exits 1.
#   It deletes nothing: tell the user, then delete that attachment or retry.
#   Never hand-write an attach → fetch → compare loop; use --verify.

# download / fetch PDFs (same auto-detection)
zotkit fetch --key <itemKey> --out /abs/path/outside/any/repo
zotkit fetch --title "size and value" --out "$(mktemp -d)"
#   ALWAYS pass an explicit --out pointing outside any git repo. Without it files
#   land in ./downloads, and if the current directory is inside a repo the tool warns:
#   loose PDF copies committed into a repo break the library-of-record setup (the
#   library is the one place a file lives). Saved paths are printed absolute.
#   --key accepts an attachment's own key too (from a WebDAV filename, attach
#   output, or a Zotero link): it fetches that file and prints
#     note: <ATTKEY> is an attachment of <PARENT>; fetching this attachment's file
#   Use <PARENT> for anything item-level (show, tag, enrich). If nothing is saved,
#   the reason is on stderr and the exit code is 1: "has no stored file
#   attachments" means there is no PDF in the library to fetch (attach one, don't
#   retry).

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
