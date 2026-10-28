# The READMEs no longer present the Reader plugin as a sibling project

Status: accepted (2026-10-28) — retires [ADR-0003](0003-split-reader-plugin-into-its-own-repo.md)'s
product-family framing

ADR-0003 moved the Zotero Reader plugin to its own repository and kept a
product-family framing: both READMEs carried a short section presenting the two
components and linking across. The plugin is no longer maintained, by the owner's
decision of 2026-10-28.

Decision: remove the family section from `README.md` and `README.zh-CN.md`. zotkit
is presented on its own. The plugin is out of scope for this repo: no doc sync
checks it, and no zotkit change is made for it.

Consequences:

- A link to an unmaintained project would read as an endorsement and send users
  to it. Leaving it out is more accurate than labelling it.
- ADR-0003's other decisions are unaffected. The plugin's code and history stay
  out of this repo, and no `plugin-*` tag will ever exist here.
- ADR-0001, ADR-0002 and ADR-0003 stay as historical records.
