"""Offline tests for zotkit.audit bucketing, on a fixture library."""
import types

import pytest

from zotkit.audit import audit, is_supplementary


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


# ---------- supplementary-only PDFs (#13) ----------
# titles/filenames as they occur in real libraries

def _pdf(key, parent, title, filename=None):
    return {"key": key, "data": {"itemType": "attachment", "parentItem": parent,
                                 "contentType": "application/pdf", "title": title,
                                 "filename": filename or title}}


@pytest.mark.parametrize("title, filename", [
    ("Hart2021_Peer_Review_File.pdf", None),
    ("Peer Review File", "Peer Review File.pdf"),
    ("41586_2024_8347_MOESM1_ESM.pdf", None),
    ("science.adz8659_sm", "science.adz8659_sm.pdf"),
    ("Supplemental_Material", "Supplemental_Material.pdf"),
    ("SupplementalMaterial.pdf", None),
    ("supp_pub", "supp_pub.pdf"),
    ("Millisecond_coherence_Supp_mat_additions_in_red.pdf", None),
    ("SUPPLEMENTARY INFORMATION", "Mutus - 2014 - Strong coupling.pdf"),  # renamed file
    ("Supporting Information", "ja123456_si_001.pdf"),
])
def test_supplementary_attachments(title, filename):
    assert is_supplementary(_pdf("A", "P", title, filename)["data"])


@pytest.mark.parametrize("title, filename", [
    ("Acharya - 2023 - Suppressing quantum errors by scaling a surface co.pdf", None),
    ("Full Text PDF", "Supplementary.pdf"),        # a plain title overrides
    ("PDF", "Gustavsson - 2016 - Suppressing relaxation.pdf"),
    ("Smith - 2023 - Supporting quantum memories.pdf", None),
    ("Preprint PDF", "2401.00001v2.pdf"),
    ("已提交版本", "Chen 等 - 2016 - Measuring and Suppressing Quantum State Leakage.pdf"),
])
def test_article_attachments(title, filename):
    assert not is_supplementary(_pdf("A", "P", title, filename)["data"])


def test_only_supplementary_bucket():
    tops = [_top("SIONLY11", ab="a", doi="10.1/a"), _top("BOTH1111", ab="a", doi="10.1/b"),
            _top("NOPDF111", ab="a", doi="10.1/c")]
    atts = [_pdf("A1", "SIONLY11", "Peer Review File", "Peer Review File.pdf"),
            _pdf("A2", "BOTH1111", "Full Text PDF", "paper.pdf"),
            _pdf("A3", "BOTH1111", "Supplementary Information")]
    zot = types.SimpleNamespace(
        listing=lambda kind: list({"top": tops, "attachments": atts}[kind]))
    b = audit(zot)["buckets"]
    assert b["only-supplementary-pdf"] == ["SIONLY11"]
    assert b["missing-pdf"] == ["NOPDF111"]          # meaning unchanged


# ---------- non-paper types and type-appropriate identifiers (#7) ----------

def test_non_paper_items_get_their_own_bucket_only():
    tops = [_top("WEB11111", itype="webpage"), _top("BLOG1111", itype="blogPost"),
            _top("DOC11111", itype="document"), _top("TALK1111", itype="presentation"),
            _top("PAPER111", doi="10.1/a")]
    zot = types.SimpleNamespace(
        listing=lambda kind: list({"top": tops, "attachments": []}[kind]))
    rep = audit(zot)
    assert rep["buckets"]["non-paper"] == ["WEB11111", "BLOG1111", "DOC11111", "TALK1111"]
    assert rep["keys"] == ["PAPER111"]          # enrich --all's work set
    assert rep["total"] == 1
    for b, ks in rep["buckets"].items():
        if b != "non-paper":
            assert not set(ks) & {"WEB11111", "BLOG1111", "DOC11111", "TALK1111"}, b


def test_type_appropriate_identifiers():
    tops = [dict(_top("PAT11111", itype="patent"), **{}),
            _top("BOOK1111", itype="book"), _top("THES1111", itype="thesis"),
            _top("THES2222", itype="thesis")]
    tops[0]["data"]["patentNumber"] = "US 1,234,567 B2"
    tops[1]["data"]["ISBN"] = "978-0-00-000000-2"
    tops[2]["data"]["ISBN"] = "978-0-00-000000-3"
    zot = types.SimpleNamespace(
        listing=lambda kind: list({"top": tops, "attachments": []}[kind]))
    # a thesis with no identifier of any kind is still reported
    assert audit(zot)["buckets"]["missing-identifier"] == ["THES2222"]
