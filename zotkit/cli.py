"""zotkit — CLI over zotkit.core.Zot.

Subcommands: doctor, find, show, create, enrich, abstract, audit, attach, fetch,
tag, status, move, backup, lint.
Write commands print what they did; `create` is dry-run unless --apply.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .core import Zot, dedup_maps, duplicate_key, lint_tags, load_conventions, load_env


def dup_notice(d, doi_map, title_map) -> str | None:
    """Dry-run warning for an item `create --apply` would skip, else None."""
    key = duplicate_key(d, doi_map, title_map)
    if key is None:
        return None
    return (f"!! already in library as {key or '?'} — --apply will skip it "
            "(use --no-dedup to force)")


def _print_items(rows):
    for r in rows:
        print(f"{r['key']}  [{r['itemType']}]  {r['title'][:75]}")
        print(f"    collections: {r['collections']}")
        print(f"    tags: {r['tags']}")
    print(f"\n{len(rows)} match(es)")


def _inside_git_worktree(start: Path) -> bool:
    """True if `start` or any ancestor holds a `.git` entry.

    `.git` may be a directory (normal clone) or a file (linked worktree or
    submodule) — both count. Pure filesystem walk, no subprocess, so it stays
    trivially testable offline.
    """
    try:
        here = Path(start).resolve()
    except OSError:
        return False
    for d in (here, *here.parents):
        if (d / ".git").exists():
            return True
    return False


_FETCH_REPO_WARNING = (
    "warning: --out not given, so files go to ./downloads — and the current "
    "directory is inside a git repository.\n"
    "  Loose PDF copies committed into a repo break a library-of-record setup "
    "(the library is the one place a file lives).\n"
    "  Pass an explicit destination outside the repo, e.g. "
    "--out \"$(mktemp -d)\"."
)


def _fetch_out_dir(out, cwd: Path) -> str:
    """Resolve `fetch --out`, warning when the implicit default lands in a repo."""
    if out is not None:
        return out
    if _inside_git_worktree(cwd):
        print(_FETCH_REPO_WARNING, file=sys.stderr)
    return "downloads"


def _first_author(d: dict) -> str:
    for c in d.get("creators") or []:
        name = (c.get("lastName") or c.get("name") or "").strip()
        if name:
            return name
    return ""


def _year(d: dict) -> str:
    date = str(d.get("date") or "").strip()
    return date[:4] if date[:4].isdigit() else ""


def _identifier(d: dict) -> str:
    doi = (d.get("DOI") or "").strip()
    if doi:
        return doi
    from .enrich import _find_arxiv_id
    aid = _find_arxiv_id(d)
    return f"arXiv:{aid}" if aid else "—"


def _show(zot, keys, as_json: bool) -> int:
    """One line per key (or --json dumps of the full item data). Bad keys are
    reported to stderr and don't stop the rest; exit 1 if any key failed."""
    failed = 0
    datas = []
    for key in keys:
        try:
            item = zot.z.item(key)
            d = item["data"]
        except Exception as e:
            failed += 1
            print(f"error: {key}: {e}", file=sys.stderr)
            continue
        if as_json:
            datas.append(d)
            continue
        who = " ".join(x for x in (_first_author(d), _year(d)) if x)
        title = str(d.get("title") or "")
        if len(title) > 60:
            title = title[:59] + "…"
        print(f"{key} · {d.get('itemType', '')} · {who} · {title} · "
              f"{_identifier(d)}")
    if as_json:
        print(json.dumps(datas, ensure_ascii=False, indent=2))
    return 1 if failed else 0


