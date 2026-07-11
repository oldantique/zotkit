"""zotkit.core — headless Zotero library management (Web API + WebDAV).

One class, `Zot`, wraps the Zotero Web API (pyzotero) and, for libraries whose
attachment files sync to a personal WebDAV server, reads AND writes the WebDAV
attachment store directly — no desktop app required (see docs/webdav-format.md).

Credentials are read from an .env file (see `load_env` for the search order).
Tag conventions can optionally be enforced in code via a conventions.toml file
next to the .env (see `load_conventions`); without one, tags are unrestricted.
"""
from __future__ import annotations

import hashlib
import io
import json
import mimetypes
import os
import re
import tomllib
import zipfile
from pathlib import Path
from typing import Any

import httpx
from pyzotero import zotero

ENV_VARS = ("ZOTKIT_ENV", "ZOT_ENV")


class TagConventionError(ValueError):
    """Raised when tags violate the configured conventions."""


# ---------- configuration ----------

def _env_candidates(path: str | os.PathLike | None = None) -> list[Path]:
    if path:
        return [Path(path)]
    cands = [Path(os.environ[v]) for v in ENV_VARS if os.environ.get(v)]
    cands.append(Path.cwd() / ".env")
    cands.append(Path.home() / ".config" / "zotkit" / "env")
    return cands


def load_env(path: str | os.PathLike | None = None) -> dict[str, str]:
    """Load KEY=VALUE credentials. Search order: explicit path, $ZOTKIT_ENV,
    ./.env, ~/.config/zotkit/env. Symlinks resolve to their target."""
    cands = _env_candidates(path)
    for p in cands:
        if not p.is_file():
            continue
        env: dict[str, str] = {}
        for line in p.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
        env["_env_path"] = str(p.resolve())
        return env
    raise FileNotFoundError(
        "no zotkit config found — looked for: "
        + ", ".join(str(p) for p in cands)
        + ". Copy .env.example to one of these locations (see README → Configure).")


class Conventions:
    """Tag rules loaded from conventions.toml (all sections optional):

    namespaces = ["field", "topic", "status"]   # allowed prefixes
    require = ["field"]                         # every NEW item needs one such tag
    [closed]                                    # namespaces with a fixed vocabulary
    field = ["physics", "ml", "econ"]
    status = ["to-read", "reading", "read"]
    """

    def __init__(self, data: dict):
        self.namespaces: set[str] = set(data.get("namespaces", []))
        self.require: set[str] = set(data.get("require", []))
        self.closed: dict[str, set[str]] = {
            ns: {f"{ns}:{v}" for v in vals}
            for ns, vals in data.get("closed", {}).items()}


def load_conventions(env_dir: str | os.PathLike | None = None) -> Conventions | None:
    """Find conventions.toml: $ZOTKIT_CONVENTIONS, next to the .env in use,
    then ~/.config/zotkit/. Returns None (= no enforcement) if absent."""
    cands = []
    if os.environ.get("ZOTKIT_CONVENTIONS"):
        cands.append(Path(os.environ["ZOTKIT_CONVENTIONS"]))
    if env_dir:
        cands.append(Path(env_dir) / "conventions.toml")
    else:
        for p in _env_candidates():
            if p.is_file():
                cands.append(p.resolve().parent / "conventions.toml")
                break
    cands.append(Path.home() / ".config" / "zotkit" / "conventions.toml")
    for p in cands:
        if p.is_file():
            return Conventions(tomllib.loads(p.read_text()))
    return None


