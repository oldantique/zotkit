"""zotkit.audit — read-only health report over top-level scholarly items.

Only paper types are checked for abstract / identifier / PDF; webpages, blog
posts, documents, presentations and the like are listed in their own
`non-paper` bucket instead, so the paper buckets hold only what can be fixed.

No writes, no network beyond the Zotero API. One full item sweep plus one
attachment sweep (a per-item /children walk would be one request per item);
`enrich --all` / `--missing` reuse the same report to pick their work set.
"""
from __future__ import annotations

import re
from typing import Any

from . import journals
from .enrich import _STAMP, _find_arxiv_id

# top-level entries that aren't scholarly records
_NON_SCHOLARLY = {"attachment", "note", "annotation"}

# the types audited for abstract / identifier / PDF (an allow-list: any other
# type goes to the non-paper bucket instead of sitting in those for good)
PAPER_TYPES = {"journalArticle", "conferencePaper", "preprint", "book", "bookSection",
               "thesis", "report", "manuscript", "patent", "standard"}

# a supplementary PDF's title or filename: "Supplementary Information",
# "Supplemental_Material", "supp_pub", "Peer Review File", Nature's
# "…_MOESM1_ESM", Science's "…_sm.pdf". "supp" must stand alone, or
# "Suppressing quantum errors…" (an article filename) would match.
_SUPPLEMENTARY = re.compile(
    r"supplement|(?<![a-z])supp(?![a-z])|peer[\s_-]*review|supporting[\s_-]*info"
    r"|MOESM\d|[_.-]sm(?![a-z])", re.IGNORECASE)


def is_supplementary(att: dict) -> bool:
    """A PDF attachment that is supplementary material, judged by its title —
    or by its filename when the title is just the filename (Zotero can rename
    an SI file after its parent, so the title is the better signal). Giving a
    misjudged article PDF a plain title ("Full Text PDF") overrides this."""
    title = (att.get("title") or "").strip()
    name = title if title and title != att.get("filename") else att.get("filename", "")
    return bool(_SUPPLEMENTARY.search(name or ""))

# bucket key -> human label, in report order
BUCKETS = {
    "missing-abstract": "missing abstract",
    "missing-identifier": "missing identifier (DOI / arXiv id / ISBN / patent number)",
    "missing-pdf": "missing PDF attachment",
    "only-supplementary-pdf": "only supplementary PDFs (article PDF missing)",
    "unstamped-abstract": "abstract without abstract-source stamp",
    "stale-stamp": "abstract-source stamp but no abstract",
    "journal-abbreviation": "journal abbreviation to fix (enrich can)",
    "non-paper": "non-paper items (not checked for abstract / identifier / PDF)",
}


def has_identifier(d: dict) -> bool:
    """A DOI, an arXiv id, an ISBN (books, theses, reports, …) or a patent
    number: whatever identifies an item of its type."""
    return any((d.get(f) or "").strip() for f in ("DOI", "ISBN", "patentNumber")) \
        or bool(_find_arxiv_id(d))


def audit(zot) -> dict[str, Any]:
    """→ {"total", "keys", "buckets": {bucket: [key, …]},
    "journal_abbreviation": {key: {stored, expected, source, unknown}},
    "journal_unverified": {publicationTitle: {keys, stored, candidate,
    source, unknown}}} over every top-level scholarly item, in library order.

    The journal-abbreviation bucket is what `enrich` would change: a stored
    value that differs from the registered form, or an empty one a candidate
    can fill. Every journal without a registered form is listed under
    journal_unverified — whatever is stored, even a value equal to the
    candidate, since agreeing with a rule-derived guess proves nothing. That
    list is the "still to verify against the ISSN Portal" worklist."""
    tops = zot.listing("top")
    atts = zot.listing("attachments")
    pdfs = [a["data"] for a in atts if a["data"].get("contentType") == "application/pdf"]
    pdf_parents = {d.get("parentItem") for d in pdfs}
    article_parents = {d.get("parentItem") for d in pdfs if not is_supplementary(d)}
    keys: list[str] = []
    buckets: dict[str, list[str]] = {b: [] for b in BUCKETS}
    abbrev: dict[str, dict[str, Any]] = {}
    unverified: dict[str, dict[str, Any]] = {}
    for it in tops:
        d = it["data"]
        if d.get("itemType") in _NON_SCHOLARLY:
            continue
        key = it["key"]
        if d.get("itemType") not in PAPER_TYPES:
            buckets["non-paper"].append(key)
            continue
        keys.append(key)
        abstract = d.get("abstractNote", "")
        stamped = bool(_STAMP.search(d.get("extra", "")))
        if not abstract:
            buckets["missing-abstract"].append(key)
        if not has_identifier(d):
            buckets["missing-identifier"].append(key)
        if key not in pdf_parents:
            buckets["missing-pdf"].append(key)
        elif key not in article_parents:
            buckets["only-supplementary-pdf"].append(key)
        if abstract and not stamped:
            buckets["unstamped-abstract"].append(key)
        if stamped and not abstract:
            buckets["stale-stamp"].append(key)
        title = (d.get("publicationTitle") or "").strip()
        if journals.has_field(d) and title and not journals.is_non_latin(title):
            want = journals.check(d)
            stored = (d.get("journalAbbreviation") or "").strip()
            registered = want is not None and want.source == journals.REGISTERED
            if want and stored != want.value and (registered or not stored):
                buckets["journal-abbreviation"].append(key)
                abbrev[key] = {"stored": stored, "expected": want.value,
                               "source": want.source, "unknown": list(want.unknown)}
            if not registered:
                u = unverified.setdefault(title, {
                    "keys": [], "stored": [],
                    "candidate": want.value if want else None,
                    "source": want.source if want else None,
                    "unknown": list(want.unknown) if want else []})
                u["keys"].append(key)
                if stored and stored not in u["stored"]:
                    u["stored"].append(stored)
    return {"total": len(keys), "keys": keys, "buckets": buckets,
            "journal_abbreviation": abbrev, "journal_unverified": unverified}
