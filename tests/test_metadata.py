"""Offline tests for zotkit.metadata: the abstract cleaner and the two-layer
version-of-record predicate. No network — HTTP and CrossRef are faked."""
import types

import pytest

from zotkit import metadata as md
from zotkit.metadata import _clean_abstract


# ---------- _clean_abstract: markup path (JATS / HTML) ----------

def test_real_jats_sample():
    # shape of CrossRef abstracts (Springer/Wiley records): boilerplate title,
    # jats:sub/sup, hex + decimal entities (U+2009 thin spaces)
    jats = ('<jats:title>Abstract</jats:title><jats:p>We constrain the Hubble '
            'constant H<jats:sub>0</jats:sub> to a precision of '
            '10<jats:sup>−2</jats:sup> using data from the LIGO '
            'O3&#x2009;run. The strain sensitivity reaches '
            '10<jats:sup>−16</jats:sup>&#8201;Hz<jats:sup>−1/2</jats:sup>.'
            '</jats:p>')
    assert _clean_abstract(jats) == (
        "We constrain the Hubble constant H_0 to a precision of 10^−2 "
        "using data from the LIGO O3 run. The strain sensitivity reaches "
        "10^−16 Hz^−1/2.")


def test_section_titles_kept_abstract_dropped():
    sect = ('<jats:title>Abstract</jats:title><jats:sec><jats:title>Background'
            '</jats:title><jats:p>Sepsis is common.</jats:p></jats:sec>'
            '<jats:sec><jats:title>Methods</jats:title><jats:p>We did things.'
            '</jats:p></jats:sec>')
    assert _clean_abstract(sect) == (
        "Background: Sepsis is common. Methods: We did things.")


def test_unprefixed_html_sup_sub_any_case():
    assert _clean_abstract("<p>CO<SUB>2</SUB> at 10<Sup>3</Sup> ppm</p>") == \
        "CO_2 at 10^3 ppm"


def test_title_drop_case_insensitive():
    assert _clean_abstract(
        "<jats:title>ABSTRACT </jats:title><jats:p>x</jats:p>") == "x"


def test_entities_unescaped_whitespace_collapsed():
    assert _clean_abstract("<jats:p>a&amp;b   \n  c&#x2013;d</jats:p>") == \
        "a&b c–d"


def test_tags_become_spaces_no_word_gluing():
    assert _clean_abstract(
        "<jats:p><jats:italic>In vivo</jats:italic>results</jats:p>") == \
        "In vivo results"


# ---------- _clean_abstract: plain-text path ----------

def test_plain_arxiv_text_verbatim():
    # LaTeX with < > must never be mistaken for markup; newlines kept
    arxiv = "We show $x<y$ and $z>w$ for all\nsystems where $T < T_c$."
    assert _clean_abstract(arxiv) == arxiv


def test_empty_and_none_pass_through():
    assert _clean_abstract("") == ""
    assert _clean_abstract(None) is None


def test_nbsp_normalized():
    assert _clean_abstract("a\u00a0b") == "a b"


def test_soft_hyphen_removed_both_paths():
    assert _clean_abstract("hy\u00adphen") == "hyphen"
    assert _clean_abstract("<jats:p>hy\u00adphen</jats:p>") == "hyphen"


def test_unwrap_single_newlines_become_spaces():
    assert _clean_abstract("line one\nline two\nline three", unwrap=True) == \
        "line one line two line three"


def test_unwrap_paragraph_breaks_kept():
    assert _clean_abstract("para one line a\nline b\n\npara two", unwrap=True) \
        == "para one line a line b\n\npara two"


def test_unwrap_blankish_separator_lines():
    assert _clean_abstract("p1\n   \np2", unwrap=True) == "p1\n\np2"


def test_no_unwrap_by_default():
    assert _clean_abstract("a\nb") == "a\nb"


def test_whitespace_only_empty_after_unwrap():
    assert _clean_abstract("  \n \n ", unwrap=True) == ""


# ---------- layer 1: repository-DOI prefix blacklist ----------

