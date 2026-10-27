"""Offline tests for zotkit.journals: source order (registered table, an
already-abbreviated title, LTWA rules), the ISO 4 word rules, and the
"no opinion" cases. The LTWA is NOT shipped (ADR-0005): rule tests run on a
handful of LTWA-format rows written for them, not on the real list."""
import pytest

from zotkit import journals
from zotkit.journals import REGISTERED, RULE, TITLE, Abbrev, apply_rules, normalise

LTWA_ROWS = """WORD\tABBREVIATION\tLANGUAGES
physical\tphys.\tEnglish
physics\tphys.\tEnglish
review\trev.\tEnglish
letter\tlett.\tEnglish
journal\tj.\tEnglish
mathematical\tmath.\tEnglish
general\tgen.\tEnglish
report\trep.\tEnglish
progress\tprog.\tEnglish
instrument\tinstrum.\tEnglish
scientific\tsci.\tEnglish
financ-\tfinanc.\tFrench
portfolio\tportf.\tSpanish
electróni-\telectrón.\tSpanish
electron-\telectron.\tEnglish
nature\tnat.\tMultiple languages
management\tmanag.\tEnglish
circuit\t\tFrench
compte rendu\tc. r.\tFrench
pacific\tpac.\tEnglish
quantum\t\tEnglish
technology\ttechnol.\tEnglish
transaction\ttrans.\tEnglish
computer\tcomput.\tEnglish
aided\tn.a.\tEnglish
design\tdes.\tEnglish
compte\t\tFrench
physique\tphys.\tFrench
"""


@pytest.fixture(scope="module")
def ltwa(tmp_path_factory):
    p = tmp_path_factory.mktemp("ltwa") / "ltwa.tsv"
    p.write_text(LTWA_ROWS, encoding="utf-8")
    return journals.load_ltwa(str(p))


def rule(title, ltwa):
    return apply_rules(title, ltwa).value


# ---------- the word rules ----------

@pytest.mark.parametrize("title, want", [
    ("Physical Review Letters", "Phys. Rev. Lett."),
    ("Physical Review A", "Phys. Rev. A"),                       # section letter kept
    ("Journal of Physics A: Mathematical and General", "J. Phys. A: Math. Gen."),
    ("Reports on Progress in Physics", "Rep. Prog. Phys."),     # plural → singular's entry
    ("Review of Scientific Instruments", "Rev. Sci. Instrum."),
    ("Pacific-Basin Physics Journal", "Pac.-Basin Phys. J."),   # per hyphen part
    ("Quantum Technology", "Quantum Technol."),                 # empty entry = keep whole
    ("IEEE Transactions on Computer-Aided Design", "IEEE Trans. Comput.-Aided Des."),
    ("Physics Reports. Letters", "Phys. Rep. Lett."),           # a separator, not a dot
])
def test_iso4_word_rules(ltwa, title, want):
    assert rule(title, ltwa) == want


def test_single_word_title_stays_whole(ltwa):
    assert rule("Quantum", ltwa) == "Quantum"
    assert rule("Physics (Journal)", ltwa) == "Physics (J.)"    # whole before a qualifier


def test_unlisted_words_stay_whole_and_are_reported(ltwa):
    r = apply_rules("New Journal of Physics", ltwa)
    assert r == Abbrev("New J. Phys.", RULE, ("New",))


@pytest.mark.parametrize("title, want, unknown", [
    # leading article dropped; "financ-" is a French entry, not an English one
    ("The Journal of Finance", "J. Finance", ("Finance",)),
    ("Journal of Portfolio Management", "J. Portfolio Manag.", ("Portfolio",)),
    # accent folding must not let Spanish "electróni-" reach an English word
    ("Nature Electronics", "Nat. Electron.", ()),
    # French-only words stay whole; the multi-word "compte rendu" isn't matched —
    # a title like this needs the registered table ("C. R. Phys.")
    ("Comptes Rendus. Physique", "Comptes Rendus Physique",
     ("Comptes", "Rendus", "Physique")),
])
def test_only_english_ltwa_entries_apply(ltwa, title, want, unknown):
    assert apply_rules(title, ltwa) == Abbrev(want, RULE, unknown)


def test_acronyms_and_dotted_words_pass_through(ltwa):
    assert rule("EPJ Quantum Technology", ltwa) == "EPJ Quantum Technol."
    assert rule("SciPost Physics", ltwa) == "SciPost Phys."


