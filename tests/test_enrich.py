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


# ---------- plan_enrich: a user-supplied DOI (enrich --doi) ----------

ARXIV_PREPRINT = dict(SSRN_PREPRINT, title="Topological $\\mathbb{Z}_2$ order in "
                      "a driven lattice", DOI="10.48550/arXiv.2401.12345",
                      archiveID="arXiv:2401.12345", repository="arXiv",
                      creators=[{"creatorType": "author", "firstName": "A.",
                                 "lastName": "Müller"}])
JOURNAL = {"itemType": "journalArticle", "DOI": "10.1103/x.1",
           "title": "Topological Z<sub>2</sub> Order in a Driven Lattice",
           "publicationTitle": "Physical Review B",
           "creators": [{"creatorType": "author", "firstName": "Anna",
                         "lastName": "Muller"}]}


def _plan_doi(monkeypatch, item_data, fetched, doi="10.1103/x.1"):
    seen = []
    monkeypatch.setattr(md, "fetch_doi", lambda d: seen.append(d) or dict(fetched))
    monkeypatch.setattr(md, "fetch_arxiv_batch",
                        lambda ids: [{"item": {"abstractNote": ""}}])
    p = enrich.plan_enrich(_read_only_zot(item_data), "KEY00001",
                           rebuild_record=True, doi=doi)
    return p, seen


def test_supplied_doi_rebuilds_when_title_and_first_author_match(monkeypatch):
    p, seen = _plan_doi(monkeypatch, ARXIV_PREPRINT, JOURNAL,
                        doi="https://doi.org/10.1103/X.1")
    assert seen == ["10.1103/X.1"]  # the supplied DOI, not the item's arXiv one
    assert p["rebuild"] == "journalArticle"
    assert "arXiv: 2401.12345" in p["extra_lines"]  # identity survives the rebuild


def test_journal_subtitle_extension_still_matches(monkeypatch):
    sub = dict(JOURNAL, title=JOURNAL["title"] + ": Theory and Experiment")
    assert _plan_doi(monkeypatch, ARXIV_PREPRINT, sub)[0]["rebuild"]


@pytest.mark.parametrize("fetched, why", [
    (dict(JOURNAL, title="Something Else Entirely"), "titles differ"),
    (dict(JOURNAL, title=JOURNAL["title"] + " II"), "titles differ"),
    (dict(JOURNAL, creators=[{"creatorType": "author", "lastName": "Smith"}]),
     "first authors differ"),
    (dict(JOURNAL, creators=[]), "no first author"),
    (dict(JOURNAL, itemType="preprint"), "not a version of record"),
])
def test_mismatched_doi_record_is_refused(monkeypatch, fetched, why):
    with pytest.raises(md.MetadataError, match=f"NEEDS OWNER.*{why}"):
        _plan_doi(monkeypatch, ARXIV_PREPRINT, fetched)


@pytest.mark.parametrize("item, doi, why", [
    (ARXIV_PREPRINT, "10.2139/ssrn.1", "repository DOI"),
    (dict(ARXIV_PREPRINT, DOI="10.1038/other"), "10.1103/x.1", "already has DOI"),
    (dict(ARXIV_PREPRINT, itemType="journalArticle"), "10.1103/x.1", "upgrades a preprint"),
])
def test_refused_before_any_fetch(monkeypatch, item, doi, why):
    monkeypatch.setattr(md, "fetch_doi", lambda d: pytest.fail("must not fetch"))
    with pytest.raises(md.MetadataError, match=f"NEEDS OWNER.*{why}"):
        enrich.plan_enrich(_read_only_zot(item), "KEY00001",
                           rebuild_record=True, doi=doi)


def test_same_doi_already_on_the_item_is_not_a_conflict(monkeypatch):
    item = dict(ARXIV_PREPRINT, DOI="10.1103/X.1")
    assert _plan_doi(monkeypatch, item, JOURNAL)[0]["rebuild"]


