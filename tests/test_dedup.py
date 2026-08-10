"""Offline tests for the create-path dedup predicate: the shared
`dedup_maps`/`duplicate_key` helper, the existing_key recorded by
`Zot.create_items`, and the dry-run `!!` notice. No network, no live library —
the Zotero client is faked."""
from zotkit.cli import dup_notice
from zotkit.core import Zot, dedup_maps, duplicate_key


def _lib(*rows):
    """rows: (key, title, DOI) -> pyzotero-shaped top-level items."""
    return [{"key": k, "data": {"title": t, "DOI": doi, "itemType": "journalArticle"}}
            for k, t, doi in rows]


LIBRARY = _lib(
    ("AAAA1111", "Attention Is All You Need", "10.5555/ATT"),
    ("BBBB2222", "Deep Residual Learning, Revisited!", ""),
    ("CCCC3333", "Some Other Paper", "10.1103/PhysRevLett.116.061102"),
)


# ---------- the helper ----------

def test_doi_match_is_case_and_whitespace_insensitive():
    doi_map, title_map = dedup_maps(LIBRARY)
    d = {"title": "totally different title", "DOI": "  10.5555/att  "}
    assert duplicate_key(d, doi_map, title_map) == "AAAA1111"


def test_normalized_title_match():
    doi_map, title_map = dedup_maps(LIBRARY)
    d = {"title": "deep residual learning revisited"}
    assert duplicate_key(d, doi_map, title_map) == "BBBB2222"


def test_doi_wins_when_doi_and_title_point_at_different_items():
    doi_map, title_map = dedup_maps(LIBRARY)
    d = {"title": "Some Other Paper", "DOI": "10.5555/ATT"}
    assert duplicate_key(d, doi_map, title_map) == "AAAA1111"


def test_no_match_returns_none():
    doi_map, title_map = dedup_maps(LIBRARY)
    d = {"title": "A Brand New Paper", "DOI": "10.9999/new.1"}
    assert duplicate_key(d, doi_map, title_map) is None


def test_items_without_doi_do_not_poison_the_doi_map():
    doi_map, _ = dedup_maps(LIBRARY)
    assert "" not in doi_map
    assert set(doi_map) == {"10.5555/att", "10.1103/physrevlett.116.061102"}
    # an incoming item with no DOI falls through to the title check only
    _, title_map = dedup_maps(LIBRARY)
    assert duplicate_key({"title": "A Brand New Paper"}, doi_map, title_map) is None


def test_unknown_doi_still_matches_on_title():
    doi_map, title_map = dedup_maps(LIBRARY)
    d = {"title": "attention is all you need", "DOI": "10.9999/unseen"}
    assert duplicate_key(d, doi_map, title_map) == "AAAA1111"


def test_first_writer_wins_on_duplicate_library_rows():
    doi_map, title_map = dedup_maps(_lib(("KEY00001", "T", "10.1/x"),
                                         ("KEY00002", "T", "10.1/x")))
    assert duplicate_key({"title": "T", "DOI": "10.1/X"}, doi_map, title_map) == "KEY00001"


# ---------- create_items records the existing key ----------

class FakeZ:
    def __init__(self, existing):
        self._existing = existing
        self.created_payloads = []

    def top(self):
        return "TOP"

    def everything(self, _):
        return self._existing

    def item_template(self, itemtype):
        return {"itemType": itemtype, "title": "", "DOI": "", "tags": [],
                "collections": []}

    def create_items(self, payloads):
        self.created_payloads.append(payloads)
        return {"successful": {str(i): {"key": f"NEW0000{i}"}
                               for i in range(len(payloads))}, "failed": {}}


def _zot(existing):
    z = Zot.__new__(Zot)
    z.z = FakeZ(existing)
    z.conventions = None
    return z


def test_create_items_records_existing_key_in_skipped_meta():
    z = _zot(LIBRARY)
    out = z.create_items([{"itemType": "journalArticle", "title": "Fresh One"},
                          {"itemType": "journalArticle",
                           "title": "attention is all you need!"}])
    created = [r for r in out if r.get("key")]
    skipped = [r for r in out if r.get("skipped")]
    assert [c["title"] for c in created] == ["Fresh One"]
    assert skipped == [{"title": "attention is all you need!",
                        "skipped": "duplicate", "existing_key": "AAAA1111"}]


def test_create_items_skips_on_doi_and_names_that_item():
    z = _zot(LIBRARY)
    out = z.create_items([{"itemType": "journalArticle", "title": "Renamed Paper",
                           "DOI": "10.5555/ATT"}])
    assert out == [{"title": "Renamed Paper", "skipped": "duplicate",
                    "existing_key": "AAAA1111"}]
    assert z.z.created_payloads == []  # nothing sent to the API


def test_create_items_no_dedup_creates_everything():
    z = _zot(LIBRARY)
    out = z.create_items([{"itemType": "journalArticle",
                           "title": "Attention Is All You Need"}], dedup=False)
    assert len(out) == 1 and out[0]["key"] == "NEW00000"


# ---------- the dry-run notice ----------

def test_dup_notice_shape():
    doi_map, title_map = dedup_maps(LIBRARY)
    msg = dup_notice({"title": "Attention Is All You Need"}, doi_map, title_map)
    assert msg == ("!! already in library as AAAA1111 — --apply will skip it "
                   "(use --no-dedup to force)")


def test_dup_notice_none_for_new_item():
    doi_map, title_map = dedup_maps(LIBRARY)
    assert dup_notice({"title": "Brand New", "DOI": "10.9/z"}, doi_map, title_map) is None


def test_dup_notice_with_empty_maps_never_warns():
    assert dup_notice({"title": "Attention Is All You Need"}, {}, {}) is None


def test_dup_notice_names_the_doi_match_not_the_title_match():
    doi_map, title_map = dedup_maps(LIBRARY)
    msg = dup_notice({"title": "Some Other Paper", "DOI": "10.5555/att"},
                     doi_map, title_map)
    assert "AAAA1111" in msg and "CCCC3333" not in msg


def test_empty_library_yields_empty_maps():
    assert dedup_maps([]) == ({}, {})
    assert duplicate_key({"title": "Anything"}, {}, {}) is None
