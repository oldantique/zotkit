"""Offline tests for `find --id`: identifier parsing, every place an item can
carry an identifier, one output line per input in input order, and exit codes.
Runs against a fake listing — no network, no live library."""
import io
import types

import pytest

from zotkit import cli
from zotkit.lookup import item_ids, lookup_ids, parse_id

ITEMS = [
    {"key": "JOUR0001", "data": {"itemType": "journalArticle",
                                 "DOI": "10.1103/PhysRevLett.50.1395",
                                 "extra": "arXiv: 2401.12345v2"}},
    {"key": "PREP0002", "data": {"itemType": "preprint",
                                 "archiveID": "arXiv:2310.00001",
                                 "DOI": "10.48550/arXiv.2310.00001"}},
    {"key": "URLO0003", "data": {"itemType": "preprint",
                                 "url": "https://arxiv.org/abs/hep-th/9901001v3"}},
    {"key": "BOOK0004", "data": {"itemType": "book",
                                 "extra": "OCLC: 1\nDOI: 10.1007/978-3-030-00001-1"}},
    {"key": "DUPE0005", "data": {"itemType": "preprint",
                                 "archiveID": "arXiv:2310.00001"}},
    {"key": "LINK0006", "data": {"itemType": "attachment",  # standalone link
                                 "url": "https://arxiv.org/abs/2310.00001"}},
]


# ---------- parse_id ----------

@pytest.mark.parametrize("raw, want", [
    ("2401.12345", ("arxiv", "2401.12345")),
    ("2401.12345v3", ("arxiv", "2401.12345")),
    ("https://arxiv.org/pdf/2401.12345v1.pdf", ("arxiv", "2401.12345")),
    ("arXiv:hep-th/9901001", ("arxiv", "hep-th/9901001")),
    ("10.48550/arXiv.2401.12345", ("arxiv", "2401.12345")),
    ("10.1103/PhysRevLett.50.1395", ("doi", "10.1103/physrevlett.50.1395")),
    ("https://doi.org/10.1103/PhysRevLett.50.1395", ("doi", "10.1103/physrevlett.50.1395")),
    ("doi:10.1103/PhysRevLett.50.1395", ("doi", "10.1103/physrevlett.50.1395")),
])
def test_parse_id(raw, want):
    assert parse_id(raw) == want


def test_parse_id_rejects_non_identifiers():
    with pytest.raises(ValueError, match="not an arXiv id or DOI"):
        parse_id("vaswani")


# ---------- item_ids ----------

def test_journal_item_is_found_by_doi_and_by_its_extra_arxiv_line():
    assert item_ids(ITEMS[0]["data"]) == {("doi", "10.1103/physrevlett.50.1395"),
                                          ("arxiv", "2401.12345")}


def test_arxiv_datacite_doi_indexes_as_arxiv_not_doi():
    assert item_ids(ITEMS[1]["data"]) == {("arxiv", "2310.00001")}


def test_arxiv_url_and_extra_doi_line_are_indexed():
    assert item_ids(ITEMS[2]["data"]) == {("arxiv", "hep-th/9901001")}
    assert ("doi", "10.1007/978-3-030-00001-1") in item_ids(ITEMS[3]["data"])


# ---------- lookup_ids ----------

def test_one_record_per_input_in_input_order():
    ids = ["10.9999/nope", "2401.12345v1", "nonsense", "HEP-TH/9901001"]
    rs = lookup_ids(ITEMS, ids)
    assert [r["input"] for r in rs] == ids
    assert rs[0]["matches"] == []
    assert rs[1]["matches"] == [("JOUR0001", "journalArticle")]
    assert "error" in rs[2]
    assert rs[3]["matches"] == [("URLO0003", "preprint")]


def test_library_duplicates_are_all_reported():
    (r,) = lookup_ids(ITEMS, ["2310.00001"])
    assert [k for k, _ in r["matches"]] == ["PREP0002", "DUPE0005"]


# ---------- the CLI ----------

def run(monkeypatch, argv, stdin=""):
    fake = types.SimpleNamespace(listing=lambda kind: ITEMS)
    monkeypatch.setattr(cli, "Zot", lambda *a, **k: fake)
    monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    return cli.main(["find", *argv])


def test_cli_lines_pair_input_with_answer(monkeypatch, capsys):
    rc = run(monkeypatch, ["--id", "2401.12345,10.9999/nope", "2310.00001"])
    cap = capsys.readouterr()
    assert rc == 0  # absent is an answer, not an error
    assert cap.out.splitlines() == [
        "2401.12345 · JOUR0001 · journalArticle",
        "10.9999/nope · absent",
        "2310.00001 · PREP0002 · preprint · also DUPE0005",
    ]
    assert "2 in library, 1 absent" in cap.err


def test_cli_reads_ids_from_stdin(monkeypatch, capsys):
    assert run(monkeypatch, ["--id"], stdin="2401.12345\n\n10.9999/nope\n") == 0
    assert capsys.readouterr().out.splitlines() == [
        "2401.12345 · JOUR0001 · journalArticle", "10.9999/nope · absent"]


def test_cli_invalid_input_keeps_its_line_and_exits_1(monkeypatch, capsys):
    rc = run(monkeypatch, ["--id", "vaswani", "2401.12345"])
    cap = capsys.readouterr()
    assert rc == 1
    assert cap.out.splitlines()[0] == "vaswani · invalid"
    assert "error: 'vaswani' is not an arXiv id or DOI" in cap.err


def test_cli_id_does_not_combine_with_other_filters(monkeypatch, capsys):
    assert run(monkeypatch, ["--id", "2401.12345", "--any", "x"]) == 1
    assert "does not combine" in capsys.readouterr().err


def test_cli_no_ids_is_an_error(monkeypatch, capsys):
    assert run(monkeypatch, ["--id"], stdin="") == 1
    assert "no ids given" in capsys.readouterr().err