@pytest.mark.parametrize("argv", [
    ["--key", "K1", "--doi", "10.1/x"],                       # no --rebuild-record
    ["--key", "K1", "K2", "--doi", "10.1/x", "--rebuild-record"],
    ["--all", "--doi", "10.1/x", "--rebuild-record"],
])
def test_cli_doi_needs_one_key_and_rebuild_record(monkeypatch, capsys, argv):
    from zotkit import cli
    monkeypatch.setattr(cli, "Zot", lambda *a, **k: types.SimpleNamespace())
    assert cli.main(["enrich", *argv]) == 1
    assert "--doi needs exactly one --key" in capsys.readouterr().err


# ---------- plan_enrich: "the source has no abstract" is reported ----------
#
# Regression for the silent path: an item with no abstract whose source also
# has none used to produce no output at all, so `enrich` said up-to-date while
# `audit` kept listing the item as missing an abstract — forever.

PRA_ITEM = {"itemType": "journalArticle", "title": "Nanoscale NMR",
            "publicationTitle": "Physical Review Applied",
            "DOI": "10.1103/PhysRevApplied.16.014008", "date": "2021-07-06",
            "creators": [{"creatorType": "author", "firstName": "H. J.",
                          "lastName": "Mamin"}]}
# complete except for the abstract, so nothing else lands in fills
PRA_LIBRARY_ITEM = dict(PRA_ITEM, abstractNote="", extra="", url="x",
                        archiveID="", tags=[], collections=[], relations={})


def test_source_without_abstract_emits_a_note_naming_the_source(monkeypatch):
    p = _plan(monkeypatch, PRA_LIBRARY_ITEM, PRA_ITEM, rebuild=False)
    (note,) = [n for n in p["notes"] if "abstract still missing" in n]
    assert note.startswith("NOTE abstract still missing:")
    assert "CrossRef has none for DOI 10.1103/PhysRevApplied.16.014008" in note
    assert "try another source" in note


def test_the_note_does_not_change_status_or_write_anything(monkeypatch):
    p = _plan(monkeypatch, PRA_LIBRARY_ITEM, PRA_ITEM, rebuild=False)
    assert p["status"] == "up-to-date"      # nothing was writable — unchanged
    assert p["fills"] == {} and p["extra_lines"] == []
    assert p["abstract_source"] is None


def test_source_with_an_abstract_fills_it_and_emits_no_note(monkeypatch):
    p = _plan(monkeypatch, PRA_LIBRARY_ITEM,
              dict(PRA_ITEM, abstractNote="A real abstract."), rebuild=False)
    assert p["fills"]["abstractNote"] == "A real abstract."
    assert p["status"] == "plan"
    assert not any("abstract still missing" in n for n in p["notes"])


def test_item_that_already_has_an_abstract_emits_no_note(monkeypatch):
    have = dict(PRA_LIBRARY_ITEM, abstractNote="already here")
    p = _plan(monkeypatch, have, PRA_ITEM, rebuild=False)
    assert not any("abstract still missing" in n for n in p["notes"])


def test_arxiv_branch_names_arxiv_and_the_id(monkeypatch):
    monkeypatch.setattr(md, "fetch_doi",
                        lambda doi: pytest.fail("must not fetch CrossRef"))
    monkeypatch.setattr(md, "fetch_arxiv_batch", lambda ids: [
        {"item": {"itemType": "preprint", "title": "P", "creators": []}}])
    item = dict(PRA_LIBRARY_ITEM, DOI="", archiveID="arXiv:2401.12345")
    p = enrich.plan_enrich(_read_only_zot(item), "KEY00001",
                           rebuild_record=False)
    (note,) = [n for n in p["notes"] if "abstract still missing" in n]
    assert "arXiv has none for 2401.12345" in note


