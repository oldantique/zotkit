"""zotkit.cite — one-line short citations, e.g.
`Laughlin, Phys. Rev. Lett. 50, 1395 (1983)`.

Local: built from the cached library listing, never from CrossRef. The
journal comes from zotkit.journals (the same normaliser create/enrich write
with), and the year is the issue year when an `issue-date:` Extra line
records one — `date` often holds the earlier online-first date.
"""
from __future__ import annotations

import re

from . import journals
from .enrich import _ISSUE_DATE, _find_arxiv_id


def _surname(c: dict) -> str:
    return (c.get("lastName") or c.get("name") or "").strip()


def authors(creators: list[dict]) -> str:
    """First author's surname; "A & B" for two; "A et al." beyond that.
    Editors stand in only when an item has no authors."""
    names = [_surname(c) for c in creators if c.get("creatorType") == "author"]
    names = [n for n in names if n] or [n for n in map(_surname, creators) if n]
    if len(names) > 2:
        return f"{names[0]} et al."
    return " & ".join(names)


def year(d: dict) -> str:
    m = _ISSUE_DATE.search(d.get("extra", ""))
    if m:
        return m[1][:4]
    m = re.search(r"\b(\d{4})\b", d.get("date", ""))
    return m[1] if m else ""


def journal(d: dict) -> str:
    want = journals.check(d)
    if want:
        return want.value
    return (d.get("journalAbbreviation") or d.get("publicationTitle") or "").strip()


def first_page(pages: str) -> str:
    return re.split(r"\s*[-–—,]\s*", (pages or "").strip())[0]


def short(d: dict) -> str:
    """The short citation for item data `d`; never raises on a sparse item."""
    t = d.get("itemType")
    if t == "journalArticle":
        body = " ".join(x for x in (journal(d), d.get("volume", "").strip()) if x)
        page = first_page(d.get("pages", ""))
        if page:
            body = f"{body}, {page}" if body else page
    elif t == "preprint":
        aid = _find_arxiv_id(d)
        body = ("arXiv:" + re.sub(r"v\d+$", "", aid) if aid
                else d.get("repository") or d.get("title", ""))
    elif t == "conferencePaper":
        body = d.get("proceedingsTitle") or d.get("conferenceName") or d.get("title", "")
    elif t == "book":
        body = ", ".join(x for x in (d.get("title", ""), d.get("publisher", "")) if x)
    else:
        body = d.get("title", "")
    y = year(d)
    parts = [p for p in (authors(d.get("creators", [])), body.strip()) if p]
    return ", ".join(parts) + (f" ({y})" if y else "")