@pytest.mark.parametrize("doi", [
    "10.48550/arXiv.2401.12345",        # arXiv (DataCite)
    "10.2139/ssrn.2407199",             # SSRN
    "10.1101/2024.01.01.573742",        # bioRxiv / medRxiv
    "10.21203/rs.3.rs-1/v1",            # Research Square
    "10.31219/osf.io/abc12",            # OSF
    "10.26434/chemrxiv-2024-abc",       # ChemRxiv
    "10.36227/techrxiv.12345",          # TechRxiv
    "10.20944/preprints202401.0001.v1", # Preprints.org
])
def test_repository_prefixes(doi):
    assert md.is_repository_doi(doi)


@pytest.mark.parametrize("doi", [
    "10.1103/PhysRevLett.116.061102",
    "10.1038/nature14539",
    "10.21031/other.prefix",  # 10.21031 ≠ 10.21203 — no substring false positive
    "",
])
def test_non_repository_dois(doi):
    assert not md.is_repository_doi(doi)


def test_repository_doi_normalization():
    assert md.is_repository_doi("10.2139/SSRN.999")
    assert md.is_repository_doi("https://doi.org/10.2139/ssrn.1")
    assert md.is_repository_doi("doi:10.1101/x")


# ---------- layer 2: record-level disguise guard ----------

def test_ssrn_pseudo_journal_flagged():
    assert md.repository_record_reason(
        {"itemType": "journalArticle",
         "publicationTitle": "SSRN Electronic Journal"}) is not None


def test_ssrn_container_case_and_space_insensitive():
    assert md.repository_record_reason(
        {"itemType": "journalArticle",
         "publicationTitle": "  ssrn  electronic  journal "}) is not None


def test_posted_content_flagged():
    assert md.repository_record_reason({"itemType": "preprint"}) is not None


def test_genuine_journal_passes():
    assert md.repository_record_reason(
        {"itemType": "journalArticle",
         "publicationTitle": "Physical Review Letters"}) is None


def test_conference_paper_container_checked():
    assert md.repository_record_reason(
        {"itemType": "conferencePaper",
         "proceedingsTitle": "SSRN Electronic Journal"}) is not None


# ---------- _journal_record + fetch_arxiv_batch use the predicate ----------

SSRN_ITEM = {"itemType": "journalArticle", "title": "Some Working Paper",
             "publicationTitle": "SSRN Electronic Journal",
             "DOI": "10.2139/ssrn.2407199", "creators": []}
PRL_ITEM = {"itemType": "journalArticle", "title": "GW150914",
            "publicationTitle": "Physical Review Letters",
            "DOI": "10.1103/PhysRevLett.116.061102", "creators": []}


def test_journal_record_raises_on_disguised_record(monkeypatch):
    pre = {"itemType": "preprint", "title": "T", "DOI": "10.2139/ssrn.2407199",
           "url": "https://arxiv.org/abs/2401.00001", "abstractNote": "AB"}
    monkeypatch.setattr(md, "fetch_doi", lambda doi: dict(SSRN_ITEM))
    with pytest.raises(md.NotVersionOfRecord):
        md._journal_record(dict(pre), "2401.00001")


def test_journal_record_upgrades_genuine_journal(monkeypatch):
    pre = {"itemType": "preprint", "title": "T", "DOI": "10.2139/ssrn.2407199",
           "url": "https://arxiv.org/abs/2401.00001", "abstractNote": "AB"}
    monkeypatch.setattr(md, "fetch_doi", lambda doi: dict(PRL_ITEM))
    j = md._journal_record(dict(pre), "2401.00001")
    assert j["itemType"] == "journalArticle"
    assert "arXiv: 2401.00001" in j["extra"]
    assert j["url"] == "https://arxiv.org/abs/2401.00001"  # open-access abs page
    # CrossRef record had no abstract: borrowed from the preprint, stamped
    assert j["abstractNote"] == "AB"
    assert "abstract-source: arxiv" in j["extra"]


# fetch_arxiv_batch against a canned Atom feed — exercises the real function,
# with only the HTTP layer (md._get) and the CrossRef fetch faked out.

_FEED = ('<?xml version="1.0" encoding="UTF-8"?>'
         '<feed xmlns="http://www.w3.org/2005/Atom" '
         'xmlns:arxiv="http://arxiv.org/schemas/atom">'
         '<entry>'
         '<id>http://arxiv.org/abs/{aid}v1</id>'
         '<title>Test Paper</title>'
         '<summary>An abstract.</summary>'
         '<published>2024-01-05T00:00:00Z</published>'
         '<author><name>Ada Lovelace</name></author>'
         '{doi}'
         '</entry></feed>')


