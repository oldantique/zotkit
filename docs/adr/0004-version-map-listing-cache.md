# Whole-library listings are cached locally and reconciled by version map

Status: accepted (2026-10-03)

`find`, `audit`, and `create`'s dedup each walk every top-level item, and `find`
filters client-side on purpose: server-side `q=` search has unreliable index
coverage, and a zero-hit `find` is used to conclude "not in the library". The
cost of that design turned out to be transfer, not request count. Item JSON is
about 0.5 MB per 100 items. Requests were already 100 per page and gzipped, and
fetching pages in parallel made things slower. On a slow link to
api.zotero.org, a few hundred items took 10–20 s per call. Agents that looped
`find --any <author>` over a reading list hit 2-minute tool timeouts.

Decision: keep the last listing on disk and reconcile it before every use.
First, one request for the listing's `format=versions` map. That map is a
complete key → version index of the library as it stands, and it is tiny.
Then re-fetch, by key, only the items whose version moved, and drop keys the
map no longer names. Implementation: `zotkit/cache.py` (`sync_listing`, pure
and offline-tested), reached only through `Zot.listing(kind)` for "top",
"attachments", and "collections".

Why this shape:

- **Completeness is not traded for speed.** There is no TTL and no "possibly
  stale" mode. Every answer is reconciled against the server's current version
  map, so a cached zero hit is as trustworthy as a fresh one. If the map can't
  be fetched, the call fails as an uncached one would. It does not silently
  serve the old copy.
- **Corruption and races degrade to a full fetch, never to a wrong answer.**
  Writes are atomic (temp file + `os.replace`), because parallel agents share
  the file. An unreadable or foreign-format file is treated as no cache. A
  stale key whose re-fetch comes back empty is dropped, not kept at its old
  version.
- **One seam.** Callers ask for `zot.listing("top")` instead of calling
  `everything(top())`. There is one place to reason about freshness, and one
  fake for tests.

Rejected: a time-based cache, which would break the zero-hit guarantee.
Server-side search, which is unreliable coverage (see README). Parallel page
fetches, which were measured slower. `If-Modified-Since-Version` on the full
listing alone, which fixes only the unchanged-library case: one edit would
still cost the whole download.

Consequences: the cache directory (`$XDG_CACHE_HOME/zotkit`, `~/.cache/zotkit`,
or `%LOCALAPPDATA%\zotkit`) holds the library's item JSON, abstracts included.
`ZOTKIT_CACHE=0` turns it off. A cold run costs one extra small request on top
of the old full download. A warm run on an unchanged library costs one
versions request per listing. `backup` deliberately stays uncached: a backup
reads the server.
