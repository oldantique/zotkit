# zotkit is a product family in one repo

Status: accepted (2026-07-22)

zotkit began as a headless Python CLI/library. PR #1 contributed a full Zotero 9
Reader add-on (TypeScript + a macOS native helper) that shares the zotkit name and
read-only philosophy but none of the Python code. We decided to accept it into this
repo and reposition zotkit as a small product family — headless CLI + Reader plugin —
rather than keeping the plugin in a separate repo or declining it.

Why: the two components target the same users (Zotero + AI-agent workflows), cross-sell
each other, and a single repo keeps discovery, issues, and branding in one place. The
costs we accepted knowingly: a TS+C+Python triple stack, macOS CI for the plugin, and a
more complex README narrative.

Consequences and guard-rails:

- **Front page presents the two components as coequal.** Neither is "primary" or
  "optional" — the headless pitch is the Python package's identity and stays on top
  alongside the plugin.
- **Layout: Python package stays at the repo root** (PyPI packaging, editable installs,
  and history links all point there); other components are flat top-level directories
  (`zotero-plugin/`, …). No `packages/` restructure until a third component actually
  exists. The planned MCP wrapper will live *inside* the Python package
  (`pip install "zotkit[mcp]"`), not as a new directory.
- **Independent versioning and releases**: Python `vX.Y.Z` tags → PyPI; plugin
  `plugin-vX.Y.Z` tags → CI-built XPI on GitHub Releases, with a real `update_url`
  manifest feed.
- **Split maintainership**: the plugin is maintained by its contributor as
  co-maintainer (CODEOWNERS: `zotero-plugin/`), the Python package by the repo owner;
  each reviews PRs touching the other's area.
- **The plugin never depends on the Python package** (and vice versa); they may only
  share names and documented conventions. See CONTEXT.md for the vocabulary.

Considered and rejected: separate `zotkit-reader` repo (weaker discovery, brand
fragmentation, two issue trackers for one audience); folding the plugin's query layer
into the Python package (different runtime — the plugin must work with no Python
installed).