def _serve_feed(monkeypatch, aid, doi_xml):
    xml = _FEED.format(aid=aid, doi=doi_xml)
    monkeypatch.setattr(
        md, "_get", lambda url, **kw: types.SimpleNamespace(status_code=200,
                                                            text=xml))


def test_batch_repository_doi_never_fetches_crossref(monkeypatch):
    _serve_feed(monkeypatch, "2401.00001",
                "<arxiv:doi>10.2139/ssrn.2407199</arxiv:doi>")

    def boom(doi):
        raise AssertionError("layer 1 must block the CrossRef fetch")
    monkeypatch.setattr(md, "fetch_doi", boom)
    res = md.fetch_arxiv_batch(["2401.00001"])[0]
    assert res["item"]["itemType"] == "preprint"
    assert "note" not in res and "error" not in res and "warning" not in res


def test_batch_no_doi_defaults_to_arxiv_datacite(monkeypatch):
    # no <arxiv:doi> element → the default 10.48550 DOI, also layer-1 blocked
    _serve_feed(monkeypatch, "2401.00001", "")
    monkeypatch.setattr(md, "fetch_doi",
                        lambda doi: pytest.fail("must not fetch CrossRef"))
    res = md.fetch_arxiv_batch(["2401.00001"])[0]
    assert res["item"]["DOI"] == "10.48550/arXiv.2401.00001"
    assert res["item"]["itemType"] == "preprint"


def test_batch_journal_doi_builds_journal_record(monkeypatch):
    _serve_feed(monkeypatch, "2401.00001",
                "<arxiv:doi>10.1103/PhysRevLett.116.061102</arxiv:doi>")
    monkeypatch.setattr(md, "fetch_doi", lambda doi: dict(PRL_ITEM))
    res = md.fetch_arxiv_batch(["2401.00001"])[0]
    assert res["item"]["itemType"] == "journalArticle"
    assert "building journal record" in res["note"]
    assert "arXiv: 2401.00001" in res["item"]["extra"]


def test_batch_disguised_record_keeps_preprint_with_note(monkeypatch):
    # non-blacklist prefix, but CrossRef resolves it to the SSRN pseudo-journal
    _serve_feed(monkeypatch, "2401.00001",
                "<arxiv:doi>10.9999/fake.1</arxiv:doi>")
    monkeypatch.setattr(md, "fetch_doi", lambda doi: dict(SSRN_ITEM))
    res = md.fetch_arxiv_batch(["2401.00001"])[0]
    assert res["item"]["itemType"] == "preprint"
    assert "not a version of record" in res["note"]
    assert "pseudo-journal" in res["note"]


def test_batch_lookup_failure_keeps_preprint_with_warning(monkeypatch):
    _serve_feed(monkeypatch, "2401.00001",
                "<arxiv:doi>10.1103/PhysRevLett.116.061102</arxiv:doi>")

    def fail(doi):
        raise md.MetadataError("CrossRef is down")
    monkeypatch.setattr(md, "fetch_doi", fail)
    res = md.fetch_arxiv_batch(["2401.00001"])[0]
    assert res["item"]["itemType"] == "preprint"
    assert "keeping preprint record" in res["warning"]
    assert "note" not in res


def test_batch_bad_id_fails_alone_without_network():
    res = md.fetch_arxiv_batch(["!!not-an-id!!"])
    assert len(res) == 1 and "error" in res[0]


# ---------- fetch_doi: journal abbreviation + issue-date line ----------
# CrossRef is faked at md._get; the journal normaliser gets an injected table.

def _crossref(monkeypatch, **msg):
    base = {"type": "journal-article", "title": ["T"],
            "author": [{"given": "A", "family": "B"}],
            "container-title": ["Physical Review Letters"],
            "short-container-title": ["Phys Rev Lett"],
            "issued": {"date-parts": [[2022, 12, 20]]}}
    base.update(msg)
    resp = types.SimpleNamespace(status_code=200, json=lambda: {"message": base})
    monkeypatch.setattr(md, "_get", lambda url, **kw: resp)
    monkeypatch.setattr(md.journals, "_registered",
                        {"physical review letters": "Phys. Rev. Lett."})