def lint_tags(tags: list[str], *, for_new_item: bool = True,
              conventions: Conventions | None = None,
              auto_load: bool = True) -> list[str]:
    """Return a list of convention problems (empty = OK).
    With no conventions configured, everything passes."""
    conv = conventions or (load_conventions() if auto_load else None)
    if conv is None:
        return []
    problems = []
    if for_new_item:
        for ns in sorted(conv.require):
            if not any(t.startswith(f"{ns}:") for t in tags):
                vocab = sorted(conv.closed.get(ns, [])) or f"{ns}:*"
                problems.append(f"missing a '{ns}:' tag (every new item needs one of {vocab})")
    for t in tags:
        if ":" not in t:
            problems.append(f"'{t}' has no namespace (expected one of "
                            f"{sorted(conv.namespaces) or 'ns:value'})")
            continue
        ns, _ = t.split(":", 1)
        if conv.namespaces and ns not in conv.namespaces:
            problems.append(f"'{t}' uses unknown namespace '{ns}:'")
        if t != t.lower() or " " in t or "_" in t:
            problems.append(f"'{t}' must be lowercase-hyphenated")
        if ns in conv.closed and t not in conv.closed[ns]:
            problems.append(f"'{t}' not in the configured '{ns}:' vocabulary "
                            f"{sorted(conv.closed[ns])}")
    return problems


# ---------- helpers ----------

def _norm_title(t: str | None) -> str:
    return re.sub(r"\W+", " ", (t or "").lower()).strip()


def _md5_file(p: Path) -> str:
    h = hashlib.md5()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


