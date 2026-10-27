"""Suite-wide isolation: the journal normaliser sees an empty registered
table and no LTWA file unless a test injects them, so neither the shipped
table's contents nor a developer's ZOTKIT_LTWA changes other tests' results."""
import pytest

from zotkit import journals


@pytest.fixture(autouse=True)
def _isolated_journal_sources(monkeypatch):
    monkeypatch.setattr(journals, "_registered", {})
    monkeypatch.delenv("ZOTKIT_LTWA", raising=False)
    monkeypatch.delenv("ZOTKIT_JOURNALS", raising=False)
