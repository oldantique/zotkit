"""`find --id`: which of these arXiv ids / DOIs are already in the library?

Local and read-only: answered from the top-level listing (the ADR-0004 cache),
never from arXiv or CrossRef. An item is indexed under every identifier it
carries — its DOI, a `DOI:` Extra line (types without a DOI field), and its
arXiv id from archiveID, an `arXiv:` Extra line, an arxiv.org url, or arXiv's
own `10.48550/arXiv.*` DOI. arXiv ids are matched with the version stripped,
DOIs case-insensitively.
"""
from __future__ import annotations

import re

from . import metadata as md
from .enrich import _ARXIV_IN_TEXT

_DOI_PREFIX = re.compile(r"^(https?://(dx\.)?doi\.org/|doi:\s*)", re.IGNORECASE)
_DOI_IN_EXTRA = re.compile(r"^DOI:\s*(10\.\S+)", re.IGNORECASE | re.MULTILINE)
_ARXIV_DOI = "10.48550/arxiv."


def _norm_doi(s: str) -> str:
    return _DOI_PREFIX.sub("", s.strip()).lower()


def _norm_arxiv(aid: str) -> str:
    return md._bare(aid).lower()


def parse_id(raw: str) -> tuple[str, str]:
    """('doi', normalized DOI) or ('arxiv', bare lowercase id). arXiv's own
    DataCite DOI counts as the arXiv id. ValueError if it is neither."""
    doi = _norm_doi(raw)
    if doi.startswith(_ARXIV_DOI):
        return "arxiv", _norm_arxiv(doi[len(_ARXIV_DOI):])
    if doi.startswith("10.") and "/" in doi:
        return "doi", doi
    try:
        return "arxiv", _norm_arxiv(md.arxiv_id(raw))
    except md.MetadataError:
        raise ValueError(f"'{raw}' is not an arXiv id or DOI") from None


def item_ids(d: dict) -> set[tuple[str, str]]:
    """Every identifier item data `d` can be found under."""
    out = set()
    dois = [d.get("DOI") or ""] + _DOI_IN_EXTRA.findall(d.get("extra", ""))
    for doi in filter(None, (_norm_doi(x) for x in dois)):
        if doi.startswith(_ARXIV_DOI):
            out.add(("arxiv", _norm_arxiv(doi[len(_ARXIV_DOI):])))
        else:
            out.add(("doi", doi))
    for text in (d.get("archiveID", ""), d.get("extra", "")):
        out.update(("arxiv", _norm_arxiv(m)) for m in _ARXIV_IN_TEXT.findall(text))
    if "arxiv.org/" in d.get("url", ""):
        try:
            out.add(("arxiv", _norm_arxiv(md.arxiv_id(d["url"]))))
        except md.MetadataError:
            pass
    return out


def lookup_ids(items: list[dict], ids: list[str]) -> list[dict]:
    """One record per input, in input order:
    {"input", "matches": [(key, itemType), …]} or {"input", "error"}.
    Several matches mean the library holds duplicates; all are listed."""
    index: dict[tuple[str, str], list[tuple[str, str]]] = {}
    for it in items:
        d = it.get("data", {})
        if d.get("itemType") in ("attachment", "note"):  # standalone ones are top-level too
            continue
        for ident in item_ids(d):
            index.setdefault(ident, []).append((it["key"], d.get("itemType", "")))
    out = []
    for raw in ids:
        try:
            out.append({"input": raw, "matches": index.get(parse_id(raw), [])})
        except ValueError as e:
            out.append({"input": raw, "error": str(e)})
    return out
