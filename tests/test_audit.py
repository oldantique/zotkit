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
    return types.SimpleNamespace(z=types.SimpleNamespace(
        everything=lambda x: x,
        top=lambda: list(TOPS),
        items=lambda itemType=None: list(ATTS)))


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
