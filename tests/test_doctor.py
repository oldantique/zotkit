"""Offline tests for `zotkit doctor`'s schema line (#6): a warning when
Zotero's global schema moves past the verified baseline, never a failure.
HTTP is faked."""
from zotkit import cli


def _schema(monkeypatch, version=None, exc=None):
    import httpx

    def get(url, **kw):
        if exc:
            raise exc
        return httpx.Response(200, json={"version": version})
    monkeypatch.setattr(httpx, "get", get)


def test_schema_at_baseline(monkeypatch):
    from zotkit.core import SCHEMA_BASELINE
    _schema(monkeypatch, SCHEMA_BASELINE)
    assert cli._schema_check().startswith(f"✓ Zotero schema: version {SCHEMA_BASELINE}")


def test_schema_past_baseline_warns(monkeypatch):
    from zotkit.core import SCHEMA_BASELINE
    _schema(monkeypatch, SCHEMA_BASELINE + 1)
    assert cli._schema_check().startswith(
        f"⚠ Zotero schema: version {SCHEMA_BASELINE + 1} is newer than")


def test_schema_unreachable_warns(monkeypatch):
    import httpx
    _schema(monkeypatch, exc=httpx.ConnectError("offline"))
    assert cli._schema_check() == "⚠ Zotero schema: could not check (ConnectError)"
