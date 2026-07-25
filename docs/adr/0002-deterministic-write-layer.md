# Reader plugin write layer: deterministic code, not model tool calls

Status: accepted (2026-07-25)

The Reader plugin's original promise was "read-only": the model held no Zotero
mutation tool at all, full stop (ADR-0001, CONTEXT.md `read-only guarantee`). Two
features change that surface without changing the intent behind it. **Paper Trail**
auto-creates a Zotero highlight annotation at a question's selection position once
its first answer completes, so a paper accumulates a visible trail of "places I
asked about" as the user reads. **Noting** adds a Note button that freezes the
accumulated Q&A and the user's own annotations into a snapshot, synthesizes it into
a structured Markdown+LaTeX note, and imports it as a versioned `.md` child
attachment. Both need real Zotero writes — an annotation per answered question, a
note attachment per Note click — that "the model never mutates anything" cannot
accommodate literally. Routing either through the existing `zotero_propose_changes`
tool call (one Diff, one Apply click, per write) was rejected early: a per-question
approval prompt would kill the "just keep reading" feel Paper Trail exists for, and
Noting's snapshot-then-synthesize shape doesn't fit a single-field Diff either.

Why: we chose to name the actual promise instead of stretching "read-only" past its
meaning. The Reader plugin guarantees that the *model* is never given a Zotero write
tool — no exceptions, and this is statically verified by testing the tool registry
handed to both Ask and Agent turns. Every Zotero mutation, old or new, is instead
executed by deterministic plugin code that only runs in direct response to one
explicit user gesture — asking a selection-anchored question, clicking the undo
chip, clicking "已理解", clicking Apply on a note preview — and every one of those
writes is individually undoable (undo deletes the annotation and its local
AnchorRecord; a replaced note version is imported before the old one is erased, so a
failed import never touches the version being replaced). This is the same shape the
pre-existing `zotero_propose_changes → Diff → Apply → Checkpoint` metadata/PDF path
already had; we are generalizing the guarantee it was already an instance of, not
loosening it.

Consequences and guard-rails:

- **CONTEXT.md**: the `read-only guarantee` entry is renamed `deterministic-write
  guarantee` and now documents the superseding promise; docs must stop calling the
  plugin "read-only" without qualification.
- **Write surface** is now three concrete implementations of the same guarantee: the
  pre-existing `zotero_propose_changes` → Diff → Apply → Checkpoint metadata/PDF
  path, `AnchorHost` (highlight create / undo / open-resolved tag swap), and
  `NotingHost` (note attachment import / version replace). Any future Zotero write
  should be a fourth instance of this pattern, not a new model-facing tool.
- **Consent is a UX gate on top of the guarantee, not a substitute for it.** Paper
  Trail's first-write consent card (`extensions.zotkit.paperTrail` pref, default
  `"unset"`) only controls whether the deterministic code is allowed to write;
  declining it does not change that the model already has zero write tools either
  way — a local-only AnchorRecord is still kept so the question list stays usable.
- **Design record lives on the feature branch, not yet on `main`.**
  `docs/superpowers/specs/2026-07-25-paper-trail-noting-design.md` and
  `docs/superpowers/plans/2026-07-25-paper-trail-noting.md` on
  `feature/zotero-reader-codex-integration` (as of `de2b1b7`) carry the full
  AnchorRecord data model, the highlight write path, and the Noting flow; `main` does
  not have a `docs/superpowers/` tree yet, and these paths will need to be re-checked
  once that branch merges.

Considered and rejected: letting the model call a `zotero_propose_changes`-style
tool for annotations, reviewed through the same Diff/Apply flow as metadata changes
(defeats the point of an automatic trail — a per-question approval click is exactly
the friction Paper Trail is meant to remove, and it hands the model a proposal
surface for a write class it never needed access to before); shadow anchors that
stay purely local while reading and are only turned into real annotations in a batch
when Note runs (leaves the PDF itself unmarked while reading, so flipping back to an
earlier page shows no sign a passage was ever asked about — defeats the "trail" the
feature is named for; its batching idea was reused for the internal highlight write
queue, but the annotation writes themselves stay per-question and immediate).