def test_both_sources_tried_says_neither(monkeypatch):
    # journal DOI without an abstract + an arXiv id: the CrossRef path already
    # falls back to arXiv, so the note must not blame CrossRef alone
    monkeypatch.setattr(md, "fetch_arxiv_batch", lambda ids: [
        {"item": {"itemType": "preprint", "title": "P", "creators": []}}])
    item = dict(PRA_LIBRARY_ITEM, archiveID="arXiv:2401.12345")
    p = _plan(monkeypatch, item, PRA_ITEM, rebuild=False)
    (note,) = [n for n in p["notes"] if "abstract still missing" in n]
    assert "neither CrossRef nor arXiv has one" in note


def test_stale_stamp_still_wins_over_the_new_note(monkeypatch):
    stamped = dict(PRA_LIBRARY_ITEM, extra="abstract-source: cnki")
    p = _plan(monkeypatch, stamped, PRA_ITEM, rebuild=False)
    assert p["status"] == "stale-stamp"
    assert any("NEEDS OWNER stale-stamp" in n for n in p["notes"])
    assert not any("abstract still missing" in n for n in p["notes"])


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


# ---------- plan_enrich: journal abbreviation + issue-date ----------

JA = dict(PRA_LIBRARY_ITEM, journalAbbreviation="")


def _with_table(monkeypatch, **table):
    from zotkit import journals
    monkeypatch.setattr(journals, "_registered", table)


def _abbr_plan(monkeypatch, item, fetched=PRA_ITEM, **kw):
    return _plan(monkeypatch, item, fetched, rebuild=False)


def test_registered_form_fills_an_empty_abbreviation(monkeypatch):
    _with_table(monkeypatch, **{"physical review applied": "Phys. Rev. Appl."})
    p = _abbr_plan(monkeypatch, JA)
    assert p["fills"]["journalAbbreviation"] == "Phys. Rev. Appl."
    assert p["status"] == "plan"


def test_registered_form_replaces_a_nonstandard_one(monkeypatch):
    _with_table(monkeypatch, **{"physical review applied": "Phys. Rev. Appl."})
    p = _abbr_plan(monkeypatch, dict(JA, journalAbbreviation="Phys Rev Applied"))
    assert p["fills"]["journalAbbreviation"] == "Phys. Rev. Appl."
    assert any("→ 'Phys. Rev. Appl.' (registered" in n for n in p["notes"])


def test_rule_derived_candidate_never_replaces_a_stored_value(monkeypatch, tmp_path):
    ltwa = tmp_path / "ltwa.tsv"
    ltwa.write_text("WORD\tABBREVIATION\tLANGUAGES\nphysical\tphys.\tEnglish\n"
                    "review\trev.\tEnglish\napplied\tappl.\tEnglish\n", encoding="utf-8")
    monkeypatch.setenv("ZOTKIT_LTWA", str(ltwa))
    p = _abbr_plan(monkeypatch, dict(JA, journalAbbreviation="Phys. Rev. Applied"))
    assert "journalAbbreviation" not in p["fills"]
    assert any("rule-derived candidate 'Phys. Rev. Appl.' — left as is" in n
               for n in p["notes"])
    p = _abbr_plan(monkeypatch, JA)                       # …but fills an empty one
    assert p["fills"]["journalAbbreviation"] == "Phys. Rev. Appl."
    assert any("candidate (rule-derived), not a registered form" in n
               for n in p["notes"])
    p = _abbr_plan(monkeypatch, JA, dict(PRA_ITEM, journalAbbreviation="Phys Rev Appl"))
    assert p["fills"]["journalAbbreviation"] == "Phys Rev Appl"  # CrossRef's beats a guess
    # fetch_doi already filled CrossRef's empty value with the candidate: still noted
    p = _abbr_plan(monkeypatch, JA, dict(PRA_ITEM, journalAbbreviation="Phys. Rev. Appl."))
    assert any("candidate (rule-derived)" in n for n in p["notes"])


