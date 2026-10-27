"""Offline tests for `cite --style short`: author forms, the issue-year rule,
journal normalisation, per-type fallbacks, and the CLI's error contract."""
import io
import types

from zotkit import cli, journals
from zotkit.cite import authors, short


def au(*names):
    return [{"creatorType": "author", "firstName": "X", "lastName": n} for n in names]


LAUGHLIN = {"itemType": "journalArticle", "creators": au("Laughlin"),
            "publicationTitle": "Physical Review Letters",
            "journalAbbreviation": "Phys Rev Lett", "volume": "50",
            "pages": "1395-1398", "date": "1983-05-02", "extra": ""}


def test_author_forms():
    assert authors(au("A")) == "A"
    assert authors(au("A", "B")) == "A & B"
    assert authors(au("A", "B", "C")) == "A et al."
    assert authors([{"creatorType": "editor", "lastName": "E"}]) == "E"
    assert authors([{"creatorType": "author", "name": "LIGO Collaboration"}]) == \
        "LIGO Collaboration"


def test_journal_article_uses_the_normaliser(monkeypatch):
    monkeypatch.setattr(journals, "_registered",
                        {"physical review letters": "Phys. Rev. Lett."})
    assert short(LAUGHLIN) == "Laughlin, Phys. Rev. Lett. 50, 1395 (1983)"


def test_without_an_opinion_the_stored_abbreviation_is_used():
    assert short(LAUGHLIN) == "Laughlin, Phys Rev Lett 50, 1395 (1983)"


def test_issue_year_beats_the_online_date():
    d = dict(LAUGHLIN, date="2022-12-20", extra="arXiv: 2201.1\nissue-date: 2023-01")
    assert short(d).endswith("(2023)")


def test_article_number_and_missing_fields():
    assert short(dict(LAUGHLIN, pages="L041101")) == \
        "Laughlin, Phys Rev Lett 50, L041101 (1983)"
    assert short(dict(LAUGHLIN, volume="", pages="", date="")) == "Laughlin, Phys Rev Lett"


def test_preprint_and_fallback_types():
    pre = {"itemType": "preprint", "creators": au("A", "B"), "date": "2024-01-02",
           "archiveID": "arXiv:2401.12345v2"}
    assert short(pre) == "A & B, arXiv:2401.12345 (2024)"
    book = {"itemType": "book", "creators": au("K"), "title": "Anyons",
            "publisher": "Springer", "date": "2019"}
    assert short(book) == "K, Anyons, Springer (2019)"
    assert short({"itemType": "thesis"}) == ""          # sparse: no crash


def test_cli_prints_good_keys_and_fails_on_unknown(monkeypatch, capsys):
    fake = types.SimpleNamespace(listing=lambda kind: [{"key": "LAUG1983", "data": LAUGHLIN}])
    monkeypatch.setattr(cli, "Zot", lambda *a, **k: fake)
    monkeypatch.setattr("sys.stdin", io.StringIO("LAUG1983\nNOPE0000\n"))
    assert cli.main(["cite"]) == 1
    cap = capsys.readouterr()
    assert cap.out.splitlines() == ["Laughlin, Phys Rev Lett 50, 1395 (1983)"]
    assert "error: NOPE0000: not a top-level item in the library" in cap.err
