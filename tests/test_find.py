"""Offline tests for `find --any` / `find --abstract`: metadata-wide matching,
AND-composition with the existing filters, hit annotations, and snippet shape.
`Zot.find` is called unbound against a fake self — no network, no live library.
"""
import types

from zotkit import core
from zotkit.core import Zot, _any_hit, _snippet


ABSTRACT = ("We demonstrate repeated quantum error correction on a surface "
            "code, sustaining a logical qubit beyond the break-even point "
            "for the first time in a superconducting architecture. These "
            "results open a path toward fault-tolerant quantum computation "
            "at practically relevant scale.")

ITEMS = [
    {"key": "TITL0001", "data": {
        "itemType": "journalArticle", "title": "Boson Sampling at Scale",
        "abstractNote": "", "extra": "", "creators": [],
        "tags": [{"tag": "field:quantum"}], "collections": ["CQ"]}},
    {"key": "ABST0002", "data": {
        "itemType": "preprint", "title": "A Preprint",
        "abstractNote": ABSTRACT, "extra": "",
        "creators": [{"creatorType": "author", "firstName": "C. C.",
                      "lastName": "Bultink"}],
        "tags": [{"tag": "status:to-read"}], "collections": ["CQ"]}},
    {"key": "EXTR0003", "data": {
        "itemType": "book", "title": "Unrelated Book",
        "abstractNote": "", "extra": "abstract-source: cnki\nOCLC: 12345",
        "creators": [{"creatorType": "editor", "name": "The OQP Committee"}],
        "tags": [], "collections": []}},
]


def fake_zot(items=ITEMS):
    return types.SimpleNamespace(
        z=types.SimpleNamespace(everything=lambda x: x, top=lambda: items),
        collection_key=lambda name: {"Quantum": "CQ"}.get(name),
        collection_names=lambda: {"CQ": "Quantum"},
    )


def find(**kw):
    return Zot.find(fake_zot(), **kw)


def keys(rows):
    return [r["key"] for r in rows]


# ---------- --any: one match path per field ----------

def test_any_matches_title():
    assert keys(find(any_text="boson sampling")) == ["TITL0001"]


def test_any_matches_abstract():
    assert keys(find(any_text="break-even")) == ["ABST0002"]


def test_any_matches_creator_last_name():
    assert keys(find(any_text="bultink")) == ["ABST0002"]


def test_any_matches_creator_first_name_and_single_field_name():
    assert keys(find(any_text="C. C.")) == ["ABST0002"]
    assert keys(find(any_text="oqp committee")) == ["EXTR0003"]


def test_any_matches_tag():
    assert keys(find(any_text="to-read")) == ["ABST0002"]


def test_any_matches_extra():
    assert keys(find(any_text="OCLC")) == ["EXTR0003"]


def test_any_is_case_insensitive_both_ways():
    assert keys(find(any_text="BOSON")) == ["TITL0001"]
    assert keys(find(any_text="oclc")) == ["EXTR0003"]


def test_any_no_match_returns_empty():
    assert find(any_text="zzz-not-anywhere") == []


# ---------- annotation rules ----------

def test_title_and_tag_hits_carry_no_annotation():
    assert find(any_text="boson")[0]["hits"] == []
    assert find(any_text="status:to-read")[0]["hits"] == []


def test_creator_hit_names_the_creator():
    hits = find(any_text="bultink")[0]["hits"]
    assert hits == [{"field": "creator", "text": "C. C. Bultink"}]


def test_abstract_hit_carries_a_context_snippet():
    (hit,) = find(any_text="break-even")[0]["hits"]
    assert hit["field"] == "abstract"
    assert "break-even" in hit["text"]
    assert hit["text"].startswith("...") and hit["text"].endswith("...")


def test_extra_hit_snippet_is_one_line():
    (hit,) = find(any_text="OCLC")[0]["hits"]
    assert hit["field"] == "extra"
    assert "\n" not in hit["text"]
    assert "OCLC" in hit["text"]


def test_title_beats_other_fields_when_both_match():
    item = {"key": "K1", "data": {"itemType": "note0", "title": "surface code",
                                  "abstractNote": "surface code here too",
                                  "extra": "", "creators": [], "tags": [],
                                  "collections": []}}
    rows = Zot.find(fake_zot([item]), any_text="surface code")
    assert rows[0]["hits"] == []          # visible in the title — no annotation


# ---------- --abstract ----------

def test_abstract_flag_matches_only_the_abstract():
    assert keys(find(abstract="surface code")) == ["ABST0002"]
    assert find(abstract="boson") == []   # title-only text doesn't count


def test_abstract_flag_always_annotates():
    (hit,) = find(abstract="logical qubit")[0]["hits"]
    assert hit["field"] == "abstract" and "logical qubit" in hit["text"]


def test_any_and_abstract_do_not_duplicate_the_same_hit():
    rows = find(any_text="break-even point", abstract="break-even point")
    assert len(rows[0]["hits"]) == 1


# ---------- AND-composition with the existing filters ----------

def test_any_composes_with_tag():
    assert keys(find(any_text="quantum", tag="status:to-read")) == ["ABST0002"]


def test_any_composes_with_collection():
    assert keys(find(any_text="quantum", collection="Quantum")) == \
        ["TITL0001", "ABST0002"]
    assert keys(find(any_text="OCLC", collection="Quantum")) == []


def test_any_composes_with_title():
    assert keys(find(any_text="quantum", title="boson")) == ["TITL0001"]


def test_plain_filters_still_work_and_records_gain_empty_hits():
    rows = find(tag="field:quantum")
    assert keys(rows) == ["TITL0001"] and rows[0]["hits"] == []


# ---------- _snippet shape ----------

def test_snippet_short_text_has_no_ellipses():
    assert _snippet("a tiny abstract", "tiny") == "a tiny abstract"


def test_snippet_truncates_to_context_window():
    text = "x" * 200 + " NEEDLE " + "y" * 200
    s = _snippet(text, "needle")
    assert s.startswith("...") and s.endswith("...")
    assert "NEEDLE" in s
    assert len(s) <= 60 * 2 + len("needle") + 8   # ±60 ctx + needle + ellipses


def test_snippet_collapses_internal_whitespace():
    assert _snippet("line one\n\tline  two", "one") == "line one line two"


def test_any_hit_handles_missing_optional_fields():
    assert _any_hit({"title": "T"}, [], "nope") is None