def test_abbreviation_fix_needs_no_identifier(monkeypatch):
    _with_table(monkeypatch, **{"physical review applied": "Phys. Rev. Appl."})
    monkeypatch.setattr(md, "fetch_doi", lambda doi: pytest.fail("must not fetch"))
    p = enrich.plan_enrich(_read_only_zot(dict(JA, DOI="")), "KEY00001")
    assert p["status"] == "plan"
    assert p["fills"] == {"journalAbbreviation": "Phys. Rev. Appl."}
    assert any("needs-identifier" in n and "journal abbreviation only" in n
               for n in p["notes"])


def test_issue_date_line_is_appended_when_years_differ(monkeypatch):
    fetched = dict(PRA_ITEM, extra="issue-date: 2022-01")
    p = _abbr_plan(monkeypatch, dict(JA, date="2021-12-20"), fetched)
    assert "issue-date: 2022-01" in p["extra_lines"]
    p = _abbr_plan(monkeypatch, dict(JA, date="2022-01-03"), fetched)
    assert not any(l.startswith("issue-date") for l in p["extra_lines"])
    p = _abbr_plan(monkeypatch, dict(JA, date="2021-12-20",
                                     extra="issue-date: 2022"), fetched)
    assert not any(l.startswith("issue-date") for l in p["extra_lines"])  # append-only


def test_issue_date_never_lands_on_a_preprint(monkeypatch):
    fetched = dict(PRA_ITEM, extra="issue-date: 2022-01")
    p = _abbr_plan(monkeypatch, dict(SSRN_PREPRINT, DOI="10.1103/x", date="2021"),
                   fetched)
    assert not any(l.startswith("issue-date") for l in p["extra_lines"])


# ---------- DataCite (#4): arXiv's own DOIs stay on the arXiv path ----------

def test_arxiv_doi_preprint_never_reaches_a_doi_registry(monkeypatch):
    # many libraries store arXiv's DataCite DOI on preprints; enrich must keep
    # reading arXiv for them, never CrossRef/DataCite (or it would re-stamp
    # an arxiv-sourced abstract as datacite)
    def no_doi_lookup(*a, **kw):
        raise AssertionError("DOI registry consulted")
    monkeypatch.setattr(md, "fetch_doi", no_doi_lookup)
    monkeypatch.setattr(md, "fetch_datacite", no_doi_lookup)
    item = {"itemType": "preprint", "title": "Attention Is All You Need",
            "abstractNote": "The dominant models.", "creators": [],
            "DOI": "10.48550/arXiv.1706.03762", "date": "2017-06-12",
            "extra": "abstract-source: arxiv", "url": "x", "archiveID": "arXiv:1706.03762",
            "repository": "arXiv", "tags": [], "collections": [], "relations": {}}
    seen = []
    monkeypatch.setattr(md, "fetch_arxiv_batch", lambda ids: seen.append(ids) or [
        {"id": ids[0], "item": {"itemType": "preprint", "title": item["title"],
                                "abstractNote": "The dominant models.",
                                "date": "2017-06-12", "creators": []}}])
    p = enrich.plan_enrich(_read_only_zot(item), "KEY00001")
    assert seen == [["1706.03762"]]
    assert p["status"] == "up-to-date" and p["fills"] == {}


def test_datacite_source_named_in_the_no_abstract_note(monkeypatch):
    thesis = {"itemType": "thesis", "title": "Codes", "DOI": "10.9999/thesis.2",
              "libraryCatalog": "DataCite", "creators": []}
    have = {"itemType": "thesis", "title": "Codes", "abstractNote": "",
            "DOI": "10.9999/thesis.2", "creators": [], "extra": "", "url": "x",
            "tags": [], "collections": [], "relations": {}, "university": "U"}
    p = _plan(monkeypatch, have, thesis, rebuild=False)
    assert any("DataCite has none for DOI 10.9999/thesis.2" in n for n in p["notes"])
