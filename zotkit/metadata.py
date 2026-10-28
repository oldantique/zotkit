"""zotkit.metadata — identifier → item-JSON fetchers (arXiv, CrossRef/DataCite DOI).

Each fetcher returns a plain item dict in the exact shape `zotkit create --file`
consumes, so the CLI runs every source through the same lint/dry-run/create path.
Scope is deliberately narrow: stable JSON/Atom APIs only — no translation-server,
no arbitrary-URL scraping (zotkit stays a daemon-free CLI).

Abstracts: plain-text abstracts (arXiv summaries) are stored verbatim — line
breaks and LaTeX untouched. CrossRef abstracts arrive as JATS XML and are
cleaned to readable plain text by `_clean_abstract` at the point they enter an
item record; abstracts already in a library are never touched.

Rate limiting lives here, in the request layer: every request through `_get`
waits out the per-host minimum interval (arXiv's terms: 1 request / 3 s on a
single connection; CrossRef polite pool and DataCite: 1 s). Callers — CLI users, agents,
batch loops — never need to pace themselves.
"""
from __future__ import annotations

import html
import os
import re
import time
import xml.etree.ElementTree as ET
from urllib.parse import quote

import httpx

from . import __version__, journals

# CrossRef's polite pool and Unpaywall want a reachable contact; $ZOTKIT_MAILTO
# overrides the default (distributors of zotkit-based tools: set your own).
MAILTO = os.environ.get('ZOTKIT_MAILTO', 'ccmuuc@gmail.com')
CONTACT = f"mailto:{MAILTO}"
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

# DataCite resourceTypeGeneral values with a faithful Zotero equivalent; the
# same rule as CROSSREF_TYPES (anything else errors). "Text" counts as a
# thesis only when the record's own resourceType says so.
DATACITE_TYPES = {
    "JournalArticle": "journalArticle",
    "ConferencePaper": "conferencePaper",
    "Preprint": "preprint",
    "Book": "book",
    "BookChapter": "bookSection",
    "Report": "report",
    "Dissertation": "thesis",
    "Dataset": "dataset",
    "Software": "computerProgram",
    "Standard": "standard",
}

# Zotero's type-specific name for the publisher field. create/enrich copy only
# fields the type's template has, so "publisher" on a thesis would be dropped.
_PUBLISHER_FIELD = {
    "thesis": "university",
    "report": "institution",
    "computerProgram": "company",
    "dataset": "repository",
    "preprint": "repository",
}

# the primary creator type where it isn't "author", and the types whose
# Zotero schema has no "editor" role (an invalid role fails the whole create)
_PRIMARY_CREATOR = {"computerProgram": "programmer"}
_NO_EDITOR = {"computerProgram", "dataset", "thesis"}
_VERSIONED = {"computerProgram", "dataset", "standard"}

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
_MIN_INTERVAL = {"export.arxiv.org": 3.0, "arxiv.org": 3.0, "api.crossref.org": 1.0,
                 "api.datacite.org": 1.0, "api.unpaywall.org": 1.0}
_next_ok: dict[str, float] = {}


def _get(url: str, *, retry: bool = True, **kw) -> httpx.Response:
    """GET with per-host pacing. A 429 is retried once after Retry-After,
    unless `retry` is off: an open-access download must stop at the first
    refusal, so it sees the 429 itself."""
    host = httpx.URL(url).host
    wait = _next_ok.get(host, 0.0) - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    try:
        r = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=30,
                      follow_redirects=True, **kw)
        if r.status_code == 429 and retry:  # honor Retry-After once, then give up
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


# a real markup tag (JATS or plain HTML) — deliberately a closed list of tag
# names, so LaTeX like "$x<y$ and $z>w$" in a plain-text abstract can never
# be mistaken for markup and mangled
_ABS_TAG = re.compile(
    r"</?(?:jats:)?(?:p|sup|sub|title|sec|italic|bold|i|b|em|strong|sc|"
    r"underline|list|list-item|label|inline-formula|disp-formula|"
    r"tex-math|styled-content|related-article|xref|ext-link)\b[^>]*>",
    re.IGNORECASE)
