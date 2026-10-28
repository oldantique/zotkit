"""Offline tests for `zotkit show`: the one-line format, the DOI → arXiv →
placeholder identifier ladder, --json, and per-key error handling. The Zotero
client is faked — no network, no live library."""
import json
import types

from zotkit import cli

PAPER = {"itemType": "journalArticle", "title": "Attention Is All You Need",
         "date": "2017-06-12", "DOI": "10.1234/abc",
         "creators": [{"creatorType": "author", "firstName": "A",
                       "lastName": "Vaswani"}]}
PREPRINT = {"itemType": "preprint", "title": "A Preprint", "date": "2024",
            "DOI": "", "archiveID": "arXiv:2401.12345", "creators": []}
BARE = {"itemType": "book", "title": "Untitled Thing", "date": "",
        "creators": [{"creatorType": "author", "name": "The Committee"}]}


# What pyzotero's error_handler actually raises: a multi-line message with
# the full request URL, numeric library ID included.
USER_ID = "4242424"


def _pyzotero_404(key):
    return Exception(f"\nCode: 404\n"
                     f"URL: https://api.zotero.org/users/{USER_ID}/items/{key}"
                     f"?format=json\nMethod: GET\nResponse: Not found")


def fake_zot(items, rows=None):
    def item(key):
        if key not in items:
            raise _pyzotero_404(key)
        return {"key": key, "version": 1, "data": dict(items[key])}

    def attachment_rows(it):
        r = (rows or {}).get(it["key"], [])
        if isinstance(r, Exception):
            raise r
        return r
    return types.SimpleNamespace(z=types.SimpleNamespace(item=item),
                                 attachment_rows=attachment_rows)


def test_one_line_format(capsys):
    rc = cli._show(fake_zot({"AAAA1111": PAPER}), ["AAAA1111"], False)
    line = capsys.readouterr().out.strip()
    assert rc == 0
    parts = [p.strip() for p in line.split("·")]
    assert parts == ["AAAA1111", "journalArticle", "Vaswani 2017",
                     "Attention Is All You Need", "10.1234/abc"]


def test_long_title_is_truncated(capsys):
    long = dict(PAPER, title="T" * 200)
    cli._show(fake_zot({"K1": long}), ["K1"], False)
    title = capsys.readouterr().out.split("·")[3].strip()
    assert len(title) <= 60
    assert title.startswith("TTT")


def test_arxiv_id_fallback_when_no_doi(capsys):
    cli._show(fake_zot({"K1": PREPRINT}), ["K1"], False)
    out = capsys.readouterr().out
    assert "2401.12345" in out
    assert out.split("·")[2].strip() == "2024"  # blank author, year only


def test_placeholder_when_no_identifier(capsys):
    cli._show(fake_zot({"K1": BARE}), ["K1"], False)
    parts = [p.strip() for p in capsys.readouterr().out.split("·")]
    assert parts[-1] == "—"
    assert parts[2] == "The Committee"  # single-field creator name


def test_json_dumps_full_item_data(capsys):
    rc = cli._show(fake_zot({"K1": PAPER, "K2": PREPRINT}), ["K1", "K2"], True)
    payload = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert [d["title"] for d in payload] == ["Attention Is All You Need",
                                             "A Preprint"]
    assert payload[0]["creators"][0]["lastName"] == "Vaswani"


def test_bad_key_reports_one_sanitized_line_and_continues(capsys):
    rc = cli._show(fake_zot({"GOOD1": PAPER}), ["BAD1", "GOOD1"], False)
    cap = capsys.readouterr()
    assert rc == 1
    assert cap.err.strip() == "error: BAD1: not found (404)"
    assert USER_ID not in cap.err       # no library ID / URL in default output
    assert "GOOD1" in cap.out           # good key still printed
    assert "BAD1" not in cap.out


def test_verbose_adds_the_full_exception_after_the_one_liner(capsys):
    rc = cli._show(fake_zot({}), ["BAD1"], False, verbose=True)
    err = capsys.readouterr().err
    assert rc == 1
    assert err.splitlines()[0] == "error: BAD1: not found (404)"
    assert f"users/{USER_ID}/items/BAD1" in err   # full detail only here


def test_non_404_status_is_reported_as_api_error(capsys):
    def item(key):
        raise Exception("\nCode: 403\nURL: https://api.zotero.org/users/"
                        f"{USER_ID}/items/{key}\nMethod: GET\nResponse: Forbidden")
    zot = types.SimpleNamespace(z=types.SimpleNamespace(item=item))
    rc = cli._show(zot, ["K1"], False)
    err = capsys.readouterr().err
    assert rc == 1
    assert err.strip() == "error: K1: API error (403)"
    assert USER_ID not in err


def test_exception_without_a_status_code_falls_back_to_the_class_name(capsys):
    def item(key):
        raise ConnectionError("network is down somewhere")
    zot = types.SimpleNamespace(z=types.SimpleNamespace(item=item))
    rc = cli._show(zot, ["K1"], False)
    assert rc == 1
    assert capsys.readouterr().err.strip() == "error: K1: ConnectionError"


def test_bad_key_in_json_mode_still_exits_1(capsys):
    rc = cli._show(fake_zot({"GOOD1": PAPER}), ["BAD1", "GOOD1"], True)
    cap = capsys.readouterr()
    assert rc == 1
    assert len(json.loads(cap.out)) == 1
    assert "BAD1" in cap.err


# ---------- attachments (#14): listed under the item, nothing downloaded ----------

ROWS = [{"key": "ATT00001", "filename": "paper.pdf", "contentType": "application/pdf",
         "linkMode": "imported_file", "md5": "9e107d9d372bb6826bd81d3542a419d6",
         "stored": True, "status": "stored"},
        {"key": "ATT00002", "filename": "", "contentType": "", "linkMode": "linked_url",
         "md5": "", "stored": None, "status": "linked"}]


def test_attachment_lines_under_the_item(capsys):
    rc = cli._show(fake_zot({"K1": PAPER}, {"K1": ROWS}), ["K1"], False)
    lines = capsys.readouterr().out.splitlines()
    assert rc == 0
    assert lines[1] == ("  attachment ATT00001 · paper.pdf · application/pdf · "
                        "md5 9e107d9d372bb6826bd81d3542a419d6 · stored")
    assert lines[2] == "  attachment ATT00002 · — · — · md5 — · linked"


def test_attachments_in_json(capsys):
    cli._show(fake_zot({"K1": PAPER}, {"K1": ROWS}), ["K1"], True)
    (d,) = json.loads(capsys.readouterr().out)
    assert d["attachments"][0] == {k: v for k, v in ROWS[0].items() if k != "status"}
    assert d["attachments"][1]["stored"] is None


def test_attachment_lookup_failure_does_not_fail_the_key(capsys):
    rc = cli._show(fake_zot({"K1": PAPER}, {"K1": _pyzotero_404("K1")}), ["K1"], False)
    out = capsys.readouterr().out
    assert rc == 0
    assert "  attachments: could not list (" in out and USER_ID not in out
