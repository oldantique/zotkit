# Organizing a Zotero library with zotkit + an AI agent

zotkit was built while cleaning up a real ~300-item library with Claude as the worker.
This is the method that worked, genericized. It assumes an agentic CLI (Claude Code or
similar) that can run `zotkit` and read/write JSON files.

## Design principles (decide these before touching anything)

1. **Collections = a shallow, single-axis skeleton.** Pick ONE axis (by function/topic
   works well) and give every item exactly ONE primary home. Deep trees and multi-filing
   rot fast.
   Write an explicit **inclusion criterion per collection** — a "belongs here / does NOT
   belong here" line — plus tie-breakers. The one that resolves most fights: **file by
   the paper's primary contribution, not the method it uses** ("VQE computes a band
   structure" → simulation; "a better VQE" → algorithms). Without written criteria,
   every borderline paper is re-litigated from scratch — by you or by the agent.
2. **Tags = namespaced cross-cutting facets**: `field:`, `topic:`, `type:`, `status:`,
   `prio:` — lowercase-hyphenated, one language. Cross-cutting questions ("all
   superconducting-hardware papers across every collection") are tag intersections, not
   extra folders.
3. **A filter axis must be exhaustive or absent.** If you filter by `field:`, every item
   needs one; a half-applied axis silently lies to you. "Spotlight" tags (fine-grained
   `topic:`s) may stay sparse. Delete anything fuzzy or redundant with itemType.
4. Write the result into **`conventions.toml`** so the rules are enforced by
   `zotkit create`/`zotkit tag` from then on — an agent (or you, tired) cannot drift.

## The agent workflow

The split that proved safe and fast: **parallel read-only analysis, serial reviewed
writes.**

1. `zotkit backup` — full JSON restore point.
2. **Dump once, analyze offline.** Export a slim per-item dataset (key, title, abstract,
   tags, collections) and fan out read-only agent passes over it — e.g. "assign each
   item one collection from this list + tags from these vocabularies". Have each pass
   write a JSON **proposal file**, not perform writes.
3. **Review the proposals** (spot-check ~10%, check the class counts pass a sniff test).
4. **Apply serially** from the main session: batches ≤ 50, version-checked writes
   (zotkit does both), re-runnable/idempotent so a timeout mid-batch is harmless.
5. Sync a desktop client and spot-check; keep the backup until you're sure.

## What it looked like on a real library

- ~285 accumulated tags → 73 namespaced ones (≈250 were importer auto-tags: purge
  auto-tags first, and untick "Automatically tag items with keywords" in the desktop
  preferences so they stop coming back).
- 32 collections (mixed axes, platform + function) → 22 single-axis ones; ~270 items
  re-homed with zero failed writes.
- One LLM pass classified 254 items against a closed 5-value hardware-platform
  vocabulary; ~10% were legitimately "no platform" — an exhaustive axis still allows
  *absence*, it just can't allow *inconsistency*.
- Duplicates: trust DOI matches, distrust title matches (two near-identical titles were
  different PhysRev papers). Metadata backfill: CrossRef by title match, then Semantic
  Scholar batch by DOI.
- The second-pass audit days later (see below) still moved 85 items and cut 73 tags → 63:
  first passes converge, they don't finish.

## The second pass: auditing a library that is already organized

The first cleanup never gets everything right — you learn what the taxonomy should have
been by living in it. Rerun this audit occasionally (it found plenty on a library
organized only days earlier). Same safety rules: backup first, analyze read-only,
write serially.

**Collection health.** Dump every collection's items (key, title, tags) and look for
four symptoms:

- **Oversized with a hidden sub-cluster** — one collection holding ~25% of the library,
  where half its items answer a different question than the other half. Split along the
  question boundary. (Real case: a 68-item "Readout" hiding a 45-item parametric-amplifier
  cluster — "how do we amplify?" vs "how do we measure?".)
- **Catch-all drift** — a "Misc/Fundamentals" collection accumulating things that each
  belong to a specific collection. Keep only genuinely cross-cutting works there; sink
  the rest (a single-topic review or thesis files under its topic, not under "Reviews").
- **One theme split across collections** — the same reading interest scattered because
  the skeleton followed a textbook's chapter list instead of the owner's actual interests.
  Merge into one collection named for the theme.
- **Near-empty collections** (2–4 items) — merge into the nearest neighbor.

**Tag health.** Beyond re-checking axis coverage (principle 3):

- **Near-synonyms** coined over time (`rydberg-atom` + `rydberg-blockade`) — merge.
- **Tags that duplicate collection membership** (a `simulation` tag on items that all sit
  in the Simulation collection) — delete; the collection already carries the signal.
- **Misnamed tags**: when a tag's items don't match its name, don't assume mis-tagging —
  **ask the owner what they meant**. (Real case: `high-tc-qubit` looked wrongly applied
  to 18 of 19 items; it actually marked a "hot/high-frequency qubit operation" reading
  theme and just needed renaming.)
- **Axes that never reached coverage** — an exhaustive-by-design axis stuck at 15% after
  months is dead weight; principle 3 says fix it or delete it, and deleting your own
  failed axis is allowed.

**Invariants to verify after any bulk operation** (cheap, catches real breakage):
every item has exactly one collection home (list items with 0 or 2+ homes — both lists
should be empty, or explainable), every required axis at 100%, zero tags outside the
declared namespaces.

**Division of labor that worked:** the agent executes every unambiguous move autonomously
and **batches the genuinely ambiguous calls into 2–3 explicit questions** for the owner
(item-by-item confirmation is as exhausting as doing it manually; silent guessing on
taxonomy is worse). Judgment calls the agent did make get listed in the final report for
review.

## Why this beats letting an agent write freely

Every write the agent can get wrong is either dry-run by default (`create`), validated
against your conventions (`tag`/`create`), or trivially restorable (`backup`). The
expensive judgment calls (taxonomy design, proposal review) stay human; the thousand
mechanical edits don't.
