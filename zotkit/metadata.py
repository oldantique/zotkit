"""zotkit.metadata — identifier → item-JSON fetchers (arXiv, CrossRef DOI).

Each fetcher returns a plain item dict in the exact shape `zotkit create --file`
consumes, so the CLI runs every source through the same lint/dry-run/create path.
Scope is deliberately narrow: stable JSON/Atom APIs only — no translation-server,
no arbitrary-URL scraping (zotkit stays a daemon-free CLI).

Abstracts are stored verbatim (line breaks, LaTeX, JATS markup untouched).
"""
from __future__ import annotations

import re
import time
import xml.etree.ElementTree as ET
from urllib.parse import quote

import httpx

from . import __version__

CONTACT = "mailto:Eric.M.990909@gmail.com"
USER_AGENT = f"zotkit/{__version__} (https://github.com/oldantique/zotkit; {CONTACT})"

_ATOM = "{http://www.w3.org/2005/Atom}"
_ARXIV = "{http://arxiv.org/schemas/atom}"

# CrossRef work types with a faithful Zotero equivalent. Anything else errors —
# guessing an itemType would silently corrupt the record.
CROSSREF_TYPES = {
    "journal-article": "journalArticle",
    "proceedings-article": "conferencePaper",
    "posted-content": "preprint",
    "book": "book",
    "monograph": "book",
    "edited-book": "book",
    "reference-book": "book",
    "book-chapter": "bookSection",
    "book-section": "bookSection",
    "book-part": "bookSection",
    "report": "report",
    "dissertation": "thesis",
    "dataset": "dataset",
    "standard": "standard",
}

# where CrossRef's container-title belongs, per Zotero itemType
_CONTAINER_FIELD = {
    "journalArticle": "publicationTitle",
    "conferencePaper": "proceedingsTitle",
    "bookSection": "bookTitle",
}


class MetadataError(RuntimeError):
    """A metadata lookup failed in a way the user must resolve (bad id,
    unknown record, unsupported type, network trouble)."""


def _get(url: str, **kw) -> httpx.Response:
    try:
        r = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=30,
                      follow_redirects=True, **kw)
        if r.status_code == 429:  # rate-limited: honor Retry-After once, then give up
            wait = min(int(r.headers.get("retry-after") or 5), 30)
            time.sleep(wait)
            r = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=30,
                          follow_redirects=True, **kw)
            if r.status_code == 429:
                raise MetadataError(
                    f"{httpx.URL(url).host} is rate-limiting (HTTP 429) — "
                    "wait a minute and retry")
    except httpx.HTTPError as e:
        raise MetadataError(f"network error talking to {httpx.URL(url).host}: {e}") from e
    return r


def _squash(s: str) -> str:
    """Collapse whitespace runs — for titles/names, never for abstracts."""
    return re.sub(r"\s+", " ", s or "").strip()


def _person(name: str) -> dict:
    """Split a display name into first/last on the final space; single-token
    names go in lastName alone (matches Zotero's single-field mode)."""
    name = _squash(name)
    if " " in name:
        first, last = name.rsplit(" ", 1)
        return {"creatorType": "author", "firstName": first, "lastName": last}
    return {"creatorType": "author", "firstName": "", "lastName": name}


# ---------- arXiv ----------

_ARXIV_ID = re.compile(r"(?:arxiv\.org/(?:abs|pdf)/|arxiv:)?"
                       r"((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?)"
                       r"(?:\.pdf)?$", re.IGNORECASE)


def arxiv_id(id_or_url: str) -> str:
    """Accept a bare id (2401.12345, 2401.12345v2, math.GT/0309136) or an
    arxiv.org abs/pdf URL; return the bare id."""
    s = id_or_url.strip().removeprefix("https://").removeprefix("http://").removeprefix("www.")
    m = _ARXIV_ID.search(s)
    if not m:
        raise MetadataError(f"'{id_or_url}' does not look like an arXiv id or URL")
    return m.group(1)