def test_fetch_doi_writes_the_registered_abbreviation(monkeypatch):
    _crossref(monkeypatch)
    assert md.fetch_doi("10.1/x")["journalAbbreviation"] == "Phys. Rev. Lett."


def test_fetch_doi_keeps_crossrefs_value_when_the_normaliser_has_no_opinion(monkeypatch):
    _crossref(monkeypatch, **{"container-title": ["Unknown Letters"]})
    assert md.fetch_doi("10.1/x")["journalAbbreviation"] == "Phys Rev Lett"


def test_issue_date_line_when_the_issue_year_differs(monkeypatch):
    _crossref(monkeypatch, **{"journal-issue": {"published-print": {"date-parts": [[2023, 1]]}}})
    assert "issue-date: 2023-01" in md.fetch_doi("10.1/x")["extra"]


def test_issue_date_falls_back_to_published_print(monkeypatch):
    _crossref(monkeypatch, **{"published-print": {"date-parts": [[2023]]}})
    assert "issue-date: 2023" in md.fetch_doi("10.1/x")["extra"]


def test_no_issue_date_line_when_the_year_matches(monkeypatch):
    _crossref(monkeypatch, **{"journal-issue": {"published-print": {"date-parts": [[2022, 12]]}}})
    assert "issue-date" not in md.fetch_doi("10.1/x").get("extra", "")


def test_no_issue_date_line_on_preprints(monkeypatch):
    _crossref(monkeypatch, type="posted-content",
              **{"published-print": {"date-parts": [[2023]]}})
    assert "issue-date" not in md.fetch_doi("10.1/x").get("extra", "")


def test_a_candidate_only_fills_an_empty_crossref_value(monkeypatch, tmp_path):
    ltwa = tmp_path / "ltwa.tsv"
    ltwa.write_text("WORD\tABBREVIATION\tLANGUAGES\nunknown\tunkn.\tEnglish\n"
                    "letter\tlett.\tEnglish\n", encoding="utf-8")
    monkeypatch.setenv("ZOTKIT_LTWA", str(ltwa))
    _crossref(monkeypatch, **{"container-title": ["Unknown Letters"]})
    assert md.fetch_doi("10.1/x")["journalAbbreviation"] == "Phys Rev Lett"
    _crossref(monkeypatch, **{"container-title": ["Unknown Letters"],
                              "short-container-title": []})
    assert md.fetch_doi("10.1/x")["journalAbbreviation"] == "Unkn. Lett."


def test_journal_record_upgrade_keeps_the_issue_date_line(monkeypatch):
    _serve_feed(monkeypatch, "2401.00001",
                "<arxiv:doi>10.1103/PhysRevLett.116.061102</arxiv:doi>")
    monkeypatch.setattr(md, "fetch_doi",
                        lambda doi: dict(PRL_ITEM, extra="issue-date: 2016-02"))
    res = md.fetch_arxiv_batch(["2401.00001"])[0]
    assert "issue-date: 2016-02" in res["item"]["extra"]
    assert "arXiv: 2401.00001" in res["item"]["extra"]


# ---------- DataCite: fetch_doi's fallback when CrossRef has no record ----------
# Records are hand-written in the shape api.datacite.org/dois/<doi> returns.

def _datacite(attrs):
    return {"data": {"attributes": attrs}}


THESIS = _datacite({
    "types": {"resourceTypeGeneral": "Dissertation", "resourceType": "Thesis"},
    "creators": [{"name": "Doe, Jane", "nameType": "Personal",
                  "givenName": "Jane", "familyName": "Doe"}],
    "contributors": [{"name": "Example University", "contributorType": "HostingInstitution"},
                     {"name": "Roe, Richard", "contributorType": "Supervisor"}],
    "titles": [{"title": "Cold Atoms in Shaken Lattices"}],
    "publisher": "Theory Group, Department of Physics, Example University",
    "publicationYear": 2016,
    "dates": [{"date": "2016-12-13", "dateType": "Issued"},
              {"date": "2016-12-20", "dateType": "Available"}],
    "descriptions": [{"description": "Deposited under a CC BY licence.",
                      "descriptionType": "Other"},
                     {"description": "<p>We study atoms in H<sub>2</sub>.</p>",
                      "descriptionType": "Abstract"}],
    "language": "en", "url": "https://repository.example.edu/handle/1/2"})


