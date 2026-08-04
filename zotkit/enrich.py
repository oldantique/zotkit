"""zotkit.enrich — complete existing items in place from arXiv/CrossRef.

The core invariant: **the item key never changes**. Item keys are referenced by
downstream manifests, so delete-and-recreate is never acceptable; every change
here is an in-place fetch→modify→update carrying the item version (a concurrent
edit fails that one item with 412 instead of clobbering).

Merge policy:
- only empty fields are filled — existing non-empty values are never overwritten
  (exception: --rebuild-record, which deliberately adopts the published title,
  date, and venue when upgrading a preprint to its version of record — and
  upgrades only on a genuine journal DOI per metadata's two-layer
  version-of-record predicate: repository DOIs like SSRN's never qualify);
- creators are extended only when the current list is a same-order prefix of the
  authoritative one (the classic truncated-author-list case); any other
  difference is reported, not touched;
- an `abstract-source:` stamp with no abstract means an owner deliberately
  removed the abstract — never re-add it (reported as NEEDS OWNER);
- Extra only ever gains lines (arXiv: / abstract-source: / Repository:),
  existing lines are never rewritten;
- tags, collections, relations, and child items are never touched.

`set_abstract` (the `zotkit abstract` command) is the owner's deliberate
exception: it may replace an existing abstract and rewrite the stamp line —
but only behind `force`; all other Extra lines keep the append-only rule.

Network requests reuse zotkit.metadata's fetchers and its per-host rate limit.
"""
from __future__ import annotations

import re
import time
from typing import Any

from . import metadata as md

# fields the plain fill pass may write; everything else needs a dedicated rule
_PROTECTED = {"itemType", "title", "creators", "abstractNote", "extra",
              "tags", "collections", "relations",
              "key", "version", "dateAdded", "dateModified"}

_ARXIV_IN_TEXT = re.compile(
    r"arxiv:\s*((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?)",
    re.IGNORECASE)
_STAMP = re.compile(r"^abstract-source:\s*(\w+)", re.IGNORECASE | re.MULTILINE)


def _find_arxiv_id(d: dict) -> str | None:
    """arXiv identity of an item: archiveID, an `arXiv:` Extra line, an
    arxiv.org url, or the id embedded in arXiv's own DataCite DOI."""
    for text in (d.get("archiveID", ""), d.get("extra", "")):
        m = _ARXIV_IN_TEXT.search(text)
        if m:
            return m.group(1)
    if "arxiv.org/" in d.get("url", ""):
        try:
            return md.arxiv_id(d["url"])
        except md.MetadataError:
            pass
    doi = (d.get("DOI") or "").strip()
    if doi.lower().startswith("10.48550/arxiv."):
        return doi[len("10.48550/arxiv."):]
    return None


def _norm(s: str | None) -> str:
    return re.sub(r"\s+", " ", s or "").strip().casefold()


def _same_creator(c: dict, a: dict) -> bool:
    """Loose identity: equal last name plus compatible first name (initials
    match full names), so 'A. Einstein' matches 'Albert Einstein'."""
    if c.get("creatorType") != a.get("creatorType"):
        return False
    if c.get("name") or a.get("name"):
        full = lambda x: _norm(x.get("name")
                               or f"{x.get('firstName', '')} {x.get('lastName', '')}")
        return full(c) == full(a)
    if _norm(c.get("lastName")) != _norm(a.get("lastName")):
        return False
    cf, af = _norm(c.get("firstName")), _norm(a.get("firstName"))
    return not cf or not af or cf[0] == af[0]


def _real_creators(creators: list[dict]) -> list[dict]:
    """Drop all-empty placeholder creators (an untouched item template ships
    one empty author)."""
    return [c for c in creators
            if any(v for k, v in c.items() if k != "creatorType")]