_SUP = re.compile(r"<(?:jats:)?sup[^>]*>(.*?)</(?:jats:)?sup>", re.I | re.S)
_SUB = re.compile(r"<(?:jats:)?sub[^>]*>(.*?)</(?:jats:)?sub>", re.I | re.S)
_TITLE = re.compile(r"<(?:jats:)?title[^>]*>(.*?)</(?:jats:)?title>", re.I | re.S)


def _clean_abstract(text: str, *, unwrap: bool = False) -> str:
    """Make an incoming abstract readable plain text — the one cleaner every
    path an abstract enters must pass. CrossRef serves JATS XML
    (`<jats:title>Abstract</jats:title><jats:p>…`, `<jats:sup>`); convert
    sup/sub to ^x/_x, drop the boilerplate "Abstract" heading (keep real
    section headings as "Heading: "), strip remaining tags, unescape entities,
    collapse whitespace. Soft hyphens and no-break spaces (copy-paste
    artifacts) are normalized on every path. With `unwrap` (for text pasted
    from web pages/PDFs) hard-wrapped lines are unwrapped — single newlines
    become spaces, blank-line paragraph breaks are kept. Markup-free API text
    (arXiv summaries) otherwise passes through verbatim. Cleans *incoming*
    text only; abstracts already stored in a library are never rewritten."""
    if not text:
        return text
    text = text.replace("\u00ad", "")  # soft hyphen: a line-break artifact
    if _ABS_TAG.search(text):
        text = _SUP.sub(r"^\1", text)
        text = _SUB.sub(r"_\1", text)
        text = _TITLE.sub(
            lambda m: "" if _squash(m.group(1)).casefold() == "abstract"
            else f"{_squash(m.group(1))}: ", text)
        text = re.sub(r"<[^>]+>", " ", text)
        return _squash(html.unescape(text))
    text = text.replace("\u00a0", " ")  # no-break space -> plain space
    if unwrap:
        paras = [_squash(p) for p in re.split(r"\n\s*\n", text)]
        text = "\n\n".join(p for p in paras if p)
    return text


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
        "abstractNote": _clean_abstract(
            (entry.findtext(f"{_ATOM}summary", "") or "").strip("\n ")),
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


# ---------- version-of-record predicate (single source of truth) ----------
# "Is this DOI evidence of journal publication?" is answered here and only
# here — create --arxiv and enrich --rebuild-record both go through these two
# layers; never re-derive the answer in a caller.

# Layer 1: DOI prefixes minted by preprint repositories for their own
# postings. Such a DOI registers the preprint itself and is never evidence
# of journal publication.
REPOSITORY_DOI_PREFIXES = (
    "10.48550/",  # arXiv (DataCite)
    "10.2139/",   # SSRN
    "10.1101/",   # bioRxiv / medRxiv
    "10.21203/",  # Research Square
    "10.31219/",  # OSF Preprints
    "10.26434/",  # ChemRxiv
    "10.36227/",  # TechRxiv
    "10.20944/",  # Preprints.org
)

# Layer 2: pseudo-journal container titles repositories use when they
# register with CrossRef (SSRN files working papers as type=journal-article
# in this fake "journal", which defeats the type check alone).
_REPOSITORY_CONTAINERS = {"ssrn electronic journal"}


def is_repository_doi(doi: str) -> bool:
    """Layer 1: True if the DOI's prefix belongs to a preprint repository."""
    doi = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:)", "", (doi or "").strip(),
                 flags=re.IGNORECASE).lower()
    return doi.startswith(tuple(p.lower() for p in REPOSITORY_DOI_PREFIXES))


def repository_record_reason(item: dict) -> str | None:
    """Layer 2: reason string if a fetched DOI record is a repository
    posting in disguise, or a data/code deposit (so NOT a version of
    record), None if genuine."""
    if item.get("itemType") == "preprint":
        return "the record's type is a preprint (a repository posting)"
    if item.get("itemType") in ("dataset", "computerProgram"):
        # a DataCite DOI can name the paper's data or code deposit
        return f"the DOI names a {item['itemType']} record, not a publication"
    for field in _CONTAINER_FIELD.values():
        container = _squash(item.get(field, ""))
        if container.casefold() in _REPOSITORY_CONTAINERS:
            return f'container "{container}" is a repository pseudo-journal'
    return None


class NotVersionOfRecord(MetadataError):
    """The DOI resolved, but to a repository record, not a journal one."""


