# Development context (for agent sessions in this repo)

This file is for AI-assisted *development* sessions on zotkit itself. If you are an
agent helping a user *use* zotkit on their library, read [AGENTS.md](AGENTS.md) instead.

## Scope

This repo is the **Python package only** (headless Zotero Web-API + WebDAV CLI/library).
The Zotero Reader plugin is a separate repo,
[oldantique/zotkit-reader](https://github.com/oldantique/zotkit-reader) — see
[docs/adr/0003](docs/adr/0003-split-reader-plugin-into-its-own-repo.md). Shared
vocabulary is defined in [CONTEXT.md](CONTEXT.md); use those terms in docs and code.

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
- Tag conventions are **data + code**, not prose: users supply `conventions.toml`
  (see `conventions.example.toml`); `zotkit.core.lint_tags` enforces it in
  `create`/`tag`. Don't add convention rules that exist only in documentation.
- `skills/zotkit/SKILL.md` — the end-user agent skill; update it when CLI
  commands/flags change (it lists exact invocations).
