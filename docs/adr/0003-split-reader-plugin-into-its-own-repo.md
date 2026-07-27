# The Reader plugin moves to its own repository

Status: accepted (2026-07-27) — **supersedes [ADR-0001](0001-zotkit-family-monorepo.md)**;
moves the *scope* of [ADR-0002](0002-deterministic-write-layer.md) to the new repo

ADR-0001 accepted the Zotero Reader add-on from PR #1 into this repo and repositioned
zotkit as a two-component product family. That decision was correct for what the
contribution was at the time. It is no longer correct for what the contribution became.
The plugin now lives at [oldantique/zotkit-reader](https://github.com/oldantique/zotkit-reader);
PR #1 was closed in favour of the split, not rejected.

## What changed

ADR-0001 described "a Zotero 9 Reader add-on … that shares the zotkit name and read-only
philosophy but none of the Python code." Over five review rounds the branch grew past that
description. At the point of the split it also contained:

- a **gated write layer** (`zotero_propose_changes` → human diff review → checkpoint rollback),
  so the plugin is no longer read-only but *approval-gated*;
- two further Zotero write surfaces (highlight-annotation "paper trail", `.md` note attachments);
- a **built-in agent engine** with its own OpenAI- and Anthropic-compatible wire adapters and
  streaming HTTP transport;
- **third-party credential management** (API keys in the Gecko Login Manager, provider profiles);
- **SSH remote execution** of Codex on another host.

That is not a component of a headless Python CLI. It is a larger product than zotkit itself,
with a different threat model, and it was still growing at roughly a thousand lines of new
surface per review round.

## Why ADR-0001's rejection of a separate repo no longer holds

ADR-0001 rejected `zotkit-reader` on three grounds. Each has either been answered or inverted:

- **"Weaker discovery, brand fragmentation."** Answered by cross-linking rather than co-location:
  both repos carry a product-family section pointing at the other, and the shared `zotkit-` name
  does the branding work. Discovery was never load-bearing enough to justify the costs below.
- **"Two issue trackers for one audience."** Now a *benefit*, not a cost. The two components have
  genuinely different security surfaces — zotkit is a Web API/WebDAV client; the plugin carries a
  native C PTY helper, stored third-party credentials, outbound traffic to arbitrary LLM
  endpoints, and SSH password auth. A security advisory for one should not implicate the other.
- **"A single repo keeps … branding in one place."** In practice a single repo mostly kept the
  *release lines* in one place, and they fought: we needed a `plugin-vX.Y.Z` tag prefix plus a
  `!startsWith(tag, 'plugin-')` guard in `publish.yml` purely to stop a plugin release from
  re-publishing the Python package to PyPI, and the plugin's manifest version collided with the
  Python package's. Separate repos delete that entire class of problem.

Two further reasons that ADR-0001 could not have anticipated:

- **Active product development does not belong in a pull request.** Five rounds, each adding new
  surface, each requiring a full re-review before anything could land, is a symptom of the wrong
  container. In its own repo this is ordinary work on `main`, reviewed and released at its own cadence.
- **Zero toolchain overlap.** Python/pyproject/PyPI against TypeScript/npm/vitest/XPI/macOS C.
  The monorepo bought almost nothing, since the two share no code — as ADR-0001 itself noted.

## The new arrangement

- **`oldantique/zotkit-reader`** — the Reader plugin, MIT, its own version line, its own release
  notes, its own issue tracker. **ChanceSiyuan is maintainer and release lead** (write access:
  push, tags, releases, issues/PRs). The repo owner stays on as **security reviewer for releases**,
  not as a gatekeeper for individual commits.
- **This repo** — the headless Python CLI/library, unchanged in scope. The planned MCP wrapper
  still lives inside the Python package (`pip install "zotkit[mcp]"`), per ADR-0001.
- **Product-family framing survives the split.** Both READMEs carry a short section presenting the
  two components and linking across. There is no "primary" and no "optional".

## Consequences

- ADR-0001's *layout*, *coequal front page*, and *independent versioning* guard-rails are retired
  along with it: the plugin's layout is its own repo's business, and versioning is independent by
  construction now rather than by tag-prefix convention.
- The `plugin-v*` guard in `.github/workflows/publish.yml` is no longer needed; `plugin-release.yml`
  moves to the new repo and drops its prefix logic. No `plugin-*` tag will ever exist here.
- `.github/CODEOWNERS` gains no `zotero-plugin/` entry — that PR-branch change is moot.
- **ADR-0001's "the plugin never depends on the Python package" is superseded by something
  healthier:** the plugin's terminal integrates zotkit over MCP, and across repos that becomes an
  explicit dependency on a *released* zotkit version rather than repo-local coupling.
- Commit history moved intact (99 commits, authors and dates preserved) via `git filter-repo`
  path extraction; the plugin was already repo-shaped inside its subdirectory (own LICENSE,
  `.gitignore`, `SECURITY.md`, `package.json`), which is itself evidence the split was overdue.

## ADR-0002 stays here as a record, but its subject moves

[ADR-0002](0002-deterministic-write-layer.md) decided the plugin's write model (the model
never holds a Zotero write tool; every mutation is deterministic plugin code behind a user
gesture). It was recorded here because the plugin lived here. It is left in place as the
historical record of a decision made in this repo, but **it documents the plugin's design, so
zotkit-reader owns it from now on** — future revisions belong in that repo's ADR sequence, and
this repo's ADR numbering continues for Python-package decisions only.

One correction it needs when it is carried over: ADR-0002 states that every write "only runs in
direct response to one explicit user gesture — asking a selection-anchored question, clicking the
undo chip, clicking 已理解, clicking Apply." The round-4 review found that the paper-trail writes
in fact fire from `trackTurnTiming()` on the `running: true→false` transition — a `turn/completed`
notification, not a DOM event — and that their *content* is entirely model output. The
tool-registry half of the guarantee was independently verified and holds; the user-gesture half
does not hold as written for paper-trail. The wording should be fixed to match the behaviour (or
the behaviour changed to match the wording) rather than carried over as-is.

## Not resolved by this decision

The split decouples release trains; it does not close the open security findings from the
round-4 review (relink canonical pinning, two SSH command-injection paths, a credential
exfiltration path in the provider "test connection" flow, cross-origin API-key retention,
untrusted-content wrapping dropped on the default backend, and three paper-trail write defects).
Those travel with the code and gate the plugin's **first release**, wherever it lives.
