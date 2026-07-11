# Organizing a Zotero library with zotkit + an AI agent

zotkit was built while cleaning up a real ~300-item library with Claude as the worker.
This is the method that worked, genericized. It assumes an agentic CLI (Claude Code or
similar) that can run `zotkit` and read/write JSON files.

## Design principles (decide these before touching anything)

1. **Collections = a shallow, single-axis skeleton.** Pick ONE axis (by function/topic
   works well) and give every item exactly ONE primary home. Deep trees and multi-filing
   rot fast.
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

## Why this beats letting an agent write freely

Every write the agent can get wrong is either dry-run by default (`create`), validated
against your conventions (`tag`/`create`), or trivially restorable (`backup`). The
expensive judgment calls (taxonomy design, proposal review) stay human; the thousand
mechanical edits don't.
