"""zotkit — CLI over zotkit.core.Zot.

Subcommands: find, create, attach, fetch, tag, status, move, backup, lint.
Write commands print what they did; `create` is dry-run unless --apply.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .core import Zot, lint_tags, load_conventions


def _print_items(rows):
    for r in rows:
        print(f"{r['key']}  [{r['itemType']}]  {r['title'][:75]}")
        print(f"    collections: {r['collections']}")
        print(f"    tags: {r['tags']}")
    print(f"\n{len(rows)} match(es)")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="zotkit", description="Headless Zotero library CLI")
    sub = ap.add_subparsers(dest="cmd", required=True)

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
        data = json.load(open(a.file))
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
        json.dump(new, open(out, "w"), ensure_ascii=False, indent=2)
        print(f"created {len(new)} (skipped {len(created)-len(new)} dup) -> {out}")
        if any(c.get("file_path") for c in new):
            print(f"attach PDFs: zotkit attach --from {out} --all")

    elif a.cmd == "attach":
        if a.key and a.pdf:
            print(zot.attach(a.key, a.pdf))
        elif a.src:
            rows = json.load(open(a.src))
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
