"""Offline tests for tag linting — in particular that lint_tags accepts both
plain-string tags and Zotero's native {"tag": ...} dict shape (a --file JSON
using the API's own format used to crash with AttributeError)."""
import pytest

from zotkit.core import Conventions, _tag_strings, lint_tags

CONV = Conventions({"namespaces": ["field", "status"], "require": ["field"],
                    "closed": {"field": ["quantum", "ai"]}})


def lint(tags, **kw):
    return lint_tags(tags, conventions=CONV, auto_load=False, **kw)


def test_string_tags_pass():
    assert lint(["field:quantum", "status:to-read"]) == []


def test_dict_shape_tags_lint_identically_to_strings():
    strings = ["field:quantum", "status:to-read"]
    dicts = [{"tag": t} for t in strings]
    assert lint(dicts) == lint(strings) == []


def test_dict_shape_violations_are_still_caught():
    problems = lint([{"tag": "field:nope"}, {"tag": "NoNamespace"}])
    assert any("field:nope" in p for p in problems)
    assert any("NoNamespace" in p for p in problems)


def test_mixed_shapes_in_one_list():
    assert lint(["field:quantum", {"tag": "status:to-read"}]) == []


def test_missing_required_namespace_reported_for_dict_shape():
    (problem,) = lint([{"tag": "status:to-read"}])
    assert "missing a 'field:'" in problem


def test_tag_strings_helper_normalizes_both_shapes():
    assert _tag_strings(["a:b", {"tag": "c:d"}]) == ["a:b", "c:d"]
    assert _tag_strings([]) == []


def test_no_conventions_still_accepts_dict_shape():
    # the pre-fix crash didn't need conventions to trigger in create_items
    assert lint_tags([{"tag": "anything"}], conventions=None,
                     auto_load=False) == []
