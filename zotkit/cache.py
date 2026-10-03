"""zotkit.cache — local mirror of whole-library listings, kept fresh by version map.

`find`, `audit`, and `create`'s dedup all need every top-level item, and on a
slow link to api.zotero.org that download is the whole cost: item JSON runs
about 0.5 MB per 100 items, regardless of paging or parallelism. Most calls
see an unchanged library, so this module keeps the last listing on disk and
reconciles it against the server before every use:

1. One request for the listing's `format=versions` map (key -> version). It is
   tiny and complete: it names every item the server has right now.
2. Items whose cached version differs, or that aren't cached yet, are
   re-fetched by key. Keys the map no longer names (deleted or moved under a
   parent) are dropped.

So a cached answer is exactly as complete as a fresh one. That matters because
callers treat a zero-hit `find` as "not in the library". There is no TTL and
no "maybe stale" mode. If the cache is unreadable or corrupt, the listing is
fetched in full. If the version map can't be fetched, the call fails just as
an uncached one would.

Location: $XDG_CACHE_HOME/zotkit (default ~/.cache/zotkit), or
%LOCALAPPDATA%\\zotkit on Windows, one directory per library. It holds the same
item JSON the Web API returns (abstracts included). Set ZOTKIT_CACHE=0 to
disable it: every listing is then fetched in full and nothing is written.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable, Iterable

FORMAT = 1
KEY_CHUNK = 50  # the Web API's maximum for itemKey=/collectionKey=


def cache_root() -> Path | None:
    """The cache directory, or None when ZOTKIT_CACHE=0 disables caching."""
    if os.environ.get("ZOTKIT_CACHE", "").strip() == "0":
        return None
    if os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        return Path(os.environ["LOCALAPPDATA"]) / "zotkit"
    base = os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache"
    return Path(base) / "zotkit"


def _load(path: Path) -> dict[str, dict] | None:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        if doc.get("format") != FORMAT:
            return None
        return {it["key"]: it for it in doc["items"]}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def _save(path: Path, items: list[dict]) -> None:
    """Atomic write: concurrent zotkit processes may share this file, and a
    reader must never see half of it. Failure to write is not an error — the
    next call just fetches again."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps({"format": FORMAT, "items": items},
                                  ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass


def _chunks(keys: list[str], n: int) -> Iterable[list[str]]:
    for i in range(0, len(keys), n):
        yield keys[i:i + n]


def sync_listing(path: Path | None,
                 versions: Callable[[], dict[str, int]],
                 fetch_all: Callable[[], list[dict]],
                 fetch_keys: Callable[[list[str]], list[dict]] | None) -> list[dict]:
    """Return the full listing, served from `path` where the server's version
    map says the cached copy is current.

    `versions()` -> {key: version} for every item in the listing, in listing
    order. `fetch_all()` -> the full listing. `fetch_keys(keys)` -> those items
    (at most KEY_CHUNK keys per call). With `fetch_keys=None`, any change
    re-fetches the whole listing (for small listings like collections).
    `path=None` means caching is off: a plain `fetch_all()`.
    """
    if path is None:
        return fetch_all()
    cached = _load(path)
    if cached is None:
        items = fetch_all()
        _save(path, items)
        return items
    vmap = versions()
    stale = [k for k, v in vmap.items() if cached.get(k, {}).get("version") != v]
    if stale:
        if fetch_keys is None:
            items = fetch_all()
            _save(path, items)
            return items
        for k in stale:  # an old copy must never outlive a failed re-fetch
            cached.pop(k, None)
        for chunk in _chunks(stale, KEY_CHUNK):
            for it in fetch_keys(chunk):
                cached[it["key"]] = it
    # Listing order follows the version map; a stale key that came back empty
    # was deleted between the two requests, so it drops out here too.
    items = [cached[k] for k in vmap if k in cached]
    if stale or len(items) != len(cached):
        _save(path, items)
    return items