def _fake_http(monkeypatch, routes):
    """routes: {host: (status, json)}; records every URL asked for."""
    calls = []

    def get(url, **kw):
        calls.append(url)
        status, body = routes[httpx_host(url)]
        return types.SimpleNamespace(status_code=status, json=lambda: body)
    monkeypatch.setattr(md, "_get", get)
    return calls


def httpx_host(url):
    return url.split("/")[2]


def test_crossref_miss_falls_back_to_datacite(monkeypatch):
    calls = _fake_http(monkeypatch, {"api.crossref.org": (404, {}),
                                     "api.datacite.org": (200, THESIS)})
    item = md.fetch_doi("https://doi.org/10.9999/thesis.1")
    assert [httpx_host(u) for u in calls] == ["api.crossref.org", "api.datacite.org"]
    assert item["itemType"] == "thesis"
    assert item["creators"] == [{"creatorType": "author", "firstName": "Jane",
                                 "lastName": "Doe"}]
    assert item["university"] == "Example University"   # not the research group
    assert "publisher" not in item
    assert item["date"] == "2016-12-13"
    assert item["abstractNote"] == "We study atoms in H_2."
    assert item["extra"] == "abstract-source: datacite"
    assert item["libraryCatalog"] == "DataCite"
    assert "thesisType" not in item


def test_text_dissertation_dated_by_publication_year(monkeypatch):
    # a scan put online decades later: "Available" is not the thesis's date
    rec = _datacite({
        "types": {"resourceTypeGeneral": "Text", "resourceType": "Dissertation"},
        "creators": [{"name": "Poe, Ann", "nameType": "Personal"}],
        "titles": [{"title": "Codes"}], "publisher": "Example Institute",
        "publicationYear": 1997, "version": "Final",
        "dates": [{"date": "2004-07-16", "dateType": "Available"}]})
    _fake_http(monkeypatch, {"api.crossref.org": (404, {}),
                             "api.datacite.org": (200, rec)})
    item = md.fetch_doi("10.9999/thesis.2")
    assert item["itemType"] == "thesis" and item["date"] == "1997"
    assert item["university"] == "Example Institute"
    assert item["creators"][0] == {"creatorType": "author", "firstName": "Ann",
                                   "lastName": "Poe"}
    assert "extra" not in item                          # no abstract, no stamp
    assert "versionNumber" not in item                  # theses have no such field


def test_datacite_software_uses_zotero_field_names(monkeypatch):
    rec = _datacite({
        "types": {"resourceTypeGeneral": "Software"},
        "creators": [{"name": "Example Project", "nameType": "Organizational"}],
        "titles": [{"title": "simtool"}], "publisher": "Zenodo",
        "publicationYear": 2019, "version": "1.2.0", "dates": []})
    _fake_http(monkeypatch, {"api.crossref.org": (404, {}),
                             "api.datacite.org": (200, rec)})
    item = md.fetch_doi("10.9999/zenodo.3")
    assert item["itemType"] == "computerProgram"
    assert item["creators"] == [{"creatorType": "programmer", "name": "Example Project"}]
    assert item["company"] == "Zenodo" and item["versionNumber"] == "1.2.0"


def test_unmapped_datacite_type_is_an_error(monkeypatch):
    rec = _datacite({"types": {"resourceTypeGeneral": "Image"},
                     "titles": [{"title": "A figure"}]})
    _fake_http(monkeypatch, {"api.crossref.org": (404, {}),
                             "api.datacite.org": (200, rec)})
    with pytest.raises(md.MetadataError, match="DataCite type 'Image'.*--file"):
        md.fetch_doi("10.9999/fig.4")


def test_doi_in_neither_registry_says_so(monkeypatch):
    _fake_http(monkeypatch, {"api.crossref.org": (404, {}),
                             "api.datacite.org": (404, {})})
    with pytest.raises(md.MetadataError,
                       match="not in CrossRef or DataCite.*--file"):
        md.fetch_doi("10.99999/d.other.2023.000001")


def test_crossref_outage_does_not_fall_back(monkeypatch):
    calls = _fake_http(monkeypatch, {"api.crossref.org": (503, {})})
    with pytest.raises(md.MetadataError, match="HTTP 503"):
        md.fetch_doi("10.9999/x.5")
    assert len(calls) == 1