def _journal_record(pre: dict, aid: str) -> dict:
    """Version-of-record upgrade: the arXiv record carries a journal DOI, so
    build the item from CrossRef instead (venue/volume/pages/formal date),
    keeping the arXiv identity: abstract fallback when CrossRef has none,
    `arXiv: <id>` in Extra, and the open-access abs page as url (the journal
    link is carried by the DOI field). Raises NotVersionOfRecord when the DOI
    resolves to a repository record in disguise, MetadataError on lookup
    failure — either way the caller falls back to the preprint record."""
    j = fetch_doi(pre["DOI"])
    reason = repository_record_reason(j)
    if reason:
        raise NotVersionOfRecord(reason)
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

    Version of record: when arXiv reports a journal DOI (per the two-layer
    predicate above — not a repository-prefix DOI, and not resolving to a
    repository record in disguise) the item is rebuilt from CrossRef ("note"
    key says so); a repository record keeps the preprint with an explanatory
    "note"; a failed lookup keeps the preprint with a "warning" key.

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
            if not is_repository_doi(doi):
                try:
                    c["item"] = _journal_record(c["item"], c["id"])
                    c["note"] = (f"{c['id']} → journal DOI {doi}, "
                                 "building journal record")
                except NotVersionOfRecord as e:
                    c["note"] = (f"{c['id']}: DOI {doi} is not a version of "
                                 f"record ({e}) — keeping preprint record")
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


def download_pdf(url: str, dest, *, retry: bool = True) -> None:
    """Download a PDF to `dest`, refusing anything that isn't actually a PDF
    (a bot wall or login page answers 200 with HTML)."""
    r = _get(url, retry=retry)
    if r.status_code != 200:
        raise MetadataError(f"PDF download failed: HTTP {r.status_code} from {url}")
    if not r.content.startswith(b"%PDF"):
        raise MetadataError(f"{url} did not return a PDF "
                            f"(got {r.headers.get('content-type', 'unknown type')})")
    with open(dest, "wb") as f:
        f.write(r.content)


# ---------- open-access PDFs (Unpaywall) ----------
# Only Unpaywall's best_oa_location, only its direct PDF link, one attempt.
# The caller stops all further downloads at the first refusal (owner's rule):
# no retry, no other location, no landing-page scraping, no browser UA.

def oa_location(doi: str) -> dict:
    """→ {"url", "host", "license", "host_type", "version"} for the DOI's best
    open-access PDF, or {"none": why} when there is no legal OA PDF to get."""
    r = _get(f"https://api.unpaywall.org/v2/{quote(doi, safe='/')}",
             params={"email": MAILTO})
    if r.status_code == 422:
        raise MetadataError("Unpaywall wants a real contact address — set "
                            "ZOTKIT_MAILTO to your email")
    if r.status_code == 404:
        return {"none": "Unpaywall has no record of this DOI"}
    if r.status_code != 200:
        raise MetadataError(f"Unpaywall returned HTTP {r.status_code} for '{doi}'")
    j = r.json()
    best = j.get("best_oa_location") or {}
    if not j.get("is_oa") or not best:
        return {"none": "no open-access copy"}
    if not best.get("url_for_pdf"):
        page = best.get("url_for_landing_page") or best.get("url") or "?"
        return {"none": f"the open-access copy is a web page, not a PDF ({page})"}
    return {"url": best["url_for_pdf"], "host": httpx.URL(best["url_for_pdf"]).host,
            "license": best.get("license") or "unknown",
            "host_type": best.get("host_type") or "unknown",
            "version": best.get("version") or "unknown"}


def oa_describe(loc: dict) -> str:
    return f"{loc['license']}, {loc['host_type']}, {loc['version']}"


def oa_extra_line(loc: dict) -> str:
    """The append-only Extra line recording where an attached OA PDF came from."""
    return (f"oa-pdf: {loc['license']} · {loc['host_type']} · {loc['version']} · "
            f"{loc['url']}")


# ---------- CrossRef DOI ----------

def _date_parts(d: dict | None) -> str:
    parts = (d or {}).get("date-parts", [[]])[0]
    if not (parts and parts[0]):
        return ""
    return "-".join(f"{p:02d}" if i else str(p) for i, p in enumerate(parts))


def _crossref_date(msg: dict) -> str:
    for k in ("issued", "published-print", "published-online", "created"):
        if _date_parts(msg.get(k)):
            return _date_parts(msg.get(k))
    return ""