def _fetch_authoritative(d: dict) -> tuple[dict | None, str | None, str | None, str | None]:
    """→ (authoritative record, arXiv id, no-VoR reason, skip reason).
    A journal DOI — per metadata's two-layer version-of-record predicate —
    wins; arXiv otherwise (that fetch itself may upgrade to a journal record
    per v0.4.2 rules — equally welcome here). A repository DOI (SSRN & co.)
    still resolves in CrossRef, so its record is fetched for fill-missing,
    but the no-VoR reason marks it as never being grounds for a rebuild."""
    doi = (d.get("DOI") or "").strip()
    aid = _find_arxiv_id(d)
    if doi and not md.is_repository_doi(doi):
        auth = md.fetch_doi(doi)
        reason = md.repository_record_reason(auth)
        if reason is None:
            # CrossRef abstracts are often absent; borrow arXiv's when we can
            if not auth.get("abstractNote") and aid and not d.get("abstractNote"):
                r = md.fetch_arxiv_batch([aid])[0]
                pre = r.get("item") or {}
                if pre.get("abstractNote"):
                    auth["abstractNote"] = pre["abstractNote"]
                    md._add_extra(auth, "abstract-source: arxiv")
            return auth, aid, None, None
        if not aid:
            return auth, aid, f"DOI {doi}: {reason}", None
        # repository record in disguise but the item has an arXiv identity:
        # fall through — the arXiv record is the better preprint source
    if aid:
        r = md.fetch_arxiv_batch([aid])[0]
        if r.get("error"):
            raise md.MetadataError(r["error"])
        # the arXiv path enforces the predicate itself: r["item"] is a journal
        # record only when the DOI arXiv reports passed both layers
        return r["item"], aid, None, None
    if doi:  # repository-prefix DOI, no arXiv id (the pure-SSRN case)
        auth = md.fetch_doi(doi)
        return auth, aid, f"DOI {doi} is a repository DOI, not a journal one", None
    return None, None, None, "no DOI or arXiv id on the item"


_STAMP_LINE = re.compile(r"^abstract-source:[^\n]*", re.IGNORECASE | re.MULTILINE)
_SLUG = re.compile(r"[a-z][a-z0-9-]*")


def set_abstract(zot, key: str, text: str, source: str, *,
                 force: bool = False) -> dict[str, Any]:
    """Owner's tool: set an item's abstract with provenance, in place (the
    item key never changes). `source` is an open vocabulary of lowercase
    slugs naming where the TEXT came from (cnki, ssrn, publisher, manual, …).

    Unlike enrich this may *replace* — but only with `force`: an existing
    abstract or `abstract-source:` stamp otherwise refuses. With force, the
    abstract and the stamp line are replaced (the stamp is rewritten, not
    appended); every other Extra line is untouched. Returns
    {"key", "title", "chars", "replaced"}."""
    if not _SLUG.fullmatch(source):
        raise md.MetadataError(
            f"--source '{source}' is not a lowercase slug (want e.g. cnki, "
            "ssrn, publisher, manual)")
    text = md._clean_abstract(text or "", unwrap=True)
    if not text:
        raise md.MetadataError("abstract is empty after cleaning — nothing written")
    item = zot.z.item(key)
    d = item["data"]
    if "abstractNote" not in d:
        raise md.MetadataError(
            f"{key} is a {d.get('itemType')} — it has no abstract field")
    old_stamp = _STAMP.search(d.get("extra", ""))
    replacing = bool(d.get("abstractNote") or old_stamp)
    if replacing and not force:
        have = (f"an abstract ({len(d['abstractNote'])} chars)"
                if d.get("abstractNote") else "no abstract")
        stamp = (f"abstract-source: {old_stamp.group(1)}" if old_stamp
                 else "no abstract-source stamp")
        raise md.MetadataError(
            f"{key} already has {have} and {stamp} — pass --force to replace")
    d["abstractNote"] = text
    line = f"abstract-source: {source}"
    if old_stamp:
        d["extra"] = _STAMP_LINE.sub(line, d.get("extra", ""), count=1)
    else:
        md._add_extra(d, line)
    zot.z.update_item(item)
    return {"key": key, "title": d.get("title", ""), "chars": len(text),
            "replaced": replacing}