def test_arxiv_datacite_doi_points_to_create_arxiv(monkeypatch):
    calls = _fake_http(monkeypatch, {})
    with pytest.raises(md.MetadataError, match="create --arxiv 1706.03762"):
        md.fetch_doi("10.48550/arXiv.1706.03762")
    assert calls == []


def test_datacite_preprint_is_never_a_version_of_record(monkeypatch):
    rec = _datacite({"types": {"resourceTypeGeneral": "Preprint"},
                     "creators": [], "titles": [{"title": "Draft"}],
                     "publisher": "Example Archive", "publicationYear": 2024})
    _fake_http(monkeypatch, {"api.crossref.org": (404, {}),
                             "api.datacite.org": (200, rec)})
    item = md.fetch_doi("10.9999/pre.6")
    assert item["repository"] == "Example Archive"
    assert md.repository_record_reason(item)


def test_crossref_dissertation_takes_the_institution_not_the_library(monkeypatch):
    msg = {"message": {"type": "dissertation", "title": ["A Thesis"],
                       "publisher": "Example University Libraries",
                       "institution": [{"name": "Example University", "acronym": ["EU"]}],
                       "issued": {"date-parts": [[2020]]}}}
    _fake_http(monkeypatch, {"api.crossref.org": (200, msg)})
    item = md.fetch_doi("10.9999/diss.7")
    assert item["university"] == "Example University" and "publisher" not in item


def test_crossref_lab_report_takes_the_lab_not_the_distributor(monkeypatch):
    # the shape of an OSTI-registered report (10.2172/*)
    msg = {"message": {"type": "report", "title": ["A Lab Report"],
                       "publisher": "Office of Scientific and Technical Information (OSTI)",
                       "institution": [{"name": "Example National Laboratory (ENL)",
                                        "acronym": ["ENL"]},
                                       {"name": "Example Office of Science (SC)"}],
                       "issued": {"date-parts": [[2010]]}}}
    _fake_http(monkeypatch, {"api.crossref.org": (200, msg)})
    item = md.fetch_doi("10.9999/report.11")
    assert item["institution"] == "Example National Laboratory (ENL)"


def test_crossref_report_without_institution_leaves_the_field_empty(monkeypatch):
    msg = {"message": {"type": "report", "title": ["A Report"],
                       "publisher": "Office of Scientific and Technical Information (OSTI)",
                       "issued": {"date-parts": [[2010]]}}}
    _fake_http(monkeypatch, {"api.crossref.org": (200, msg)})
    assert "institution" not in md.fetch_doi("10.9999/report.12")


def test_no_editor_role_on_types_without_one(monkeypatch):
    rec = {"data": {"attributes": dict(
        THESIS["data"]["attributes"],
        contributors=[{"name": "Roe, Richard", "nameType": "Personal",
                       "contributorType": "Editor"}])}}
    _fake_http(monkeypatch, {"api.crossref.org": (404, {}),
                             "api.datacite.org": (200, rec)})
    item = md.fetch_doi("10.9999/thesis.8")
    assert [c["creatorType"] for c in item["creators"]] == ["author"]


def test_text_needs_a_whole_word_to_be_a_thesis(monkeypatch):
    rec = _datacite({"types": {"resourceTypeGeneral": "Text",
                               "resourceType": "Synthesis report"},
                     "titles": [{"title": "Review"}]})
    _fake_http(monkeypatch, {"api.crossref.org": (404, {}),
                             "api.datacite.org": (200, rec)})
    with pytest.raises(md.MetadataError, match="DataCite type 'Text'"):
        md.fetch_doi("10.9999/text.9")


@pytest.mark.parametrize("itype", ["dataset", "computerProgram"])
def test_a_data_or_code_doi_never_upgrades_an_arxiv_preprint(monkeypatch, itype):
    # an author can put the paper's Zenodo deposit in arXiv's DOI field
    monkeypatch.setattr(md, "fetch_doi", lambda doi: {"itemType": itype,
                                                      "title": "Code for X"})
    with pytest.raises(md.NotVersionOfRecord, match=itype):
        md._journal_record({"DOI": "10.9999/zenodo.10", "url": "u"}, "2401.00001")
