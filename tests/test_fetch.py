"""Offline tests for `fetch` target resolution: an attachment's own key fetches
that file, and a fetch that saves nothing says why and exits nonzero. Uses the
Zotero Storage branch (no WEBDAV_URL) against a fake pyzotero client."""
from pathlib import Path

import pytest

from zotkit import cli
from zotkit.core import Zot

USER_ID = "4242424"

PARENT = {"key": "PARE1111", "data": {"itemType": "journalArticle", "title": "P"}}
PDF = {"key": "ATTA1111", "data": {"itemType": "attachment", "parentItem": "PARE1111",
                                   "filename": "paper.pdf"}}
LINK = {"key": "LINK1111", "data": {"itemType": "attachment", "parentItem": "PARE1111",
                                    "linkMode": "linked_url"}}  # no stored file
NOFILES = {"key": "NOFI1111", "data": {"itemType": "book", "title": "No files"}}
LONE = {"key": "LONE1111", "data": {"itemType": "attachment", "filename": "lone.pdf"}}

ITEMS = {i["key"]: i for i in (PARENT, PDF, LINK, NOFILES, LONE)}
CHILDREN = {"PARE1111": [PDF, LINK]}


class FakeZ:
    def __init__(self):
        self.item_calls = []

    def children(self, key):
        if key not in ITEMS:
            raise Exception(f"\nCode: 404\nURL: https://api.zotero.org/users/{USER_ID}"
                            f"/items/{key}/children\nMethod: GET\nResponse: Not found")
        return CHILDREN.get(key, [])

    def item(self, key):
        self.item_calls.append(key)
        return ITEMS[key]

    def dump(self, key, filename, path):
        (Path(path) / filename).write_bytes(b"%PDF-1.4 " + key.encode())


@pytest.fixture
def zot():
    z = Zot.__new__(Zot)
    z.env = {}  # no WEBDAV_URL -> Zotero Storage branch via z.dump
    z.z = FakeZ()
    return z


def run(monkeypatch, zot, tmp_path, key):
    monkeypatch.setattr(cli, "Zot", lambda: zot)
    return cli.main(["fetch", "--key", key, "--out", str(tmp_path)])


# ---------- file_attachments ----------

def test_regular_item_fetches_children_without_looking_itself_up(zot):
    atts, self_att = zot.file_attachments("PARE1111")
    assert [a["key"] for a in atts] == ["ATTA1111"]  # the linked URL has no file
    assert self_att is None
    assert zot.z.item_calls == []  # no extra request on the normal path


def test_attachment_key_resolves_to_itself(zot):
    atts, self_att = zot.file_attachments("ATTA1111")
    assert [a["key"] for a in atts] == ["ATTA1111"]
    assert self_att["data"]["parentItem"] == "PARE1111"


def test_fileless_attachment_resolves_to_nothing(zot):
    atts, self_att = zot.file_attachments("LINK1111")
    assert atts == [] and self_att["key"] == "LINK1111"


# ---------- the CLI ----------

def test_attachment_key_downloads_its_file_and_names_the_parent(
        monkeypatch, zot, tmp_path, capsys):
    rc = run(monkeypatch, zot, tmp_path, "ATTA1111")
    cap = capsys.readouterr()
    assert rc == 0
    assert (tmp_path / "paper.pdf").is_file()
    assert "note: ATTA1111 is an attachment of PARE1111" in cap.err
    assert "downloaded 1 file(s)" in cap.out


def test_standalone_attachment_says_so(monkeypatch, zot, tmp_path, capsys):
    assert run(monkeypatch, zot, tmp_path, "LONE1111") == 0
    assert "LONE1111 is a standalone attachment" in capsys.readouterr().err


def test_item_without_files_is_an_error_not_a_silent_zero(
        monkeypatch, zot, tmp_path, capsys):
    rc = run(monkeypatch, zot, tmp_path, "NOFI1111")
    cap = capsys.readouterr()
    assert rc == 1
    assert "error: NOFI1111 has no stored file attachments" in cap.err


def test_fileless_attachment_key_is_an_error(monkeypatch, zot, tmp_path, capsys):
    rc = run(monkeypatch, zot, tmp_path, "LINK1111")
    err = capsys.readouterr().err
    assert rc == 1
    assert "LINK1111 is an attachment of PARE1111" in err
    assert "error: LINK1111 has no stored file" in err


def test_download_failure_is_distinguished_from_no_files(
        monkeypatch, zot, tmp_path, capsys):
    def boom(*a):
        raise RuntimeError("storage down")
    zot.z.dump = boom
    rc = run(monkeypatch, zot, tmp_path, "PARE1111")
    assert rc == 1
    assert "1 file attachment(s) found, none could be downloaded" in capsys.readouterr().err


def test_unknown_key_is_one_line_without_library_id(monkeypatch, zot, tmp_path, capsys):
    rc = run(monkeypatch, zot, tmp_path, "BAD00000")
    err = capsys.readouterr().err
    assert rc == 1
    assert "error: BAD00000: not found (404)" in err
    assert USER_ID not in err