def plan_enrich(zot, key: str, *, rebuild_record: bool = False) -> dict[str, Any]:
    """Compute what enriching `key` would change. Returns a plan dict:
    status 'plan' (something to do), 'up-to-date', 'needs-identifier',
    'stale-stamp', with fills / creators / extra_lines / rebuild / notes.
    Raises MetadataError (lookup) or pyzotero errors (bad key) — callers
    turn those into per-item failures."""
    item = zot.z.item(key)
    d = item["data"]
    p: dict[str, Any] = {"key": key, "title": d.get("title", ""), "item": item,
                         "fills": {}, "extra_lines": [], "creators": None,
                         "rebuild": None, "notes": [], "abstract_source": None}

    auth, aid, no_vor, skip = _fetch_authoritative(d)
    if auth is None:
        p["status"] = "needs-identifier"
        p["notes"].append(f"SKIP needs-identifier: {skip}")
        return p
    p["auth"], p["aid"], p["no_vor"] = auth, aid, no_vor

    # ---- abstract (stamp rules) ----
    stamped = _STAMP.search(d.get("extra", ""))
    auth_ab_src = (_STAMP.search(auth.get("extra", "")) or [None, None])[1]
    if not d.get("abstractNote"):
        if stamped:
            p["notes"].append("NEEDS OWNER stale-stamp: abstract-source stamp "
                              "present but abstract empty — not re-adding")
            p["stale_stamp"] = True
        elif auth.get("abstractNote"):
            p["fills"]["abstractNote"] = auth["abstractNote"]
            p["abstract_source"] = (auth_ab_src or "").lower() or None
            if p["abstract_source"]:
                p["extra_lines"].append(f"abstract-source: {p['abstract_source']}")

    # ---- plain fields: fill only what's empty ----
    for f, v in auth.items():
        if f in _PROTECTED or not v:
            continue
        if f in d and not d.get(f):
            p["fills"][f] = v
    if not d.get("title") and auth.get("title"):
        p["fills"]["title"] = auth["title"]

    # ---- creators: whole-fill or prefix extension only ----
    cur = _real_creators(d.get("creators", []))
    authc = auth.get("creators", [])
    if authc:
        if not cur:
            p["creators"] = authc
        elif (len(cur) < len(authc)
              and all(_same_creator(c, a) for c, a in zip(cur, authc))):
            p["creators"] = authc
            p["notes"].append(f"creators: {len(cur)} → {len(authc)} "
                              "(authoritative prefix extension)")
        elif not (len(cur) == len(authc)
                  and all(_same_creator(c, a) for c, a in zip(cur, authc))):
            p["notes"].append(f"creators differ from authoritative record "
                              f"({len(cur)} vs {len(authc)}) — left untouched")

    # ---- version-of-record rebuild (explicit opt-in) ----
    if rebuild_record and d.get("itemType") == "preprint":
        if no_vor:
            p["notes"].append(f"no version-of-record upgrade: {no_vor} "
                              "— keeping preprint")
        elif auth.get("itemType") not in (None, "preprint"):
            p["rebuild"] = auth["itemType"]

    # ---- arXiv identity line ----
    if aid:
        # a rebuild drops archiveID (no such field on journal types), so only
        # Extra itself counts as "already recorded" in that case
        known = d.get("extra", "") + ("" if p["rebuild"]
                                      else " " + d.get("archiveID", ""))
        if f"arxiv:{aid.lower()}" not in known.lower().replace(" ", ""):
            p["extra_lines"].append(f"arXiv: {aid}")

    p["status"] = ("plan" if (p["fills"] or p["creators"] is not None
                              or p["extra_lines"] or p["rebuild"])
                   else "stale-stamp" if p.get("stale_stamp")
                   else "up-to-date")
    return p


def apply_plan(zot, p: dict[str, Any]) -> None:
    """Execute a 'plan' plan in place. The item key never changes; the write
    carries the fetched version, so a concurrent edit fails loudly (412)."""
    item, d, auth = p["item"], p["item"]["data"], p.get("auth", {})
    children_before = len(zot.z.children(p["key"])) if p["rebuild"] else None

    if p["rebuild"]:
        tmpl = zot.z.item_template(p["rebuild"])
        old = dict(d)
        keep = {k: old[k] for k in ("key", "version", "dateAdded", "dateModified")
                if k in old}
        new: dict[str, Any] = {}
        for f in tmpl:
            if f in ("tags", "collections", "relations"):
                new[f] = old.get(f, tmpl[f])       # never touched
            elif f == "extra":
                new[f] = old.get("extra", "")
            elif f == "creators":
                new[f] = (p["creators"] if p["creators"] is not None
                          else old.get("creators", []))
            elif f == "abstractNote":  # stale stamp forbids re-adding here too
                new[f] = old.get("abstractNote") or (
                    "" if p.get("stale_stamp") else auth.get("abstractNote", ""))
            else:
                # version of record wins: published title/date/venue over preprint's
                new[f] = auth.get(f) or old.get(f) or tmpl[f]
        if old.get("repository") and not p.get("aid"):
            md._add_extra(new, f"Repository: {old['repository']}")
        d.clear()
        d.update(keep)
        d.update(new)
    else:
        d.update(p["fills"])
        if p["creators"] is not None:
            d["creators"] = p["creators"]

    for line in p["extra_lines"]:
        md._add_extra(d, line)

    zot.z.update_item(item)

    if children_before is not None:
        # the API can serve a stale (empty) children list right after the PUT —
        # tolerate brief read-after-write lag before declaring a real mismatch
        for attempt in range(4):
            children_after = len(zot.z.children(p["key"]))
            if children_after == children_before:
                break
            time.sleep(2)
        if children_after != children_before:
            raise RuntimeError(
                f"child-item count changed during rebuild of {p['key']} "
                f"({children_before} → {children_after}) — investigate before "
                "trusting this item")
