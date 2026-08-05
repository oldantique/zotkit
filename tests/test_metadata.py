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
