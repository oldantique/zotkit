"""Offline tests for zotkit.audit bucketing, on a fixture library."""
import types

from zotkit.audit import audit


def _top(key, itype="journalArticle", ab="", extra="", doi="", url=""):
    return {"key": key, "data": {"itemType": itype, "abstractNote": ab,
                                 "extra": extra, "DOI": doi, "url": url}}


TOPS = [
    _top("OK111111", ab="a", extra="abstract-source: arxiv", doi="10.1/x"),  # healthy
    _top("NOABS111", doi="10.1/y"),                                # missing abstract
    _top("NOID1111", ab="a"),                          # unstamped + missing id
    _top("ARXID111", extra="arXiv: 2401.00001"),       # id via Extra, missing abstract
    _top("STALE111", extra="abstract-source: cnki", doi="10.1/z"),  # stale stamp
    _top("NOTE1111", itype="note"),                    # excluded
    _top("ATT11111", itype="attachment"),              # excluded
]
ATTS = [
    {"key": "A1", "data": {"itemType": "attachment", "parentItem": "OK111111",
                           "contentType": "application/pdf"}},
    {"key": "A2", "data": {"itemType": "attachment", "parentItem": "NOABS111",
                           "contentType": "text/html"}},
]


def _fixture_zot():
    return types.SimpleNamespace(
        listing=lambda kind: list({"top": TOPS, "attachments": ATTS}[kind]))


def test_audit_buckets():
    rep = audit(_fixture_zot())
    b = rep["buckets"]
    assert rep["total"] == 5  # notes/attachments excluded
    assert b["missing-abstract"] == ["NOABS111", "ARXID111", "STALE111"]
    assert b["missing-identifier"] == ["NOID1111"]
    # an html attachment does not count as a PDF
    assert b["missing-pdf"] == ["NOABS111", "NOID1111", "ARXID111", "STALE111"]
    assert b["unstamped-abstract"] == ["NOID1111"]
    assert b["stale-stamp"] == ["STALE111"]


def test_audit_keys_in_library_order():
    rep = audit(_fixture_zot())
    assert rep["keys"] == ["OK111111", "NOABS111", "NOID1111", "ARXID111",
                           "STALE111"]


# ---------- journal abbreviation check ----------

def _journal(key, title, stored=""):
    return {"key": key, "data": {"itemType": "journalArticle", "abstractNote": "",
                                 "extra": "", "DOI": "10.1/x", "url": "",
                                 "publicationTitle": title,
                                 "journalAbbreviation": stored}}


def _zot(tops):
    return types.SimpleNamespace(
        listing=lambda kind: {"top": tops, "attachments": []}[kind])


def test_abbreviation_findings_carry_their_source(monkeypatch, tmp_path):
    from zotkit import journals
    monkeypatch.setattr(journals, "_registered",
                        {"physical review letters": "Phys. Rev. Lett."})
    ltwa = tmp_path / "ltwa.tsv"
    ltwa.write_text("WORD\tABBREVIATION\tLANGUAGES\njournal\tj.\tEnglish\n"
                    "physics\tphys.\tEnglish\n", encoding="utf-8")
    monkeypatch.setenv("ZOTKIT_LTWA", str(ltwa))
    rep = audit(_zot([
        _journal("GOOD1111", "Physical Review Letters", "Phys. Rev. Lett."),
        _journal("UNDOT111", "Physical Review Letters", "Phys Rev Lett"),
        _journal("EMPTY111", "New Journal of Physics", ""),
        _journal("SAME1111", "New Journal of Physics", "New J. Phys."),
        _journal("OTHER111", "New Journal of Physics", "New J Phys"),
        _journal("CJK11111", "物理学报", "Wuli Xuebao"),
    ]))
    # what enrich would change: a registered mismatch, or an empty field
    assert rep["buckets"]["journal-abbreviation"] == ["UNDOT111", "EMPTY111"]
    assert rep["journal_abbreviation"]["UNDOT111"] == {
        "stored": "Phys Rev Lett", "expected": "Phys. Rev. Lett.",
        "source": "registered", "unknown": []}
    assert rep["journal_abbreviation"]["EMPTY111"]["source"] == "rule-derived"
    # a candidate never certifies: equal or not, the journal stays unverified
    assert rep["journal_unverified"] == {"New Journal of Physics": {
        "keys": ["EMPTY111", "SAME1111", "OTHER111"],
        "stored": ["New J. Phys.", "New J Phys"],
        "candidate": "New J. Phys.", "source": "rule-derived", "unknown": ["New"]}}


def test_without_table_hit_or_ltwa_a_journal_is_unverified_not_fine():
    rep = audit(_zot([_journal("UNKN1111", "Physical Review B", "PRB")]))
    assert rep["buckets"]["journal-abbreviation"] == []
    assert rep["journal_unverified"]["Physical Review B"]["candidate"] is None


def test_cli_labels_candidates(monkeypatch, capsys, tmp_path):
    from zotkit import cli
    ltwa = tmp_path / "ltwa.tsv"
    ltwa.write_text("WORD\tABBREVIATION\tLANGUAGES\njournal\tj.\tEnglish\n"
                    "physics\tphys.\tEnglish\n", encoding="utf-8")
    monkeypatch.setenv("ZOTKIT_LTWA", str(ltwa))
    monkeypatch.setattr(cli, "Zot", lambda *a, **k: _zot(
        [_journal("EMPTY111", "New Journal of Physics", "")]))
    cli.main(["audit"])
    out = capsys.readouterr().out
    assert "EMPTY111  '(empty)' → 'New J. Phys.'  [candidate (rule-derived); no English LTWA entry: New]" in out
    assert "journals without a registered abbreviation (unverified, whatever is stored): 1" in out
