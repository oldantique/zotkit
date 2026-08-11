# Development context (for agent sessions in this repo)

This file is for AI-assisted *development* sessions on zotkit itself. If you are an
agent helping a user *use* zotkit on their library, read [AGENTS.md](AGENTS.md) instead.

## Scope

This repo is the **Python package only** (headless Zotero Web-API + WebDAV CLI/library).
The Zotero Reader plugin is a separate repo,
[oldantique/zotkit-reader](https://github.com/oldantique/zotkit-reader) — see
[docs/adr/0003](docs/adr/0003-split-reader-plugin-into-its-own-repo.md).
Data conventions (version of record, abstract-source stamp) are documented in
README — keep docs and code consistent with it.

## Releasing

1. Bump the version in **both** `pyproject.toml` and `zotkit/__init__.py` (keep them equal).
2. Update README "Limits & roadmap" / changelog notes if behavior changed.
3. Commit, push to `main`.
4. Create the GitHub release via REST — `gh release create` has given a spurious
   scope error here, the API works:
   `gh api repos/oldantique/zotkit/releases -X POST -f tag_name=vX.Y.Z -f name=vX.Y.Z -f body='...'`
5. `.github/workflows/publish.yml` then publishes to PyPI automatically via
   **Trusted Publishing** (no tokens anywhere). Tags are plain `vX.Y.Z`.
6. Verify: `pipx run --spec zotkit==X.Y.Z zotkit --version` once PyPI updates.

## Tests

- `tests/` is the offline pytest suite: `test_metadata.py` (abstract cleaner +
  two-layer version-of-record predicate + `fetch_arxiv_batch` against a canned
  feed), `test_enrich.py` (`plan_enrich` VoR gate, `set_abstract`
  guard/force/stamp matrix), `test_audit.py` (bucketing), and the v0.7.0 CLI
  features: `test_dedup.py` (dedup_maps/duplicate_key + skipped-meta keys),
  `test_show.py`, `test_export.py` (_rekey + faked HTTP), `test_fetch_warning.py`
  (git-worktree detection on tmp repos), and `test_find.py` (v0.8.0 --any/
  --abstract matching, hit annotations, snippet shape). Run with
  `pip install -e ".[dev]" && pytest`. pytest is a dev extra only — runtime
  deps stay exactly pyzotero + httpx.
- **Tests stay offline**: no network, no `.env`, no credentials, no live
  library. Anything that needs those is a manual smoke step: read-only
  `zotkit audit` against the real library, plus a create/`abstract` round-trip
  on a temp item that is deleted (and confirmed 404) afterwards.
- CI (`.github/workflows/ci.yml`) runs the suite on every push/PR across
  ubuntu + windows × Python 3.11/3.13 — Windows is not optional (the v0.1.x
  release-breaker was a Windows UTF-8 bug). `publish.yml` runs the same test
  job before build, so release step 3 (push) now implies CI must be green;
  a failing suite blocks the PyPI publish.
- Still-open debt: the Zotero Storage attachment branch has no automated or
  live test — manual verification only (see Hard constraints).

## Hard constraints

- **Windows text IO**: every `open()` for text must pass `encoding="utf-8"`.
  A v0.1.x release broke on Windows exactly this way.
- **Never claim zotkit is the "only" WebDAV-write implementation** — zotero-mcp
  shipped the same K.zip/K.prop upload in its v0.4–v0.5. Honest differentiators:
  fully headless for every feature, purpose-built CLI, conventions-in-code, `doctor`,
  the published format doc.
- **Attachment storage has two branches**: the WebDAV branch is regression-tested
  live; the Zotero Storage branch goes through pyzotero and has NOT been tested
  against a real storage library — flag any change there for manual verification.
- **Credentials**: never print, cat, echo, or commit a `.env` or API key/WebDAV
  password, including a developer's local one.

## Where things are

- `docs/webdav-format.md` — the reverse-engineered WebDAV attachment format.
  If you change the upload/download code, keep this doc in sync (it is itself
  a headline feature of the repo).
- `docs/adr/` — architecture decisions; add a numbered ADR for structural changes.
- `zotkit/metadata.py` — identifier → item-JSON fetchers (arXiv/CrossRef). ALL
  request pacing lives in its `_get` (per-host intervals) — never add sleeps or
  retry logic in callers.
- `zotkit/enrich.py` — in-place completion of existing items. Core invariant:
  the item key never changes; merge policy (fill-empty-only, creator prefix
  rule, append-only Extra, abstract-source stamp) is documented in its module
  docstring and README → "Enriching existing items".
- `zotkit/export.py` — BibTeX export. Cite keys are ALWAYS rewritten to the
  Zotero item key (that's the command's purpose); entries are fetched raw over
  the Web API on purpose — do not "simplify" to pyzotero's `format='bibtex'`,
  which reparses/reflows entries through bibtexparser.
- Tag conventions are **data + code**, not prose: users supply `conventions.toml`
  (see `conventions.example.toml`); `zotkit.core.lint_tags` enforces it in
  `create`/`tag`. Don't add convention rules that exist only in documentation.
- `skills/zotkit/SKILL.md` — the end-user agent skill; update it when CLI
  commands/flags change (it lists exact invocations).
