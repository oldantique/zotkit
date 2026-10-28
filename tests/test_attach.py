"""Offline tests for attachments on the WebDAV and Zotero Storage branches:
`show`'s stored-file check (#14), and `attach --title` / `--verify` (#15).
HTTP and the Zotero client are faked — no network, no live library. The Zotero
Storage branch is tested here only against Zotero's documented responses; it
still needs a manual check against a real storage library."""
import hashlib
import io
import types
import zipfile

import httpx
import pytest

from zotkit import cli, core

WEBDAV_ENV = {"WEBDAV_URL": "https://dav.example/zotero", "WEBDAV_USER": "u",
              "WEBDAV_PASS": "p"}


def _zot(env, children=(), item=None):
    z = types.SimpleNamespace(
        endpoint="https://api.zotero.org", library_type="users", library_id="1",
        api_key="k", children=lambda key: list(children), everything=lambda page: page,
        item=lambda key: item, update_item=lambda it: updated.append(it),
        item_template=lambda *a: {"itemType": "attachment"},
        created=[], create_items=None)
    updated = []
    z.updated = updated
    zot = object.__new__(core.Zot)
    zot.env, zot.z = dict(env), z
    return zot


class FakeClient:
    """Stands in for httpx.Client: answers by URL suffix, records requests."""
    def __init__(self, routes):
        self.routes, self.seen = routes, []

    def __call__(self, *a, **kw):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def _answer(self, method, url, **kw):
        self.seen.append((method, url, kw))
        for suffix, (status, body, headers) in self.routes.items():
            if url.endswith(suffix):
                return httpx.Response(status, content=body, headers=headers)
        raise AssertionError(f"unexpected {method} {url}")

    def head(self, url, **kw):
        return self._answer("HEAD", url, **kw)

    def get(self, url, **kw):
        return self._answer("GET", url, **kw)

    def put(self, url, **kw):
        return self._answer("PUT", url, **kw)


def _att(key, link="imported_file", **kw):
    return {"key": key, "data": dict({"itemType": "attachment", "linkMode": link,
                                      "filename": f"{key}.pdf", "md5": "abc",
                                      "contentType": "application/pdf"}, **kw)}


# ---------- show: stored / missing / linked, no download ----------

def test_webdav_rows_head_the_zip(monkeypatch):
    fc = FakeClient({"/A1.zip": (200, b"", {}), "/A2.zip": (404, b"", {})})
    monkeypatch.setattr(core.httpx, "Client", fc)
    zot = _zot(WEBDAV_ENV, children=[_att("A1"), _att("A2"), _att("A3", "linked_file"),
                                     {"key": "N1", "data": {"itemType": "note"}}])
    rows = zot.attachment_rows({"key": "P1", "data": {"itemType": "journalArticle"}})
    assert [(r["key"], r["status"], r["stored"]) for r in rows] == [
        ("A1", "stored", True), ("A2", "missing", False), ("A3", "linked", None)]
    assert {m for m, *_ in fc.seen} == {"HEAD"}             # nothing downloaded


def test_storage_rows_read_the_redirect_not_the_file(monkeypatch):
    # HEAD /file answers 200 whether or not a file exists; GET without
    # following the redirect does tell: 302 stored, 404 missing
    fc = FakeClient({"/A1/file": (302, b"", {"location": "https://files.example/x"}),
                     "/A2/file": (404, b"", {})})
    monkeypatch.setattr(core.httpx, "Client", fc)
    zot = _zot({}, children=[_att("A1"), _att("A2")])
    rows = zot.attachment_rows({"key": "P1", "data": {"itemType": "book"}})
    assert [r["status"] for r in rows] == ["stored", "missing"]
    assert all(kw.get("follow_redirects") is False for _, _, kw in fc.seen)


def test_an_attachment_key_lists_itself(monkeypatch):
    monkeypatch.setattr(core.httpx, "Client", FakeClient({"/A1.zip": (200, b"", {})}))
    zot = _zot(WEBDAV_ENV)
    (row,) = zot.attachment_rows(_att("A1"))
    assert row["key"] == "A1" and row["md5"] == "abc"


