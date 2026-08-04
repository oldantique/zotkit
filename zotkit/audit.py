"""zotkit.audit — read-only health report over top-level scholarly items.

No writes, no network beyond the Zotero API. One full item sweep plus one
attachment sweep (a per-item /children walk would be one request per item);
`enrich --all` / `--missing` reuse the same report to pick their work set.
"""
from __future__ import annotations

from typing import Any

from .enrich import _STAMP, _find_arxiv_id

# top-level entries that aren't scholarly records
_NON_SCHOLARLY = {"attachment", "note", "annotation"}

# bucket key -> human label, in report order
BUCKETS = {
    "missing-abstract": "missing abstract",
    "missing-identifier": "missing DOI / arXiv id",
    "missing-pdf": "missing PDF attachment",
    "unstamped-abstract": "abstract without abstract-source stamp",
    "stale-stamp": "abstract-source stamp but no abstract",
}


def audit(zot) -> dict[str, Any]:
    """→ {"total", "keys", "buckets": {bucket: [key, …]}} over every
    top-level scholarly item, in library order."""
    tops = zot.z.everything(zot.z.top())
    atts = zot.z.everything(zot.z.items(itemType="attachment"))
    pdf_parents = {a["data"].get("parentItem") for a in atts
                   if a["data"].get("contentType") == "application/pdf"}
    keys: list[str] = []
    buckets: dict[str, list[str]] = {b: [] for b in BUCKETS}
    for it in tops:
        d = it["data"]
        if d.get("itemType") in _NON_SCHOLARLY:
            continue
        key = it["key"]
        keys.append(key)
        abstract = d.get("abstractNote", "")
        stamped = bool(_STAMP.search(d.get("extra", "")))
        if not abstract:
            buckets["missing-abstract"].append(key)
        if not (d.get("DOI") or "").strip() and not _find_arxiv_id(d):
            buckets["missing-identifier"].append(key)
        if key not in pdf_parents:
            buckets["missing-pdf"].append(key)
        if abstract and not stamped:
            buckets["unstamped-abstract"].append(key)
        if stamped and not abstract:
            buckets["stale-stamp"].append(key)
    return {"total": len(keys), "keys": keys, "buckets": buckets}
