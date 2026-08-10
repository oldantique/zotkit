"""Offline tests for zotkit.export: the cite-key rewrite and the per-key
BibTeX fetch loop. No network — httpx.get is faked."""
import types

import httpx

from zotkit import export

ENTRY = """@article{smith2019climate,
\ttitle = {A Title},
\tauthor = {Smith, Jane},
\tjournal = {Nature},
}
"""


def _zot():
    return types.SimpleNamespace(env={"ZOTERO_LIBRARY_ID": "123",
                                      "ZOTERO_API_KEY": "k"})


class FakeResponse:
    def __init__(self, status_code, text=""):
        self.status_code = status_code
        self.text = text


def _fake_get(mapping, calls=None):
    """Build an httpx.get replacement serving {item key -> FakeResponse}."""
    def get(url, params=None, headers=None, timeout=None):
        key = url.rsplit("/", 1)[-1]
        if calls is not None:
            calls.append((url, params, headers))
        return mapping.get(key, FakeResponse(404))
    return get


# ---------- _rekey ----------

def test_rekey_plain_entry():
    out = export._rekey(ENTRY, "ABCD1234")
    assert out.startswith("@article{ABCD1234,")
    assert out[out.index("\n"):] == ENTRY[ENTRY.index("\n"):]  # rest untouched


def test_rekey_tolerates_leading_whitespace_and_newlines():
    out = export._rekey("\n\n  " + ENTRY, "ABCD1234")
    assert "@article{ABCD1234," in out
    assert out.startswith("\n\n  @article{")  # leading run preserved


def test_rekey_replaces_weird_cite_key():
    src = "@inproceedings{van der Berg_2019:éß-x,\n  title = {T},\n}\n"
    assert export._rekey(src, "K1").startswith("@inproceedings{K1,")


def test_rekey_only_touches_the_first_header_line():
    src = ("@article{old,\n  title = {Email @home and @{braces}},\n"
           "  note = {@article{other, x}},\n}\n")
    out = export._rekey(src, "K1")
    assert out == src.replace("@article{old,", "@article{K1,", 1)
    assert "@article{other, x}" in out


def test_rekey_second_entry_in_a_concatenation_is_left_alone():
    src = ENTRY + "\n" + "@book{second,\n  title = {B},\n}\n"
    out = export._rekey(src, "K1")
    assert "@book{second," in out
    assert out.count("K1") == 1


def test_rekey_handles_empty_and_whitespace_input():
    assert export._rekey("", "K1") == ""
    assert export._rekey("   \n", "K1") == "   \n"


def test_rekey_leaves_non_entry_text_untouched():
    assert export._rekey("not bibtex at all\n", "K1") == "not bibtex at all\n"


# ---------- export_bibtex ----------

def test_two_good_keys_concatenated_in_input_order_with_new_cite_keys(monkeypatch):
    calls = []
    monkeypatch.setattr(httpx, "get", _fake_get({
        "AAAA1111": FakeResponse(200, ENTRY),
        "BBBB2222": FakeResponse(200, "\n@book{other2020,\n  title = {B},\n}\n"),
    }, calls))
    text, failed = export.export_bibtex(_zot(), ["BBBB2222", "AAAA1111"])
    assert failed == []
    assert text.index("@book{BBBB2222,") < text.index("@article{AAAA1111,")
    assert "smith2019climate" not in text and "other2020" not in text
    assert text.endswith("\n")
    # request shape: bibtex format, API key header, library path
    url, params, headers = calls[0]
    assert url == "https://api.zotero.org/users/123/items/BBBB2222"
    assert params == {"format": "bibtex"}
    assert headers["Zotero-API-Key"] == "k"


def test_unknown_key_is_reported_but_others_still_export(monkeypatch, capsys):
    monkeypatch.setattr(httpx, "get", _fake_get({
        "AAAA1111": FakeResponse(200, ENTRY)}))
    text, failed = export.export_bibtex(_zot(), ["AAAA1111", "NOPE0000"])
    assert failed == ["NOPE0000"]
    assert "@article{AAAA1111," in text
    assert "NOPE0000" in capsys.readouterr().err


def test_non_404_error_status_also_fails_the_key(monkeypatch, capsys):
    monkeypatch.setattr(httpx, "get", _fake_get({
        "AAAA1111": FakeResponse(500, "boom")}))
    text, failed = export.export_bibtex(_zot(), ["AAAA1111"])
    assert failed == ["AAAA1111"] and text == ""
    assert "500" in capsys.readouterr().err


def test_group_library_type_changes_the_url(monkeypatch):
    calls = []
    monkeypatch.setattr(httpx, "get", _fake_get(
        {"AAAA1111": FakeResponse(200, ENTRY)}, calls))
    zot = types.SimpleNamespace(env={"ZOTERO_LIBRARY_ID": "999",
                                     "ZOTERO_API_KEY": "k",
                                     "ZOTERO_LIBRARY_TYPE": "group"})
    export.export_bibtex(zot, ["AAAA1111"])
    assert calls[0][0] == "https://api.zotero.org/groups/999/items/AAAA1111"


def test_all_keys_failing_yields_empty_text(monkeypatch):
    monkeypatch.setattr(httpx, "get", _fake_get({}))
    text, failed = export.export_bibtex(_zot(), ["X1", "X2"])
    assert text == "" and failed == ["X1", "X2"]