def _crossref_publisher(msg: dict, itype: str) -> str:
    """The value for the type's publisher field. A thesis's university or a
    report's institution is CrossRef's `institution`: its `publisher` there is
    the distributor (OSTI for US lab reports, a university library), so it is
    never used for those two types."""
    if itype in ("thesis", "report"):
        return ((msg.get("institution") or [{}])[0]).get("name", "")
    return msg.get("publisher", "")


def issue_date(msg: dict) -> str:
    """The volume/issue date (print), which can trail the online-first date
    that `date` gets: the citation year. '' when CrossRef has none."""
    return (_date_parts((msg.get("journal-issue") or {}).get("published-print"))
            or _date_parts(msg.get("published-print")))


# item types that get an `issue-date:` Extra line (never preprints)
ISSUE_DATE_TYPES = ("journalArticle", "conferencePaper")


_ARXIV_DOI = re.compile(r"^10\.48550/arxiv\.(.+)$", re.IGNORECASE)


def fetch_doi(doi: str) -> dict:
    """DOI → item dict: CrossRef's works API, or DataCite's when CrossRef has
    no record (theses, datasets, software, repository records). Unknown work
    types are an error. arXiv's own DataCite DOIs are refused: the arXiv path
    builds the better record (and does the version-of-record upgrade)."""
    doi = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:)", "", doi.strip(), flags=re.IGNORECASE)
    m = _ARXIV_DOI.match(doi)
    if m:
        raise MetadataError(f"'{doi}' is arXiv's DOI for a preprint — use "
                            f"create --arxiv {m.group(1)}")
    r = _get(f"https://api.crossref.org/works/{quote(doi, safe='')}")
    if r.status_code == 404:
        return fetch_datacite(doi)
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
        if ztype == "editor" and itype in _NO_EDITOR:
            continue
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
        "abstractNote": _clean_abstract(msg.get("abstract", "")),
        "date": _crossref_date(msg),
        "DOI": doi,
        "url": msg.get("URL") or f"https://doi.org/{doi}",
        "volume": msg.get("volume", ""),
        "issue": msg.get("issue", ""),
        "pages": msg.get("page") or msg.get("article-number", ""),
        _PUBLISHER_FIELD.get(itype, "publisher"): _squash(_crossref_publisher(msg, itype)),
        "language": msg.get("language", ""),
        "ISSN": (msg.get("ISSN") or [""])[0],
        "ISBN": (msg.get("ISBN") or [""])[0],
        "journalAbbreviation": _squash((msg.get("short-container-title") or [""])[0]),
        "libraryCatalog": "CrossRef",
    }
    container = _squash((msg.get("container-title") or [""])[0])
    if container:
        item[_CONTAINER_FIELD.get(itype, "publicationTitle")] = container
    if itype == "journalArticle":
        # a registered ISO 4 form (zotkit.journals) overrides CrossRef's short
        # title, which is undotted for some publishers and the full title or
        # empty for others; an unregistered candidate only fills an empty one
        abbr = journals.normalise(container)
        if abbr and (abbr.source == journals.REGISTERED
                     or not item["journalAbbreviation"]):
            item["journalAbbreviation"] = abbr.value
    if not item["title"]:
        raise MetadataError(f"CrossRef record for '{doi}' has no title — refusing to "
                            "create an empty item")
    item = {k: v for k, v in item.items() if v not in ("", [])}
    if item.get("abstractNote"):
        _add_extra(item, "abstract-source: crossref")
    issued = issue_date(msg)
    if (itype in ISSUE_DATE_TYPES and issued
            and issued[:4] != item.get("date", "")[:4]):
        _add_extra(item, f"issue-date: {issued}")
    return item


# ---------- DataCite DOI ----------

def _datacite_type(types: dict) -> str | None:
    general = types.get("resourceTypeGeneral", "")
    if general == "Text" and re.search(r"\b(?:thesis|dissertation)\b",
                                       types.get("resourceType") or "", re.I):
        return "thesis"
    return DATACITE_TYPES.get(general)