def fetch_arxiv(id_or_url: str) -> tuple[dict, str]:
    """arXiv export API → (item dict, pdf url)."""
    aid = arxiv_id(id_or_url)
    r = _get("https://export.arxiv.org/api/query", params={"id_list": aid})
    if r.status_code != 200:
        raise MetadataError(f"arXiv API returned HTTP {r.status_code} for '{aid}'")
    try:
        feed = ET.fromstring(r.text)
    except ET.ParseError as e:
        raise MetadataError(f"arXiv API returned unparseable XML: {e}") from e
    entry = feed.find(f"{_ATOM}entry")
    title = _squash(entry.findtext(f"{_ATOM}title", "")) if entry is not None else ""
    if entry is None or not title:
        raise MetadataError(f"arXiv has no record for '{aid}' — check the id")
    if title == "Error":
        raise MetadataError(f"arXiv API error for '{aid}': "
                            f"{_squash(entry.findtext(f'{_ATOM}summary', ''))}")

    bare = re.sub(r"v\d+$", "", aid)
    doi = _squash(entry.findtext(f"{_ARXIV}doi", "")) or f"10.48550/arXiv.{bare}"
    item = {
        "itemType": "preprint",
        "title": title,
        "creators": [_person(n.text or "")
                     for n in entry.findall(f"{_ATOM}author/{_ATOM}name")],
        "abstractNote": (entry.findtext(f"{_ATOM}summary", "") or "").strip("\n "),
        "date": (entry.findtext(f"{_ATOM}published", "") or "")[:10],
        "url": f"https://arxiv.org/abs/{aid}",
        "DOI": doi,
        "repository": "arXiv",
        "archiveID": f"arXiv:{aid}",
        "libraryCatalog": "arXiv.org",
    }
    return item, f"https://arxiv.org/pdf/{aid}"


def download_pdf(url: str, dest) -> None:
    """Download a PDF to `dest`, refusing anything that isn't actually a PDF."""
    r = _get(url)
    if r.status_code != 200:
        raise MetadataError(f"PDF download failed: HTTP {r.status_code} from {url}")
    if not r.content.startswith(b"%PDF"):
        raise MetadataError(f"{url} did not return a PDF "
                            f"(got {r.headers.get('content-type', 'unknown type')})")
    with open(dest, "wb") as f:
        f.write(r.content)


# ---------- CrossRef DOI ----------

def _crossref_date(msg: dict) -> str:
    for k in ("issued", "published-print", "published-online", "created"):
        parts = (msg.get(k) or {}).get("date-parts", [[]])[0]
        if parts and parts[0]:
            return "-".join(f"{p:02d}" if i else str(p) for i, p in enumerate(parts))
    return ""


def fetch_doi(doi: str) -> dict:
    """CrossRef works API → item dict. Unknown CrossRef types are an error."""
    doi = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:)", "", doi.strip(), flags=re.IGNORECASE)
    r = _get(f"https://api.crossref.org/works/{quote(doi, safe='')}")
    if r.status_code == 404:
        raise MetadataError(f"CrossRef has no record for DOI '{doi}' — check the DOI "
                            "(DataCite-only DOIs, e.g. Zenodo/arXiv, are not in CrossRef)")
    if r.status_code != 200:
        raise MetadataError(f"CrossRef API returned HTTP {r.status_code} for '{doi}'")
    msg = r.json()["message"]

    ctype = msg.get("type", "")
    itype = CROSSREF_TYPES.get(ctype)
    if not itype:
        raise MetadataError(
            f"CrossRef type '{ctype}' has no zotkit mapping — supported: "
            + ", ".join(sorted(CROSSREF_TYPES)) + ". Create this item via --file instead.")

    creators = []
    for role, ztype in (("author", "author"), ("editor", "editor")):
        for a in msg.get(role, []):
            if a.get("family"):
                creators.append({"creatorType": ztype,
                                 "firstName": _squash(a.get("given", "")),
                                 "lastName": _squash(a["family"])})
            elif a.get("name"):
                creators.append({"creatorType": ztype, "name": _squash(a["name"])})

    title = _squash((msg.get("title") or [""])[0])
    subtitle = _squash((msg.get("subtitle") or [""])[0])
    if subtitle and subtitle.lower() not in title.lower():
        title = f"{title}: {subtitle}"
    item = {
        "itemType": itype,
        "title": title,
        "creators": creators,
        "abstractNote": msg.get("abstract", ""),
        "date": _crossref_date(msg),
        "DOI": doi,
        "url": msg.get("URL") or f"https://doi.org/{doi}",
        "volume": msg.get("volume", ""),
        "issue": msg.get("issue", ""),
        "pages": msg.get("page", ""),
        "publisher": _squash(msg.get("publisher", "")),
        "language": msg.get("language", ""),
        "ISSN": (msg.get("ISSN") or [""])[0],
        "ISBN": (msg.get("ISBN") or [""])[0],
        "journalAbbreviation": _squash((msg.get("short-container-title") or [""])[0]),
        "libraryCatalog": "CrossRef",
    }
    container = _squash((msg.get("container-title") or [""])[0])
    if container:
        item[_CONTAINER_FIELD.get(itype, "publicationTitle")] = container
    if not item["title"]:
        raise MetadataError(f"CrossRef record for '{doi}' has no title — refusing to "
                            "create an empty item")
    return {k: v for k, v in item.items() if v not in ("", [])}
