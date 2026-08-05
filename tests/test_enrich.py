"""Offline tests for zotkit.enrich: the version-of-record gate in plan_enrich
and the set_abstract guard/force/stamp matrix. No network, no live library —
the Zotero client and CrossRef fetch are faked."""
import types

import pytest

from zotkit import enrich
from zotkit import metadata as md

SSRN_ITEM = {"itemType": "journalArticle", "title": "Some Working Paper",
             "publicationTitle": "SSRN Electronic Journal",
             "DOI": "10.2139/ssrn.2407199", "creators": []}
PRL_ITEM = {"itemType": "journalArticle", "title": "GW150914",
            "publicationTitle": "Physical Review Letters",
            "DOI": "10.1103/PhysRevLett.116.061102", "creators": []}

SSRN_PREPRINT = {"itemType": "preprint", "title": "Some Working Paper",
                 "abstractNote": "has one", "creators": [],
                 "DOI": "10.2139/ssrn.2407199", "extra": "", "url": "",
                 "archiveID": "", "tags": [], "collections": [],
                 "relations": {}, "repository": "SSRN", "date": ""}


def _read_only_zot(item_data):
    return types.SimpleNamespace(z=types.SimpleNamespace(
        item=lambda k: {"data": dict(item_data), "key": k, "version": 1}))


def _plan(monkeypatch, item_data, fetched, rebuild):
    monkeypatch.setattr(md, "fetch_doi", lambda doi: dict(fetched))
    return enrich.plan_enrich(_read_only_zot(item_data), "KEY00001",
                              rebuild_record=rebuild)


# ---------- plan_enrich: version-of-record gate ----------

def test_ssrn_doi_never_rebuilds(monkeypatch):
    p = _plan(monkeypatch, SSRN_PREPRINT, SSRN_ITEM, rebuild=True)
    assert p["rebuild"] is None
    assert any("no version-of-record upgrade" in n and "repository DOI" in n
               for n in p["notes"])


def test_repository_doi_still_fills_missing(monkeypatch):
    p = _plan(monkeypatch, SSRN_PREPRINT, dict(SSRN_ITEM, date="2024-01-15"),
              rebuild=False)
    assert p["fills"].get("date") == "2024-01-15"
    assert not any("version-of-record" in n for n in p["notes"])


def test_genuine_journal_doi_rebuilds(monkeypatch):
    real_preprint = dict(SSRN_PREPRINT, DOI="10.1103/PhysRevLett.116.061102",
                         repository="arXiv")
    p = _plan(monkeypatch, real_preprint, PRL_ITEM, rebuild=True)
    assert p["rebuild"] == "journalArticle"


def test_layer2_guard_blocks_disguised_record(monkeypatch):
    # non-blacklist DOI prefix, but the fetched record is the SSRN pseudo-journal
    disguised = dict(SSRN_ITEM, DOI="10.9999/fake.1")
    odd_preprint = dict(SSRN_PREPRINT, DOI="10.9999/fake.1")
    p = _plan(monkeypatch, odd_preprint, disguised, rebuild=True)
    assert p["rebuild"] is None
    assert any("pseudo-journal" in n for n in p["notes"])


def test_no_identifier_skips_without_fetching(monkeypatch):
    monkeypatch.setattr(md, "fetch_doi",
                        lambda doi: pytest.fail("must not fetch CrossRef"))
    noid = dict(SSRN_PREPRINT, DOI="")
    p = enrich.plan_enrich(_read_only_zot(noid), "KEY00001",
                           rebuild_record=False)
    assert p["status"] == "needs-identifier"


# ---------- set_abstract: guard / force / stamp matrix ----------

class FakeZ:
    def __init__(self, data):
        self._data = data
        self.updated = None

    def item(self, key):
        return {"key": key, "version": 7, "data": dict(self._data)}

    def update_item(self, item):
        self.updated = item


def zot_with(data):
    return types.SimpleNamespace(z=FakeZ(data))


BASE = {"itemType": "journalArticle", "title": "T", "abstractNote": "",
        "extra": "", "key": "K1", "version": 7}


def test_fresh_item_writes_cleaned_abstract_and_stamp():
    z = zot_with(BASE)
    r = enrich.set_abstract(z, "K1", "some text\nwrapped", "cnki")
    d = z.z.updated["data"]
    assert d["abstractNote"] == "some text wrapped"  # unwrap applied to paste
    assert d["extra"] == "abstract-source: cnki"
    assert r["replaced"] is False


def test_existing_abstract_refused_without_force():
    z = zot_with(dict(BASE, abstractNote="old text"))
    with pytest.raises(md.MetadataError, match="--force"):
        enrich.set_abstract(z, "K1", "new", "manual")
    assert z.z.updated is None  # nothing written


def test_stale_stamp_alone_refused_without_force():
    z = zot_with(dict(BASE, extra="abstract-source: arxiv"))
    with pytest.raises(md.MetadataError, match="--force"):
        enrich.set_abstract(z, "K1", "new", "manual")
    assert z.z.updated is None


def test_force_replaces_abstract_and_rewrites_stamp_in_place():
    z = zot_with(dict(BASE, abstractNote="old",
                      extra="arXiv: 2401.00001\nabstract-source: arxiv\n"
                            "Citation Key: x"))
    r = enrich.set_abstract(z, "K1", "new text", "publisher", force=True)
    d = z.z.updated["data"]
    assert d["abstractNote"] == "new text"
    assert d["extra"] == ("arXiv: 2401.00001\nabstract-source: publisher\n"
                          "Citation Key: x")
    assert d["extra"].count("abstract-source:") == 1
    assert r["replaced"] is True


def test_force_on_unstamped_item_appends_stamp_keeping_lines():
    z = zot_with(dict(BASE, abstractNote="old", extra="Some: line"))
    enrich.set_abstract(z, "K1", "new", "manual", force=True)
    d = z.z.updated["data"]
    assert d["extra"] == "Some: line\nabstract-source: manual"


def test_empty_after_cleaning_errors_and_writes_nothing():
    z = zot_with(BASE)
    with pytest.raises(md.MetadataError, match="empty"):
        enrich.set_abstract(z, "K1", "  \n\u00ad ", "manual")
    assert z.z.updated is None


def test_open_vocabulary_slug_accepted():
    z = zot_with(BASE)
    enrich.set_abstract(z, "K1", "x", "some-new-source2")
    assert z.z.updated is not None


@pytest.mark.parametrize("bad", ["CNKI", "with space", "", "-lead", "中文"])
def test_bad_slug_refused(bad):
    z = zot_with(BASE)
    with pytest.raises(md.MetadataError):
        enrich.set_abstract(z, "K1", "x", bad)
    assert z.z.updated is None


def test_item_type_without_abstract_field_refused():
    z = zot_with({"itemType": "note", "extra": "", "key": "K1"})
    with pytest.raises(md.MetadataError, match="no abstract field"):
        enrich.set_abstract(z, "K1", "x", "manual")
    assert z.z.updated is None