def test_ltwa_export_with_semicolons_loads(tmp_path):
    p = tmp_path / "ltwa.csv"
    p.write_text("WORD;ABBREVIATION;LANGUAGES\nphysics;phys.;English\n", encoding="utf-8")
    assert journals.load_ltwa(str(p)).exact["physics"] == "phys."


# ---------- the normaliser: source order and no-opinion cases ----------

TABLE = journals.parse_table(
    "# comment\ntitle\tiso4\tsource\n"
    "Comptes Rendus. Physique\tC. R. Phys.\tnlm\n"
    "Proceedings of the National Academy of Sciences\tProc. Natl. Acad. Sci. U.S.A.\tnlm\n")


def test_registered_form_beats_the_rules(ltwa):
    assert apply_rules("Comptes Rendus. Physique", ltwa).value != "C. R. Phys."
    assert normalise("Comptes rendus - Physique", table=TABLE, ltwa=ltwa) == \
        Abbrev("C. R. Phys.", REGISTERED)


def test_registered_lookup_by_title_variant_or_by_abbreviation():
    for t in ("The Proceedings of the National Academy of Sciences",
              "Proc. Natl. Acad. Sci. U.S.A."):
        assert normalise(t, table=TABLE, ltwa=None).value == "Proc. Natl. Acad. Sci. U.S.A."


def test_an_abbreviated_title_is_taken_as_written():
    assert normalise("Appl. Phys. Lett.", table={}, ltwa=None) == \
        Abbrev("Appl. Phys. Lett.", TITLE)


def test_no_opinion_without_table_hit_or_ltwa(monkeypatch):
    monkeypatch.delenv("ZOTKIT_LTWA", raising=False)
    assert normalise("Physical Review B", table={}) is None


def test_ltwa_comes_from_the_environment(monkeypatch, tmp_path):
    p = tmp_path / "ltwa.tsv"
    p.write_text(LTWA_ROWS, encoding="utf-8")
    monkeypatch.setenv("ZOTKIT_LTWA", str(p))
    assert normalise("Physical Review B", table={}) == Abbrev("Phys. Rev. B", RULE)


@pytest.mark.parametrize("title", ["中国物理学报", "", None])
def test_no_opinion_for_non_latin_or_empty_titles(ltwa, title):
    assert normalise(title, table={}, ltwa=ltwa) is None


def test_shipped_table_parses():
    from importlib import resources
    text = (resources.files("zotkit") / "data" / "journal_abbreviations.tsv"
            ).read_text(encoding="utf-8")
    rows = [ln for ln in text.splitlines()
            if ln.strip() and not ln.startswith("#") and not ln.startswith("title\t")]
    assert all(len(r.split("\t")) in (2, 3) for r in rows)
    assert len(journals.parse_table(text)) >= len(rows)


def test_check_only_for_types_with_the_field(ltwa):
    assert journals.check({"itemType": "preprint", "publicationTitle": "Physics Letters"},
                          table={}, ltwa=ltwa) is None
    assert journals.check({"itemType": "journalArticle",
                           "publicationTitle": "Physical Review B"},
                          table={}, ltwa=ltwa).value == "Phys. Rev. B"


def test_local_verified_table_merges_over_the_shipped_one(monkeypatch, tmp_path):
    local = tmp_path / "mine.tsv"
    local.write_text("title\tiso4\nPhysical Review B\tPhys. Rev. B\n", encoding="utf-8")
    monkeypatch.setenv("ZOTKIT_JOURNALS", str(local))
    monkeypatch.setattr(journals, "_registered", None)       # force a reload
    assert normalise("Physical Review B") == Abbrev("Phys. Rev. B", REGISTERED)


def test_create_labels_a_stored_candidate(monkeypatch, tmp_path, capsys):
    from zotkit import cli
    ltwa = tmp_path / "ltwa.tsv"
    ltwa.write_text("WORD\tABBREVIATION\tLANGUAGES\njournal\tj.\tEnglish\n", encoding="utf-8")
    monkeypatch.setenv("ZOTKIT_LTWA", str(ltwa))
    item = {"itemType": "journalArticle", "publicationTitle": "Journal of Ferns",
            "journalAbbreviation": "J. Ferns"}
    cli._note_abbreviation_candidate(item)
    assert "note: journalAbbreviation 'J. Ferns' is a candidate (rule-derived)" in \
        capsys.readouterr().out
    cli._note_abbreviation_candidate(dict(item, journalAbbreviation="J Ferns"))
    assert capsys.readouterr().out == ""                  # CrossRef's value: no note
