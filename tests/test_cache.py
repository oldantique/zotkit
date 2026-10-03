"""zotkit.cache: version-map reconciliation of cached listings (offline)."""
import json

import pytest

from zotkit import cache
from zotkit.cache import sync_listing


def item(key, version, title=""):
    return {"key": key, "version": version, "data": {"title": title or key}}


class Server:
    """A fake listing endpoint that records what was asked of it."""

    def __init__(self, items):
        self.items = list(items)
        self.calls = []

    def versions(self):
        self.calls.append("versions")
        return {it["key"]: it["version"] for it in self.items}

    def fetch_all(self):
        self.calls.append("all")
        return [dict(it) for it in self.items]

    def fetch_keys(self, keys):
        self.calls.append(("keys", tuple(keys)))
        return [dict(it) for it in self.items if it["key"] in keys]


def run(path, srv, keyed=True):
    return sync_listing(path, srv.versions, srv.fetch_all,
                        srv.fetch_keys if keyed else None)


def keys(items):
    return [it["key"] for it in items]


def test_cold_cache_fetches_all_and_writes(tmp_path):
    path = tmp_path / "top.json"
    srv = Server([item("A", 1), item("B", 1)])
    assert keys(run(path, srv)) == ["A", "B"]
    assert srv.calls == ["all"]
    assert keys(json.loads(path.read_text(encoding="utf-8"))["items"]) == ["A", "B"]


def test_warm_unchanged_library_costs_one_versions_call(tmp_path):
    path = tmp_path / "top.json"
    srv = Server([item("A", 1), item("B", 1)])
    run(path, srv)
    srv.calls.clear()
    assert keys(run(path, srv)) == ["A", "B"]
    assert srv.calls == ["versions"]


def test_changed_added_and_removed_items_reconcile(tmp_path):
    path = tmp_path / "top.json"
    srv = Server([item("A", 1), item("B", 1), item("C", 1)])
    run(path, srv)
    srv.items = [item("A", 1), item("C", 2, "C edited"), item("D", 3)]  # B deleted
    srv.calls.clear()
    out = run(path, srv)
    assert keys(out) == ["A", "C", "D"]
    assert out[1]["data"]["title"] == "C edited"
    assert srv.calls == ["versions", ("keys", ("C", "D"))]  # only what changed
    srv.calls.clear()
    assert keys(run(path, srv)) == ["A", "C", "D"]  # and that was persisted
    assert srv.calls == ["versions"]


def test_item_deleted_between_versions_and_fetch_is_dropped(tmp_path):
    path = tmp_path / "top.json"
    srv = Server([item("A", 1), item("B", 1)])
    run(path, srv)
    srv.items = [item("A", 1), item("B", 2)]
    real_fetch = srv.fetch_keys
    srv.fetch_keys = lambda ks: [it for it in real_fetch(ks) if it["key"] != "B"]
    # The old v1 copy of B must not survive a re-fetch that came back empty.
    assert keys(run(path, srv)) == ["A"]


def test_order_follows_the_version_map(tmp_path):
    path = tmp_path / "top.json"
    srv = Server([item("A", 1), item("B", 1)])
    run(path, srv)
    srv.items = [item("B", 2), item("A", 1)]  # B modified -> sorts first
    assert keys(run(path, srv)) == ["B", "A"]


def test_many_changes_are_fetched_in_api_sized_chunks(tmp_path):
    path = tmp_path / "top.json"
    srv = Server([item(f"K{i:03}", 1) for i in range(120)])
    run(path, srv)
    srv.items = [item(f"K{i:03}", 2) for i in range(120)]
    srv.calls.clear()
    run(path, srv)
    sizes = [len(c[1]) for c in srv.calls if c[0] == "keys"]
    assert sizes == [50, 50, 20]


def test_unkeyed_listing_refetches_whole_on_any_change(tmp_path):
    path = tmp_path / "collections.json"
    srv = Server([item("C1", 1), item("C2", 1)])
    run(path, srv, keyed=False)
    srv.items = [item("C1", 2), item("C2", 1)]
    srv.calls.clear()
    run(path, srv, keyed=False)
    assert srv.calls == ["versions", "all"]


@pytest.mark.parametrize("content", ["{not json", '{"format": 999, "items": []}',
                                     '{"format": 1}', '[1, 2]', ""])
def test_corrupt_or_foreign_cache_falls_back_to_full_fetch(tmp_path, content):
    path = tmp_path / "top.json"
    path.write_text(content, encoding="utf-8")
    srv = Server([item("A", 1)])
    assert keys(run(path, srv)) == ["A"]
    assert srv.calls == ["all"]


def test_disabled_cache_never_touches_disk_or_versions():
    srv = Server([item("A", 1)])
    assert keys(sync_listing(None, srv.versions, srv.fetch_all, srv.fetch_keys)) == ["A"]
    assert srv.calls == ["all"]


def test_versions_failure_propagates_instead_of_serving_stale(tmp_path):
    path = tmp_path / "top.json"
    srv = Server([item("A", 1)])
    run(path, srv)

    def down():
        raise ConnectionError("api.zotero.org unreachable")

    with pytest.raises(ConnectionError):
        sync_listing(path, down, srv.fetch_all, srv.fetch_keys)


def test_unwritable_cache_dir_is_not_an_error(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x", encoding="utf-8")
    srv = Server([item("A", 1)])
    assert keys(run(blocker / "sub" / "top.json", srv)) == ["A"]


def test_cache_root_honors_disable_and_xdg(monkeypatch, tmp_path):
    monkeypatch.setenv("ZOTKIT_CACHE", "0")
    assert cache.cache_root() is None
    monkeypatch.delenv("ZOTKIT_CACHE")
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))
    monkeypatch.setattr(cache.os, "name", "posix")
    assert cache.cache_root() == tmp_path / "zotkit"


# ---------- Zot._versions: the completeness guard on the version map ----------

class _Resp:
    def __init__(self, status, body, headers):
        self.status_code, self._body, self.headers = status, body, headers

    def json(self):
        return self._body


def _versions_with(monkeypatch, resp):
    import types
    from zotkit import core
    monkeypatch.setattr(core.httpx, "get", lambda *a, **kw: resp)
    fake = types.SimpleNamespace(env={"ZOTERO_LIBRARY_ID": "4242424",
                                      "ZOTERO_API_KEY": "k"})
    return core.Zot._versions(fake, "items/top", {})


def test_versions_map_complete_is_returned(monkeypatch):
    resp = _Resp(200, {"A": 1, "B": 2}, {"Total-Results": "2"})
    assert _versions_with(monkeypatch, resp) == {"A": 1, "B": 2}


@pytest.mark.parametrize("headers", [
    {"Total-Results": "388"},
    {"Total-Results": "2", "Link": '<https://api.zotero.org/x?start=2>; rel="next"'},
])
def test_truncated_versions_map_fails_loud(monkeypatch, headers):
    # A short map would read as "everything else was deleted" — never accept it.
    with pytest.raises(RuntimeError, match="incomplete version map"):
        _versions_with(monkeypatch, _Resp(200, {"A": 1, "B": 2}, headers))


def test_versions_error_does_not_leak_library_id(monkeypatch):
    with pytest.raises(RuntimeError) as e:
        _versions_with(monkeypatch, _Resp(403, {}, {}))
    assert "403" in str(e.value) and "4242424" not in str(e.value)
