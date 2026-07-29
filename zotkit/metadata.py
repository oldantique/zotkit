"""zotkit.metadata — identifier → item-JSON fetchers (arXiv, CrossRef DOI).

Each fetcher returns a plain item dict in the exact shape `zotkit create --file`
consumes, so the CLI runs every source through the same lint/dry-run/create path.
Scope is deliberately narrow: stable JSON/Atom APIs only — no translation-server,
no arbitrary-URL scraping (zotkit stays a daemon-free CLI).

Abstracts are stored verbatim (line breaks, LaTeX, JATS markup untouched).

Rate limiting lives here, in the request layer: every request through `_get`
waits out the per-host minimum interval (arXiv's terms: 1 request / 3 s on a
single connection; CrossRef polite pool: 1 s). Callers — CLI users, agents,
batch loops — never need to pace themselves.
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


# minimum seconds between requests to the same host (arXiv terms of use: 3 s,
# covering the export API and PDF downloads; CrossRef polite pool: 1 s)
_MIN_INTERVAL = {"export.arxiv.org": 3.0, "arxiv.org": 3.0, "api.crossref.org": 1.0}
_next_ok: dict[str, float] = {}


def _get(url: str, **kw) -> httpx.Response:
    host = httpx.URL(url).host
    wait = _next_ok.get(host, 0.0) - time.monotonic()
    if wait > 0:
        time.sleep(wait)
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
                    f"{host} is rate-limiting (HTTP 429) — wait a minute and retry")
    except httpx.HTTPError as e:
        raise MetadataError(f"network error talking to {host}: {e}") from e
    finally:
        _next_ok[host] = time.monotonic() + _MIN_INTERVAL.get(host, 0.0)
    return r


def _squash(s: str) -> str:
    """Collapse whitespace runs — for titles/names, never for abstracts."""
    return re.sub(r"\s+", " ", s or "").strip()


def _add_extra(item: dict, line: str) -> None:
    """Append a line to the item's Extra field, never overwriting what's there."""
    item["extra"] = f"{item['extra']}\n{line}" if item.get("extra") else line


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


_ARXIV_CHUNK = 50  # ids per id_list request; chunks are spaced out by _get


def _bare(aid: str) -> str:
    return re.sub(r"v\d+$", "", aid, flags=re.IGNORECASE)


def _arxiv_item(entry, aid: str) -> tuple[dict, str]:
    doi = (_squash(entry.findtext(f"{_ARXIV}doi", ""))
           or f"10.48550/arXiv.{_bare(aid)}")
    item = {
        "itemType": "preprint",
        "title": _squash(entry.findtext(f"{_ATOM}title", "")),
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
    if item["abstractNote"]:
        _add_extra(item, "abstract-source: arxiv")
    return item, f"https://arxiv.org/pdf/{aid}"


_DATACITE_PREFIX = "10.48550/"  # arXiv's own DOIs; anything else is a journal DOI


def _journal_record(pre: dict, aid: str) -> dict:
    """Version-of-record upgrade: the arXiv record carries a journal DOI, so
    build the item from CrossRef instead (venue/volume/pages/formal date),
    keeping the arXiv identity: abstract fallback when CrossRef has none,
    `arXiv: <id>` in Extra, and the open-access abs page as url (the journal
    link is carried by the DOI field). Raises MetadataError on lookup failure —
    the caller falls back to the preprint record."""
    j = fetch_doi(pre["DOI"])
    if not j.get("abstractNote") and pre.get("abstractNote"):
        j["abstractNote"] = pre["abstractNote"]
        _add_extra(j, "abstract-source: arxiv")
    j["url"] = pre["url"]
    _add_extra(j, f"arXiv: {aid}")
    return j


def fetch_arxiv_batch(ids_or_urls: list[str]) -> list[dict]:
    """arXiv export API, one id_list request per ≤50 ids → results in input
    order, each {"id", "item", "pdf_url"} or {"id", "error"}. A bad id never
    fails the batch; only transport-level trouble raises MetadataError.

    Version of record: when arXiv reports a journal DOI (not its own
    10.48550/* DataCite DOI) the item is rebuilt from CrossRef ("note" key
    says so); if that lookup fails the preprint record stands ("warning" key).

    The response can't be trusted positionally: entries come back in arbitrary
    order (and with resolved version numbers), so they are mapped back to the
    requested ids by version-stripped id.
    """
    results: list[dict] = []
    valid: list[dict] = []  # results entries still awaiting an API answer
    for s in ids_or_urls:
        try:
            results.append({"id": arxiv_id(s)})
            valid.append(results[-1])
        except MetadataError as e:
            results.append({"id": s, "error": str(e)})

    for i in range(0, len(valid), _ARXIV_CHUNK):
        chunk = valid[i:i + _ARXIV_CHUNK]
        # max_results defaults to 10 — without it, batches >10 silently truncate
        r = _get("https://export.arxiv.org/api/query",
                 params={"id_list": ",".join(c["id"] for c in chunk),
                         "max_results": len(chunk)})
        if r.status_code != 200:
            raise MetadataError(f"arXiv API returned HTTP {r.status_code}")
        try:
            feed = ET.fromstring(r.text)
        except ET.ParseError as e:
            raise MetadataError(f"arXiv API returned unparseable XML: {e}") from e
        emap = {}
        for entry in feed.findall(f"{_ATOM}entry"):
            title = _squash(entry.findtext(f"{_ATOM}title", ""))
            if not title or title == "Error":  # error/placeholder entries: unmappable
                continue
            try:
                emap[_bare(arxiv_id(entry.findtext(f"{_ATOM}id", "")))] = entry
            except MetadataError:
                continue
        for c in chunk:
            entry = emap.get(_bare(c["id"]))
            if entry is None:
                c["error"] = f"arXiv has no record for '{c['id']}' — check the id"
                continue
            c["item"], c["pdf_url"] = _arxiv_item(entry, c["id"])
            doi = c["item"]["DOI"]
            if not doi.startswith(_DATACITE_PREFIX):
                try:
                    c["item"] = _journal_record(c["item"], c["id"])
                    c["note"] = (f"{c['id']} → journal DOI {doi}, "
                                 "building journal record")
                except MetadataError as e:
                    c["warning"] = (f"{c['id']}: journal DOI {doi} lookup failed "
                                    f"({e}) — keeping preprint record")
    return results


def fetch_arxiv(id_or_url: str) -> tuple[dict, str]:
    """arXiv export API → (item dict, pdf url); raises on any failure."""
    res = fetch_arxiv_batch([id_or_url])[0]
    if res.get("error"):
        raise MetadataError(res["error"])
    return res["item"], res["pdf_url"]


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
        "pages": msg.get("page") or msg.get("article-number", ""),
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
    item = {k: v for k, v in item.items() if v not in ("", [])}
    if item.get("abstractNote"):
        _add_extra(item, "abstract-source: crossref")
    return item
