"""zotkit.export — BibTeX export keyed by Zotero item key.

Zotero's own BibTeX export invents author-year cite keys ("smith2019climate").
Those don't join against anything: the identity of an item in this toolchain is
its 8-character Zotero item key, which is what `find`/`audit`/`enrich` print and
what a manifest lists. So every entry this module emits has its cite key
rewritten to the item key — always, no flag. The rest of the entry is left
byte-for-byte as the Zotero server produced it.

The raw BibTeX comes from the Web API (`?format=bibtex`) over httpx rather than
through pyzotero's bibtex path, which parses and re-serialises the entries via
bibtexparser (an extra dependency, and it reflows the output).
"""
from __future__ import annotations

import re
import sys

import httpx

API_ROOT = "https://api.zotero.org"

# The entry header: optional leading whitespace, @type{, cite key, comma.
_HEADER_RE = re.compile(r"^(\s*@\w+\s*\{)([^,]*)(,)")


class ExportError(RuntimeError):
    """Raised when an item's BibTeX could not be fetched."""


def _rekey(entry: str, key: str) -> str:
    """Return `entry` with the cite key of its first `@type{citekey,` header
    replaced by `key`. Everything else — including any later '@' inside field
    values — is untouched. Input that has no such header is returned as-is."""
    return _HEADER_RE.sub(lambda m: m.group(1) + key + m.group(3), entry, count=1)


def fetch_bibtex(zot, key: str, *, timeout: float = 30.0) -> str:
    """Fetch one item's BibTeX from the Zotero Web API. Raises ExportError
    (naming the key) on 404 or any other non-200 response."""
    lib_id = zot.env["ZOTERO_LIBRARY_ID"]
    lib_type = zot.env.get("ZOTERO_LIBRARY_TYPE", "user")
    url = f"{API_ROOT}/{lib_type}s/{lib_id}/items/{key}"
    r = httpx.get(url, params={"format": "bibtex"},
                  headers={"Zotero-API-Key": zot.env["ZOTERO_API_KEY"],
                           "Zotero-API-Version": "3"},
                  timeout=timeout)
    if r.status_code == 404:
        raise ExportError(f"no item with key '{key}' in this library")
    if r.status_code != 200:
        raise ExportError(f"{key}: Zotero API returned {r.status_code}")
    return r.text


def export_bibtex(zot, keys) -> tuple[str, list[str]]:
    """Return (bibtex text, failed keys) for `keys`, in the given order.

    Each entry's cite key is rewritten to the Zotero item key. Keys that could
    not be fetched are skipped and returned in the second element; the caller
    decides the exit status."""
    entries: list[str] = []
    failed: list[str] = []
    for key in keys:
        try:
            raw = fetch_bibtex(zot, key)
        except ExportError as e:
            failed.append(key)
            print(f"error: {e}", file=sys.stderr)
            continue
        entry = _rekey(raw.strip(), key)
        if entry:
            entries.append(entry)
    return ("\n\n".join(entries) + "\n") if entries else "", failed