def _doctor() -> int:
    """Validate the whole setup; each failing check explains how to fix it."""
    import httpx
    from urllib.parse import urlsplit
    print(f"zotkit {__version__}")
    try:
        env = load_env()
    except FileNotFoundError as e:
        print(f"✗ config: {e}")
        return 1
    print(f"✓ config: {env['_env_path']}")
    conv = load_conventions()
    print(f"✓ conventions: {'enforced' if conv else 'none configured (tags unrestricted)'}")
    try:
        z = Zot()
        access = z.z.key_info().get("access", {}).get("user", {})
        n = z.z.count_items()
        print(f"✓ Zotero API: library {env['ZOTERO_LIBRARY_ID']} reachable, {n} items, "
              f"write access: {bool(access.get('write'))}")
    except Exception as e:
        print(f"✗ Zotero API: {e}\n  check ZOTERO_LIBRARY_ID (numeric userID) and "
              f"ZOTERO_API_KEY at https://www.zotero.org/settings/keys")
        return 1
    if "WEBDAV_URL" in env:
        base, auth = z._webdav()
        host = urlsplit(base).netloc
        try:
            with httpx.Client(auth=auth, timeout=30) as c:
                r1 = c.put(f"{base}/zotkit-doctor-probe.txt", content=b"zotkit doctor probe")
                c.delete(f"{base}/zotkit-doctor-probe.txt")
            if r1.status_code in (200, 201, 204):
                print(f"✓ WebDAV: {host} writable — attachments use WebDAV")
            else:
                print(f"✗ WebDAV: PUT returned {r1.status_code} — check credentials and "
                      f"that WEBDAV_URL ends with /zotero/")
                return 1
        except Exception as e:
            print(f"✗ WebDAV: {e}")
            return 1
    else:
        print("✓ attachments: Zotero Storage mode (no WEBDAV_* configured)")
    print("all good ✓")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="zotkit", description="Headless Zotero library CLI")
    ap.add_argument("--version", action="version", version=f"zotkit {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("doctor", help="validate setup: config, API access, attachment storage")

    p = sub.add_parser("find", help="search items by title/tag/collection")
    p.add_argument("--title"); p.add_argument("--tag"); p.add_argument("--collection")

    p = sub.add_parser("show", help="one-line summary per item key (read-only)")
    p.add_argument("keys", nargs="+", metavar="KEY")
    p.add_argument("--json", action="store_true",
                   help="dump the full item data instead of one-liners")

    p = sub.add_parser("create", help="create items from a JSON file, an arXiv id, "
                                      "or a DOI (dry unless --apply)")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--file")
    src.add_argument("--arxiv", metavar="ID_OR_URL", nargs="+",
                     help="arXiv ids (2401.12345) or abs/pdf URLs — several allowed, "
                          "space- or comma-separated; fetches metadata in one batched "
                          "request, and with --apply also downloads + attaches the PDFs")
    src.add_argument("--doi", metavar="DOI", nargs="+",
                     help="DOIs (or doi.org URLs) — several allowed, space- or "
                          "comma-separated; fetches metadata from CrossRef")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--no-dedup", action="store_true")
    p.add_argument("--loose-tags", action="store_true", help="warn instead of error on tag violations")
    p.add_argument("--no-pdf", action="store_true",
                   help="with --arxiv --apply: skip downloading/attaching the PDF")
    p.add_argument("--collection", help="with --arxiv/--doi: file the item here")
    p.add_argument("--tags", help="with --arxiv/--doi: comma-separated tags, "
                                  "e.g. field:ml,status:to-read")

    p = sub.add_parser("enrich", help="fill missing fields on existing items from "
                                      "arXiv/CrossRef, in place — the item key never "
                                      "changes (dry unless --apply)")
    which = p.add_mutually_exclusive_group(required=True)
    which.add_argument("--key", nargs="+", metavar="KEY")
    which.add_argument("--all", action="store_true",
                       help="every top-level scholarly item")
    which.add_argument("--missing", action="append", choices=["abstract", "doi"],
                       metavar="{abstract,doi}",
                       help="items missing this (repeatable; union)")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--rebuild-record", action="store_true",
                   help="also upgrade preprint items with a journal DOI to the "
                        "journal record, in place (version of record)")

    p = sub.add_parser("abstract", help="set/replace one item's abstract with "
                                        "provenance (owner's tool — may replace "
                                        "with --force)")
    p.add_argument("--key", required=True)
    p.add_argument("--source", required=True, metavar="SLUG",
                   help="where the text came from: cnki, ssrn, publisher, "
                        "manual (= user-written), … — any lowercase slug")
    p.add_argument("--file", help="read the abstract from this file "
                                  "(default: stdin)")
    p.add_argument("--force", action="store_true",
                   help="replace an existing abstract and its "
                        "abstract-source stamp")

    p = sub.add_parser("audit", help="read-only health report: missing "
                                     "abstracts/identifiers/PDFs, "
                                     "abstract-source stamp hygiene")
    p.add_argument("--json", action="store_true", help="machine-readable output")

    p = sub.add_parser("attach", help="attach a local file to an item (WebDAV or Zotero Storage)")
    p.add_argument("--key"); p.add_argument("--pdf")
    p.add_argument("--from", dest="src", help="a .created.json list (batch)")
    p.add_argument("--all", action="store_true")

    p = sub.add_parser("fetch", help="download attachment files (WebDAV or Zotero Storage)")
    p.add_argument("--key"); p.add_argument("--title"); p.add_argument("--collection")
    p.add_argument("--out", default=None,
                   help="destination directory (default: ./downloads, relative "
                        "to the current directory) — pass an explicit path to "
                        "keep downloads out of a code repo")

    p = sub.add_parser("tag", help="add/remove tags on an item")
    p.add_argument("key"); p.add_argument("tags", nargs="+")
    p.add_argument("--rm", action="store_true", help="remove instead of add")

    p = sub.add_parser("status", help="set reading status (replaces the status: tag)")
    p.add_argument("key"); p.add_argument("value", help="e.g. to-read / reading / read")

    p = sub.add_parser("move", help="move item to a collection (name or 'Parent :: Child')")
    p.add_argument("key"); p.add_argument("collection")
    p.add_argument("--add", action="store_true", help="add as extra home instead of replacing")

    sub.add_parser("backup", help="full JSON backup to backups/ next to your .env")

    p = sub.add_parser("lint", help="check tags against conventions.toml (no API calls)")
    p.add_argument("tags", nargs="+")

    a = ap.parse_args(argv)

    if a.cmd == "doctor":
        return _doctor()

    if a.cmd == "lint":
        conv = load_conventions()
        if conv is None:
            print("no conventions configured — add a conventions.toml next to your .env "
                  "(see README); nothing to check")
            return 0
        problems = lint_tags(a.tags, conventions=conv, auto_load=False)
        print("\n".join(problems) if problems else "OK")
        return 1 if problems else 0

    zot = Zot()

    if a.cmd == "find":
        _print_items(zot.find(a.title, a.tag, a.collection))

    elif a.cmd == "show":
        return _show(zot, a.keys, a.json)

    elif a.cmd == "create":
        pdfs: dict[str, tuple[str, str]] = {}  # title -> (arXiv id, pdf url)
        failures: list[tuple[str, str]] = []   # (identifier, why)
        if a.file:
            data = json.load(open(a.file, encoding="utf-8"))
            items = data["items"] if isinstance(data, dict) else data
        else:
            from .metadata import MetadataError, fetch_arxiv_batch, fetch_doi
            wanted = [w.strip() for arg in (a.arxiv or a.doi)
                      for w in arg.split(",") if w.strip()]
            items = []
            try:
                if a.arxiv:
                    for r in fetch_arxiv_batch(wanted):
                        if r.get("error"):
                            failures.append((r["id"], r["error"]))
                            continue
                        if r.get("note"):  # version-of-record upgrade happened
                            print(r["note"])
                        if r.get("warning"):
                            print(f"warning: {r['warning']}", file=sys.stderr)
                        items.append(r["item"])
                        pdfs[r["item"]["title"]] = (r["id"], r["pdf_url"])
                else:
                    for d in wanted:
                        try:
                            items.append(fetch_doi(d))
                        except MetadataError as e:
                            failures.append((d, str(e)))
            except MetadataError as e:
                print(f"error: {e}", file=sys.stderr)
                return 1
            for ident, why in failures:
                prefix = f"{ident}: " if len(wanted) > 1 else ""
                print(f"error: {prefix}{why}", file=sys.stderr)
            for item in items:
                if a.collection:
                    item["collection"] = a.collection
                if a.tags:
                    item["tags"] = [t.strip() for t in a.tags.split(",") if t.strip()]
            if not items:
                return 1
        if not a.apply:
            # The dry run is the surface users trust, so it must run the same
            # dedup check --apply will. One library fetch per invocation.
            doi_map, title_map = ({}, {})
            if not a.no_dedup:
                doi_map, title_map = dedup_maps(zot.z.everything(zot.z.top()))
            dups = 0
            for d in items:
                problems = lint_tags(d.get("tags", []), conventions=zot.conventions,
                                     auto_load=False)
                dup = dup_notice(d, doi_map, title_map)
                dups += dup is not None
                if not a.file:  # identifier mode: show the full fetched record
                    print(json.dumps(d, ensure_ascii=False, indent=2))
                    if problems:
                        print("  !! " + "; ".join(problems))
                    if dup:
                        print(f"  {dup}")
                    continue
                flag = ("  !! " + "; ".join(problems)) if problems else ""
                print(f"  [dry] {d.get('collection')} | {d.get('title','')[:60]}{flag}")
                if dup:
                    print(f"       {dup}")
            tail = f", {len(failures)} failed to fetch" if failures else ""
            dup_tail = f", {dups} already in library" if dups else ""
            print(f"{len(items)} item(s){dup_tail}{tail}. DRY — add --apply to create.")
            return 1 if failures else 0
        created = zot.create_items(items, dedup=not a.no_dedup, strict_tags=not a.loose_tags)
        new = [c for c in created if c.get("key")]
        skips = [c for c in created if c.get("skipped")]
        dup = len(created) - len(new)
        dup_keys = [c.get("existing_key") or "?" for c in skips]
        if a.file:
            out = Path(a.file).with_suffix(".created.json")
            json.dump(new, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
            print(f"created {len(new)} (skipped {dup} dup) -> {out}")
            for c in skips:
                print(f"  skipped dup: {str(c.get('title', ''))[:60]} "
                      f"— already in library as {c.get('existing_key') or '?'}")
            if any(c.get("file_path") for c in new):
                print(f"attach PDFs: zotkit attach --from {out} --all")
            return 0
        # identifier mode
        if not new and not failures:
            where = ", ".join(dup_keys) or "?"
            print(f"skipped: an item with this DOI/title already exists as {where} "
                  "(use --no-dedup to force)")
            return 0
        for c in skips:
            print(f"skipped {str(c.get('title', ''))[:60]} — already in library as "
                  f"{c.get('existing_key') or '?'} (use --no-dedup to force)")
        for c in new:
            key = c["key"]
            print(f"created {key}  {str(c.get('title', ''))[:70]}")
            aid_pdf = pdfs.get(c.get("title"))
            if aid_pdf and not a.no_pdf:
                from .metadata import download_pdf
                import tempfile
                aid, pdf_url = aid_pdf
                with tempfile.TemporaryDirectory() as td:
                    pdf = Path(td) / f"arXiv-{aid.replace('/', '_')}.pdf"
                    try:
                        download_pdf(pdf_url, pdf)  # spaced ≥3 s apart by metadata._get
                    except MetadataError as e:
                        failures.append((aid, f"item {key} created, but PDF failed: {e}"))
                        print(f"error: item {key} created, but PDF failed: {e}\n"
                              f"  attach manually: zotkit attach --key {key} --pdf <file>",
                              file=sys.stderr)
                        continue
                    info = zot.attach(key, pdf)
                print(f"attached {info['filename']} ({info['storage']})")
        if a.doi and new:
            hint = new[0]["key"] if len(new) == 1 else "<key>"
            print("no PDF downloaded (publisher PDFs are usually paywalled) — "
                  f"attach one with: zotkit attach --key {hint} --pdf <file>")
        if len(wanted) > 1:
            print(f"batch: created {len(new)}, skipped {dup} dup, failed {len(failures)}")
        return 1 if failures else 0

    elif a.cmd == "enrich":
        from .enrich import apply_plan, plan_enrich
        if a.key:
            keys = a.key
        else:  # --all / --missing: pick the work set from a read-only audit
            from .audit import audit
            rep = audit(zot)
            if a.all:
                keys = rep["keys"]
            else:
                bucket = {"abstract": "missing-abstract", "doi": "missing-identifier"}
                want = {k for m in a.missing for k in rep["buckets"][bucket[m]]}
                keys = [k for k in rep["keys"] if k in want]  # library order
            print(f"selected {len(keys)} item(s) "
                  f"({'all' if a.all else 'missing ' + '/'.join(a.missing)}) — "
                  "rate limiting is internal, no pacing needed")
        counts = {"enriched": 0, "needs-identifier": 0, "stale-stamp": 0,
                  "up-to-date": 0, "failed": 0}
        for key in keys:
            try:
                p_ = plan_enrich(zot, key, rebuild_record=a.rebuild_record)
            except Exception as e:  # bad key, metadata lookup failure, …
                counts["failed"] += 1
                print(f"{key}  FAILED: {e}", file=sys.stderr)
                continue
            print(f"{key}  {p_['title'][:60]}")
            for n in p_["notes"]:
                print(f"    {n}")
            if p_["status"] in ("needs-identifier", "stale-stamp", "up-to-date"):
                if p_["status"] == "up-to-date":
                    print("    up-to-date")
                counts[p_["status"]] += 1
                continue
            if p_["rebuild"]:
                print(f"    rebuild: {p_['item']['data']['itemType']} → "
                      f"{p_['rebuild']} ({p_['auth'].get('DOI', '')})")
            if p_["fills"]:
                shown = [f + (f" (source: {p_['abstract_source']})"
                              if f == "abstractNote" and p_["abstract_source"] else "")
                         for f in p_["fills"]]
                print(f"    will fill: {', '.join(shown)}")
            for line in p_["extra_lines"]:
                print(f"    extra += {line!r}")
            if not a.apply:
                continue
            try:
                apply_plan(zot, p_)
                counts["enriched"] += 1
                print("    enriched ✓")
            except Exception as e:
                counts["failed"] += 1
                print(f"{key}  FAILED to write: {e}", file=sys.stderr)
        if not a.apply:
            print("DRY — add --apply to write.")
        skipped = (counts["needs-identifier"] + counts["stale-stamp"]
                   + counts["up-to-date"])
        print(f"enriched {counts['enriched']} / skipped {skipped} "
              f"(needs-identifier {counts['needs-identifier']}, "
              f"stale-stamp {counts['stale-stamp']}, "
              f"up-to-date {counts['up-to-date']}) / failed {counts['failed']}")
        return 1 if counts["failed"] else 0

    elif a.cmd == "abstract":
        from .enrich import set_abstract
        from .metadata import MetadataError
        if a.file:
            text = open(a.file, encoding="utf-8").read()
        else:
            if sys.stdin.isatty():
                print("paste the abstract, then Ctrl-D:", file=sys.stderr)
            text = sys.stdin.read()
        try:
            r = set_abstract(zot, a.key, text, a.source, force=a.force)
        except MetadataError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        verb = "replaced" if r["replaced"] else "set"
        print(f"{r['key']}  abstract {verb} ({r['chars']} chars, "
              f"source: {a.source})  {r['title'][:55]}")

    elif a.cmd == "audit":
        from .audit import BUCKETS, audit
        rep = audit(zot)
        if a.json:
            print(json.dumps(rep, ensure_ascii=False, indent=2))
        else:
            print(f"audited {rep['total']} top-level scholarly item(s)")
            for b, label in BUCKETS.items():
                ks = rep["buckets"][b]
                print(f"\n{label}: {len(ks)}")
                for i in range(0, len(ks), 8):
                    print("    " + " ".join(ks[i:i + 8]))
            print("\nnext steps: zotkit enrich --missing abstract|doi; "
                  "zotkit abstract --key K --source <slug> for text "
                  "enrich can't fetch")

    elif a.cmd == "attach":
        if a.key and a.pdf:
            print(zot.attach(a.key, a.pdf))
        elif a.src:
            rows = json.load(open(a.src, encoding="utf-8"))
            done = 0
            for m in rows:
                if not m.get("file_path") or not Path(m["file_path"]).exists():
                    print(f"  SKIP no file: {str(m.get('title'))[:55]}"); continue
                if zot.has_attachment(m["key"]):
                    print(f"  SKIP attached: {str(m.get('title'))[:55]}"); continue
                if not a.all and done >= 1:
                    break
                print(f"- {str(m.get('title'))[:60]}")
                zot.attach(m["key"], m["file_path"]); done += 1
            print(f"attached {done}")
        else:
            ap.error("attach needs --key + --pdf, or --from <created.json>")

    elif a.cmd == "fetch":
        out = _fetch_out_dir(a.out, Path.cwd())
        keys = [a.key] if a.key else [r["key"] for r in zot.find(a.title, None, a.collection)]
        n = 0
        for k in keys:
            for p_ in zot.fetch(k, out):
                print(f"  saved: {Path(p_).resolve()}"); n += 1
        print(f"downloaded {n} file(s) to {Path(out).resolve()}")

    elif a.cmd == "tag":
        if a.rm:
            zot.remove_tags(a.key, *a.tags); print(f"removed {a.tags} from {a.key}")
        else:
            zot.add_tags(a.key, *a.tags); print(f"added {a.tags} to {a.key}")

    elif a.cmd == "status":
        zot.set_status(a.key, a.value); print(f"{a.key} -> status:{a.value}")

    elif a.cmd == "move":
        zot.move(a.key, a.collection, add=a.add)
        print(f"{a.key} -> '{a.collection}'{' (added)' if a.add else ''}")

    elif a.cmd == "backup":
        print("backup ->", zot.backup())

    return 0


if __name__ == "__main__":
    sys.exit(main())
