# Journal abbreviations: registered ISO 4 forms first, LTWA rules as unshipped candidates

Status: accepted (2026-10-27)

`journalAbbreviation` was whatever the source wrote. CrossRef's
`short-container-title` is undotted for some publishers ("Nat Commun"), the full
title for others, and empty for others. Desktop and browser-connector saves add
their translators' forms. `cite` (#12) needs one consistent abbreviation, and so
do desktop citation styles, word-processor plugins and scripts. Those read the
stored value, not zotkit's output, so normalising only at render time would
leave them inconsistent.

Decision: one normaliser, `zotkit/journals.py`, used by create, enrich, audit and
cite. The stored form is dotted ISO 4. Periods can be stripped when rendering;
they cannot be reliably added back. There are three sources, in order of
authority:

1. **Registered**: the ISSN network's abbreviated key-title. It comes from a
   table shipped as package data, merged under the user's own verified rows
   (`ZOTKIT_JOURNALS`).
2. **Title**: a journal title that is visibly abbreviated already, taken as
   written.
3. **Rule-derived**: ISO 4 word rules over the LTWA. They run only when the
   user points `ZOTKIT_LTWA` at a copy they downloaded themselves.

Why this shape:

- **The LTWA is a word list, not the authority.** Word-by-word output differs
  from some registered forms. "Comptes Rendus. Physique" comes out as
  "Comptes Rendus Phys." against the registered "C. R. Phys.". "Physica A:
  Statistical Mechanics and its Applications" comes out as "Phys. A: Stat.
  Mech. Appl." against the registered "Physica A". So rule output is a
  *candidate*. It fills an empty field but never replaces a stored value.
  `audit` lists every journal without a registered form as unverified, even
  when the stored value equals the candidate, because agreement with a guess
  proves nothing. Only a registered form may overwrite.
- **zotkit does not redistribute the LTWA.** The ISSN International Centre
  maintains it, and its legal notice reserves database rights. We found no
  explicit grant to redistribute it, in full or in part. The package ships
  only the registered-form table, and the rule engine works on a file the user
  supplies. Tests run on a few hand-written rows in LTWA format, never on the
  list itself.
- **No opinion is a valid answer.** If a title is in no table, no LTWA file is
  configured, or the title is in a non-Latin script, the normaliser returns
  None. Callers then keep what is stored, or what CrossRef offered. That is
  exactly the behaviour before this decision, so turning the feature on never
  makes a value worse.

The issue year rides on the same change. `date` often holds the online-first
date. When CrossRef's print issue date falls in a different year, create and
enrich append `issue-date: YYYY[-MM[-DD]]` to Extra. This happens on journal
articles and conference papers only, never on preprints. The line follows the
same append-only rule as `abstract-source:`, and cite reads its year from it.
The key is deliberately not a CSL variable. Zotero's citation processor reads
`issued:`, which would change how the desktop client cites the item.