def test_other_answers_are_unknown(monkeypatch):
    monkeypatch.setattr(core.httpx, "Client", FakeClient({"/A1.zip": (401, b"", {})}))
    (row,) = _zot(WEBDAV_ENV).attachment_rows(_att("A1"))
    assert row["status"] == "unknown (HTTP 401)" and row["stored"] is None


# ---------- attach --verify: raw bytes, any file type ----------

def _zip(name, data):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(name, data)
    return buf.getvalue()


def test_verify_webdav_match_and_mismatch(monkeypatch, tmp_path):
    f = tmp_path / "data.csv"
    f.write_bytes(b"a,b\n1,2\n")
    monkeypatch.setattr(core.httpx, "Client", FakeClient(
        {"/OK.zip": (200, _zip("data.csv", b"a,b\n1,2\n"), {}),
         "/BAD.zip": (200, _zip("data.csv", b"a,b\n1,3\n"), {}),
         "/GONE.zip": (404, b"", {})}))
    zot = _zot(WEBDAV_ENV)
    assert zot.verify_attachment("OK", f) is None
    assert "differs from local" in zot.verify_attachment("BAD", f)
    assert zot.verify_attachment("GONE", f) == "download returned HTTP 404"


def test_verify_storage_does_not_send_the_api_key_to_the_file_host(monkeypatch, tmp_path):
    f = tmp_path / "data.json"
    f.write_bytes(b'{"a": 1}')                 # pyzotero's file() would parse this
    fc = FakeClient({"/A1/file": (302, b"", {"location": "https://files.example/x"})})
    monkeypatch.setattr(core.httpx, "Client", fc)
    fetched = []

    def plain_get(url, **kw):
        fetched.append((url, kw))
        return httpx.Response(200, content=b'{"a": 1}')
    monkeypatch.setattr(core.httpx, "get", plain_get)
    assert _zot({}).verify_attachment("A1", f) is None
    (url, kw), = fetched
    assert url == "https://files.example/x" and "headers" not in kw


# ---------- attach --title ----------

def test_title_on_the_webdav_attachment_item(monkeypatch, tmp_path):
    f = tmp_path / "slides_v3_final.pdf"
    f.write_bytes(b"%PDF-1.4")
    monkeypatch.setattr(core.httpx, "Client", FakeClient(
        {"/NEW1.zip": (201, b"", {}), "/NEW1.prop": (201, b"", {})}))
    zot = _zot(WEBDAV_ENV)
    sent = []
    zot.z.create_items = lambda items: sent.extend(items) or {
        "successful": {"0": {"key": "NEW1"}}}
    zot.attach("P1", f, title="Talk slides")
    assert sent[0]["title"] == "Talk slides" and sent[0]["filename"] == f.name
    zot.attach("P1", f)
    assert sent[1]["title"] == f.name


def test_title_on_the_storage_attachment_item(tmp_path):
    f = tmp_path / "s.srt"
    f.write_text("1\n", encoding="utf-8")
    zot = _zot({}, item={"key": "NEW2", "data": {"title": "s.srt"}})
    zot.z.attachment_simple = lambda files, parent: {"success": [{"key": "NEW2"}]}
    zot.attach("P1", f, title="Subtitles (en)")
    assert zot.z.updated[0]["data"]["title"] == "Subtitles (en)"


# ---------- CLI ----------

def _run(monkeypatch, argv, zot):
    monkeypatch.setattr(cli, "Zot", lambda *a, **kw: zot)
    monkeypatch.setattr("sys.argv", ["zotkit", *argv])
    return cli.main()


def test_cli_verify_mismatch_exits_1_and_names_the_key(monkeypatch, tmp_path, capsys):
    f = tmp_path / "a.pdf"
    f.write_bytes(b"x")
    zot = types.SimpleNamespace(
        attach=lambda key, path, title=None: {"attachment_key": "NEW3"},
        verify_attachment=lambda k, p: "stored md5 1 differs from local 2")
    assert _run(monkeypatch, ["attach", "--key", "P1", "--pdf", str(f), "--verify"], zot) == 1
    assert "verify failed for attachment NEW3" in capsys.readouterr().err


def test_cli_title_needs_a_single_key(monkeypatch, tmp_path):
    with pytest.raises(SystemExit):
        _run(monkeypatch, ["attach", "--from", "x.json", "--title", "T"],
             types.SimpleNamespace())