def _datacite_creator(c: dict, ctype: str) -> dict:
    if c.get("familyName"):
        return {"creatorType": ctype, "firstName": _squash(c.get("givenName", "")),
                "lastName": _squash(c["familyName"])}
    name = _squash(c.get("name", ""))
    if c.get("nameType") == "Personal" and ", " in name:
        last, first = name.split(", ", 1)
        return {"creatorType": ctype, "firstName": first, "lastName": last}
    return {"creatorType": ctype, "name": name}


def fetch_datacite(doi: str) -> dict:
    """DataCite REST API → item dict, same shape as fetch_doi's CrossRef
    record. Called by fetch_doi when CrossRef has no record."""
    r = _get(f"https://api.datacite.org/dois/{quote(doi, safe='')}")
    if r.status_code == 404:
        raise MetadataError(f"DOI '{doi}' is not in CrossRef or DataCite — check the "
                            "DOI, or create this item via --file")
    if r.status_code != 200:
        raise MetadataError(f"DataCite API returned HTTP {r.status_code} for '{doi}'")
    a = r.json()["data"]["attributes"]

    types = a.get("types") or {}
    itype = _datacite_type(types)
    if not itype:
        raise MetadataError(
            f"DataCite type '{types.get('resourceTypeGeneral', '')}' has no zotkit "
            "mapping — supported: " + ", ".join(sorted(DATACITE_TYPES))
            + ". Create this item via --file instead.")

    primary = _PRIMARY_CREATOR.get(itype, "author")
    creators = [_datacite_creator(c, primary) for c in a.get("creators") or []
                if c.get("familyName") or c.get("name")]
    if itype not in _NO_EDITOR:
        creators += [_datacite_creator(c, "editor") for c in a.get("contributors") or []
                     if c.get("contributorType") == "Editor"
                     and (c.get("familyName") or c.get("name"))]

    titles = a.get("titles") or []
    main = next((t for t in titles if not t.get("titleType")), titles[0] if titles else {})
    title = _squash(main.get("title", ""))
    subtitle = _squash(next((t.get("title", "") for t in titles
                             if t.get("titleType") == "Subtitle"), ""))
    if subtitle and subtitle.lower() not in title.lower():
        title = f"{title}: {subtitle}"

    abstract = next((d.get("description", "") for d in a.get("descriptions") or []
                     if d.get("descriptionType") == "Abstract"), "")
    # "Issued" is the publication date; others ("Available": when a scan went
    # online) can be decades later, so fall back to publicationYear, not them
    date = next((d.get("date", "") for d in a.get("dates") or []
                 if d.get("dateType") == "Issued"), "") or str(a.get("publicationYear") or "")

    publisher = a.get("publisher") or ""
    if isinstance(publisher, dict):          # the API's publisher=true form
        publisher = publisher.get("name", "")
    if itype == "thesis":
        # the degree-granting institution, when the record names it; the
        # publisher can be a research group or a repository
        host = next((c.get("name", "") for c in a.get("contributors") or []
                     if c.get("contributorType") == "HostingInstitution"), "")
        publisher = host or publisher

    container = a.get("container") or {}
    pages = "-".join(p for p in (container.get("firstPage", ""),
                                 container.get("lastPage", "")) if p)
    item = {
        "itemType": itype,
        "title": title,
        "creators": creators,
        "abstractNote": _clean_abstract(abstract),
        "date": date,
        "DOI": doi,
        "url": a.get("url") or f"https://doi.org/{doi}",
        "volume": container.get("volume", ""),
        "issue": container.get("issue", ""),
        "pages": pages,
        _PUBLISHER_FIELD.get(itype, "publisher"): _squash(publisher),
        # only types that have the field (a thesis's "Final" is no version)
        "versionNumber": (a.get("version") or "") if itype in _VERSIONED else "",
        "language": a.get("language") or "",
        "libraryCatalog": "DataCite",
    }
    ctitle = _squash(container.get("title", ""))
    if ctitle:
        item[_CONTAINER_FIELD.get(itype, "publicationTitle")] = ctitle
    if itype == "journalArticle":
        abbr = journals.normalise(ctitle)
        if abbr:
            item["journalAbbreviation"] = abbr.value
    if not item["title"]:
        raise MetadataError(f"DataCite record for '{doi}' has no title — refusing to "
                            "create an empty item")
    item = {k: v for k, v in item.items() if v not in ("", [])}
    if item.get("abstractNote"):
        _add_extra(item, "abstract-source: datacite")
    return item
