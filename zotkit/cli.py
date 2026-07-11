"""zotkit — CLI over zotkit.core.Zot.

Subcommands: find, create, attach, fetch, tag, status, move, backup, lint.
Write commands print what they did; `create` is dry-run unless --apply.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .core import Zot, lint_tags, load_conventions, load_env


def _print_items(rows):
    for r in rows:
        print(f"{r['key']}  [{r['itemType']}]  {r['title'][:75]}")
        print(f"    collections: {r['collections']}")
        print(f"    tags: {r['tags']}")
    print(f"\n{len(rows)} match(es)")


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

    p = sub.add_parser("create", help="create items from a JSON file (dry unless --apply)")
    p.add_argument("--file", required=True); p.add_argument("--apply", action="store_true")
    p.add_argument("--no-dedup", action="store_true")
    p.add_argument("--loose-tags", action="store_true", help="warn instead of error on tag violations")

    p = sub.add_parser("attach", help="attach a local file (WebDAV) to an item")
    p.add_argument("--key"); p.add_argument("--pdf")
    p.add_argument("--from", dest="src", help="a .created.json list (batch)")
    p.add_argument("--all", action="store_true")

    p = sub.add_parser("fetch", help="download attachment files from WebDAV")
    p.add_argument("--key"); p.add_argument("--title"); p.add_argument("--collection")
    p.add_argument("--out", default="downloads")

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

    elif a.cmd == "create":
        data = json.load(open(a.file, encoding="utf-8"))
        items = data["items"] if isinstance(data, dict) else data
        if not a.apply:
            for d in items:
                problems = lint_tags(d.get("tags", []), conventions=zot.conventions,
                                     auto_load=False)
                flag = ("  !! " + "; ".join(problems)) if problems else ""
                print(f"  [dry] {d.get('collection')} | {d.get('title','')[:60]}{flag}")
            print(f"{len(items)} item(s). DRY — add --apply to create.")
            return 0
        created = zot.create_items(items, dedup=not a.no_dedup, strict_tags=not a.loose_tags)
        new = [c for c in created if c.get("key")]
        out = Path(a.file).with_suffix(".created.json")
        json.dump(new, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"created {len(new)} (skipped {len(created)-len(new)} dup) -> {out}")
        if any(c.get("file_path") for c in new):
            print(f"attach PDFs: zotkit attach --from {out} --all")

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
        keys = [a.key] if a.key else [r["key"] for r in zot.find(a.title, None, a.collection)]
        n = 0
        for k in keys:
            for p_ in zot.fetch(k, a.out):
                print(f"  saved: {p_}"); n += 1
        print(f"downloaded {n} file(s) to {a.out}")

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