class Zot:
    """Unified library interface: search, create, tag, move, attach, fetch, backup."""

    def __init__(self, env_path: str | os.PathLike | None = None):
        self.env = load_env(env_path)
        self.home = Path(self.env["_env_path"]).parent  # config dir: backups etc.
        self.conventions = load_conventions(self.home)
        self.z = zotero.Zotero(self.env["ZOTERO_LIBRARY_ID"],
                               self.env.get("ZOTERO_LIBRARY_TYPE", "user"),
                               self.env["ZOTERO_API_KEY"])
        self._cols: list[dict] | None = None

    def _lint(self, tags: list[str], *, for_new_item: bool) -> list[str]:
        return lint_tags(tags, for_new_item=for_new_item,
                         conventions=self.conventions, auto_load=False)

    # ---------- collections ----------
    def collections(self, refresh: bool = False) -> list[dict]:
        if self._cols is None or refresh:
            self._cols = self.z.everything(self.z.collections())
        return self._cols

    def collection_key(self, name: str) -> str | None:
        """Resolve a collection by exact name, or 'Parent :: Child'."""
        cols = self.collections()
        if "::" in name:
            parent, child = [s.strip() for s in name.split("::", 1)]
            pk = next((c["key"] for c in cols if c["data"]["name"] == parent
                       and not c["data"].get("parentCollection")), None)
            return next((c["key"] for c in cols if c["data"]["name"] == child
                         and c["data"].get("parentCollection") == pk), None)
        return next((c["key"] for c in cols if c["data"]["name"] == name), None)

    def collection_names(self) -> dict[str, str]:
        return {c["key"]: c["data"]["name"] for c in self.collections()}

    # ---------- search ----------
    def find(self, title: str | None = None, tag: str | None = None,
             collection: str | None = None) -> list[dict]:
        """Search top-level items; returns slim records with key/type/title/collections/tags."""
        ckey = self.collection_key(collection) if collection else None
        if collection and not ckey:
            raise KeyError(f"no collection named '{collection}'")
        cname = self.collection_names()
        out = []
        for it in self.z.everything(self.z.top()):
            d = it["data"]
            tags = [t["tag"] for t in d.get("tags", [])]
            if title and title.lower() not in d.get("title", "").lower():
                continue
            if tag and tag not in tags:
                continue
            if ckey and ckey not in d.get("collections", []):
                continue
            out.append({"key": it["key"], "itemType": d.get("itemType"),
                        "title": d.get("title", ""),
                        "collections": [cname.get(c, c) for c in d.get("collections", [])],
                        "tags": tags, "version": d.get("version")})
        return out

    # ---------- create ----------
    def create_items(self, items: list[dict[str, Any]], *, dedup: bool = True,
                     strict_tags: bool = True) -> list[dict]:
        """Create bibliographic items. Each dict: itemType/title/creators/... plus
        tags: [str], collection: name, file_path: optional (carried through).
        Validates tags against the configured conventions (raise if strict_tags)."""
        existing = self.z.everything(self.z.top()) if dedup else []
        seen_doi = {(it["data"].get("DOI") or "").strip().lower()
                    for it in existing if it["data"].get("DOI")}
        seen_title = {_norm_title(it["data"].get("title")) for it in existing}

        templates: dict[str, dict] = {}
        payloads, meta = [], []
        for d in items:
            tags = d.get("tags", [])
            problems = self._lint(tags, for_new_item=True)
            if problems:
                msg = f"tags for '{d.get('title','')[:50]}': " + "; ".join(problems)
                if strict_tags:
                    raise TagConventionError(msg)
                print("WARN", msg)
            doi = (d.get("DOI") or "").strip().lower()
            if dedup and ((doi and doi in seen_doi) or _norm_title(d.get("title")) in seen_title):
                meta.append({"title": d.get("title"), "skipped": "duplicate"})
                continue
            t = d["itemType"]
            templates.setdefault(t, self.z.item_template(t))
            tmpl = json.loads(json.dumps(templates[t]))
            for f, v in d.items():
                if f not in ("tags", "collection", "file_path") and f in tmpl:
                    tmpl[f] = v
            tmpl["tags"] = [{"tag": x} for x in tags]
            ck = self.collection_key(d["collection"]) if d.get("collection") else None
            if d.get("collection") and not ck:
                raise KeyError(f"no collection named '{d['collection']}'")
            tmpl["collections"] = [ck] if ck else []
            payloads.append(tmpl)
            meta.append({"title": d.get("title"), "collection": d.get("collection"),
                         "file_path": d.get("file_path")})

        created, mi = [], iter([m for m in meta if "skipped" not in m])
        for i in range(0, len(payloads), 50):
            resp = self.z.create_items(payloads[i:i + 50])
            if resp.get("failed"):
                raise RuntimeError(f"create failed: {resp['failed']}")
            batch_meta = [next(mi) for _ in range(len(payloads[i:i + 50]))]
            for idx, obj in sorted(resp.get("successful", {}).items(), key=lambda x: int(x[0])):
                created.append({**batch_meta[int(idx)], "key": obj["key"]})
        skipped = [m for m in meta if m.get("skipped")]
        return created + skipped

    # ---------- tags / status / move ----------
    def add_tags(self, item_key: str, *tags: str, strict: bool = True) -> None:
        problems = self._lint(list(tags), for_new_item=False)
        if problems and strict:
            raise TagConventionError("; ".join(problems))
        it = self.z.item(item_key)
        have = {t["tag"] for t in it["data"].get("tags", [])}
        new = [{"tag": t} for t in tags if t not in have]
        if new:
            it["data"]["tags"] = it["data"]["tags"] + new
            self.z.update_item(it)

    def remove_tags(self, item_key: str, *tags: str) -> None:
        it = self.z.item(item_key)
        it["data"]["tags"] = [t for t in it["data"].get("tags", []) if t["tag"] not in tags]
        self.z.update_item(it)

    def set_status(self, item_key: str, status: str) -> None:
        """Replace the item's status: tag. Validated against the conventions'
        closed 'status' vocabulary when one is configured."""
        tag = status if status.startswith("status:") else f"status:{status}"
        conv = self.conventions
        if conv and "status" in conv.closed and tag not in conv.closed["status"]:
            raise TagConventionError(f"'{tag}' not in {sorted(conv.closed['status'])}")
        it = self.z.item(item_key)
        kept = [t for t in it["data"].get("tags", []) if not t["tag"].startswith("status:")]
        it["data"]["tags"] = kept + [{"tag": tag}]
        self.z.update_item(it)

    def move(self, item_key: str, collection: str, *, add: bool = False) -> None:
        """Move item to a collection (replaces homes unless add=True)."""
        ck = self.collection_key(collection)
        if not ck:
            raise KeyError(f"no collection named '{collection}'")
        it = self.z.item(item_key)
        cur = it["data"].get("collections", [])
        it["data"]["collections"] = (cur + [ck]) if (add and ck not in cur) else [ck]
        self.z.update_item(it)

    # ---------- attachments (WebDAV) ----------
    def _webdav(self) -> tuple[str, tuple[str, str]]:
        try:
            return (self.env["WEBDAV_URL"].rstrip("/"),
                    (self.env["WEBDAV_USER"], self.env["WEBDAV_PASS"]))
        except KeyError as e:
            raise KeyError(f"{e.args[0]} missing from .env — attachment operations "
                           "need WEBDAV_URL/WEBDAV_USER/WEBDAV_PASS") from None

    def attach(self, item_key: str, file_path: str | os.PathLike) -> dict:
        """Attach a local file to an item; bytes go to WebDAV (<key>.zip + .prop)."""
        f = Path(file_path)
        filename, md5 = f.name, _md5_file(f)
        mtime = int(os.path.getmtime(f) * 1000)
        ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        tmpl = self.z.item_template("attachment", "imported_file")
        tmpl.update({"parentItem": item_key, "title": filename, "filename": filename,
                     "contentType": ctype, "md5": md5, "mtime": mtime})
        resp = self.z.create_items([tmpl])
        if resp.get("failed"):
            raise RuntimeError(f"attachment item failed: {resp['failed']}")
        key = resp["successful"]["0"]["key"]
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(f, arcname=filename)
        prop = (f'<properties version="1"><mtime>{mtime}</mtime>'
                f'<hash>{md5}</hash></properties>')
        base, auth = self._webdav()
        with httpx.Client(auth=auth, timeout=120) as c:
            r1 = c.put(f"{base}/{key}.zip", content=buf.getvalue())
            r2 = c.put(f"{base}/{key}.prop", content=prop.encode())
        ok = r1.status_code in (200, 201, 204) and r2.status_code in (200, 201, 204)
        if not ok:
            raise RuntimeError(f"WebDAV PUT failed: zip={r1.status_code} prop={r2.status_code}")
        return {"attachment_key": key, "filename": filename, "webdav_ok": ok}

    def has_attachment(self, item_key: str) -> bool:
        return any(k["data"].get("itemType") == "attachment"
                   for k in self.z.children(item_key))

    def fetch(self, item_key: str, out_dir: str | os.PathLike = "downloads") -> list[Path]:
        """Download an item's attachment files from WebDAV; returns saved paths."""
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        base, auth = self._webdav()
        saved = []
        with httpx.Client(auth=auth, timeout=120) as c:
            for ch in self.z.children(item_key):
                d = ch["data"]
                if d.get("itemType") != "attachment" or not d.get("filename"):
                    continue
                r = c.get(f"{base}/{ch['key']}.zip")
                if r.status_code != 200:
                    continue
                zipfile.ZipFile(io.BytesIO(r.content)).extractall(out)
                saved.append(out / d["filename"])
        return saved

    # ---------- backup ----------
    def backup(self, out_dir: str | os.PathLike | None = None) -> Path:
        """Full JSON backup (items + collections + membership snapshots).
        Default destination: backups/ next to the .env in use."""
        version = self.z.last_modified_version()
        items = self.z.everything(self.z.items())
        collections = self.z.everything(self.z.collections())
        try:
            searches = self.z.everything(self.z.searches())
        except Exception:
            searches = []
        backup = {
            "last_modified_version": version,
            "items": items, "collections": collections, "searches": searches,
            "item_tags": {it["key"]: [t.get("tag") for t in it["data"].get("tags", [])]
                          for it in items if "data" in it},
            "item_collections": {it["key"]: it["data"].get("collections", [])
                                 for it in items if "data" in it},
        }
        out = Path(out_dir or (self.home / "backups"))
        out.mkdir(parents=True, exist_ok=True)
        p = out / f"zotero_backup_v{version}.json"
        p.write_text(json.dumps(backup, ensure_ascii=False, indent=2))
        return p
