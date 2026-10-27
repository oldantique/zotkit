"""zotkit.journals — ISO 4 journal abbreviations (ADR-0005).

One normaliser shared by `create`/`enrich` (what they write to
`journalAbbreviation`), `audit` (what it compares the stored value against)
and `cite` (what it prints), so stored and rendered forms never disagree.

Sources, in order of authority:
1. **registered** — the ISSN network's abbreviated key-title, from the table
   shipped in `data/journal_abbreviations.tsv`, merged under a user's own
   verified rows from `ZOTKIT_JOURNALS` (same format; local rows win). Looked
   up by full title or by the abbreviation itself (a `publicationTitle` that
   is already abbreviated).
2. **title** — a `publicationTitle` that is visibly abbreviated already
   ("Appl. Phys. Lett.") and not in the table: taken as written.
3. **rule-derived** — ISO 4 word rules over the LTWA (List of Title Word
   Abbreviations). zotkit does not ship the LTWA: the ISSN International
   Centre reserves its database rights, so the rules run only when
   `ZOTKIT_LTWA` names a copy the user downloaded. Rule output is a candidate,
   not a registered form — a word the LTWA doesn't list stays whole and is
   reported, never guessed.

Only a registered form is authoritative: callers may let it replace a
stored value. A `title` or `rule-derived` answer is a candidate — it may fill
an empty field, never replace one, and `audit` keeps listing every journal
without a registered form as unverified, whatever is stored.

No opinion (None) for a non-Latin-script title, or when no source applies.
Callers then leave the stored value alone.
"""
from __future__ import annotations

import csv
import os
import re
import unicodedata
from dataclasses import dataclass, field
from importlib import resources

REGISTERED, TITLE, RULE = "registered", "title", "rule-derived"

# ISO 4 omits articles, prepositions and conjunctions (leading ones too)
_STOP = set("""a an the and or nor but for so yet & of in on at to by from into
onto upon with within without via per as about over under between among
vs versus its their his her et und und für fur der die das des de du la le les
el y del della di da en i och og""".split())

_TOKEN = re.compile(r"[^\W_]+(?:['’][^\W_]+)*\.?|[:()&,-]")


@dataclass(frozen=True)
class Abbrev:
    value: str
    source: str                      # REGISTERED | TITLE | RULE
    unknown: tuple[str, ...] = field(default=())


def _fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s.casefold())
                   if not unicodedata.combining(c))


def _title_key(title: str) -> str:
    """Lookup form: case/accents folded, & = and, punctuation ignored, and a
    leading article dropped ("The Journal of Finance" = "Journal of Finance")."""
    s = re.sub(r"[^\w]+", " ", _fold(title).replace("&", " and ")).strip()
    return re.sub(r"^the ", "", s)


def is_non_latin(title: str) -> bool:
    return any(c.isalpha() and not unicodedata.name(c, "").startswith("LATIN")
               for c in title)


# ---------- registered table ----------

_registered: dict[str, str] | None = None


def _load_registered() -> dict[str, str]:
    global _registered
    if _registered is None:
        text = (resources.files("zotkit") / "data" / "journal_abbreviations.tsv"
                ).read_text(encoding="utf-8")
        table = parse_table(text)
        local = os.environ.get("ZOTKIT_JOURNALS", "").strip()
        if local:
            with open(local, encoding="utf-8-sig") as f:
                table.update(parse_table(f.read()))
        _registered = table
    return _registered


def parse_table(text: str) -> dict[str, str]:
    """`title<TAB>abbreviation[<TAB>source]` rows ('#' comments, one header
    row) → lookup map keyed by both the folded title and the folded
    abbreviation."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip() or line.startswith("#") or line.startswith("title\t"):
            continue
        title, abbr = (line.split("\t") + [""])[:2]
        if abbr.strip():
            out[_title_key(title)] = abbr.strip()
            out.setdefault(_title_key(abbr), abbr.strip())
    return out


# ---------- LTWA rules (only with a user-supplied file) ----------

@dataclass
class Ltwa:
    exact: dict[str, list[tuple[str, bool]]]    # word -> [(abbr, english)]
    stems: dict[str, list[tuple[str, bool]]]    # "financ" for "financ-"
    abbrs: set[str] = field(default_factory=set)  # every listed abbreviation


_ltwa: dict[str, Ltwa | None] = {}


def load_ltwa(path: str) -> Ltwa:
    """Parse the ISSN LTWA export (WORD / ABBREVIATION / LANGUAGES; tab-,
    semicolon- or comma-separated). An empty or "n.a." abbreviation means
    the word is never abbreviated."""
    with open(path, encoding="utf-8-sig", newline="") as f:
        head = f.readline()
        delim = "\t" if "\t" in head else ";" if ";" in head else ","
        rows = csv.reader(f, delimiter=delim)
        exact: dict[str, list] = {}
        stems: dict[str, list] = {}
        abbrs: set[str] = set()
        for row in rows:
            if len(row) < 2 or not row[0].strip():
                continue
            word, abbr = row[0].strip(), row[1].strip()
            if abbr.casefold() == "n.a.":
                abbr = ""
            english = len(row) > 2 and ("English" in row[2] or "Multiple" in row[2])
            if abbr:
                abbrs.add(_fold(abbr))
            if word.startswith("-"):
                continue                          # suffix patterns (compounds)
            if word.endswith("-"):
                stems.setdefault(_fold(word[:-1]), []).append((abbr, english))
            else:
                exact.setdefault(_fold(word), []).append((abbr, english))
    return Ltwa(exact, stems, abbrs)


def _ltwa_from_env() -> Ltwa | None:
    path = os.environ.get("ZOTKIT_LTWA", "").strip()
    if not path:
        return None
    if path not in _ltwa:
        _ltwa[path] = load_ltwa(path)
    return _ltwa[path]


def _pick(cands: list[tuple[str, bool]]) -> str:
    return sorted(cands, key=lambda c: not c[1])[0][0]   # English rows first


def _word(w: str, ltwa: Ltwa) -> str | None:
    """Abbreviation of one word, the word itself when the LTWA says to keep it
    whole, or None when the LTWA doesn't list it."""
    f = _fold(w)
    for cand in (f, f[:-1] if f.endswith("s") else None,
                 f[:-2] if f.endswith("es") else None):
        if cand and cand in ltwa.exact:
            abbr = _pick(ltwa.exact[cand])
            break
    else:
        for n in range(len(f), 0, -1):            # longest stem wins
            if f[:n] in ltwa.stems:
                abbr = _pick(ltwa.stems[f[:n]])
                break
        else:
            return None
    if not abbr:
        return w
    return abbr[0].upper() + abbr[1:] if w[0].isupper() else abbr


def _acronym(t: str) -> bool:
    return (len(t) > 1 and t.isupper()) or bool(re.match(r"^[A-Za-z][a-z]*[A-Z]", t))


def apply_rules(title: str, ltwa: Ltwa) -> Abbrev:
    """ISO 4 word rules: drop articles/prepositions/conjunctions, abbreviate
    each remaining word per the LTWA (plurals take the singular's entry, a
    `stem-` entry matches its longest stem), keep single capitals (section
    letters: "Phys. Rev. A"), acronyms, already-dotted words and a colon
    subtitle separator; hyphenated words abbreviate per part. A one-word title
    stays whole."""
    toks = _TOKEN.findall(title)
    main = toks[:toks.index("(")] if "(" in toks else toks   # before a qualifier
    words = [t for t in main if t[0].isalnum() and _fold(t) not in _STOP]
    single = words[0] if len(words) == 1 else None   # "Nature", "Physics (…)"
    if single and main is toks:
        return Abbrev(single, RULE)
    out: list[str] = []
    unknown: list[str] = []
    glue = False                                  # next word joins with "-"
    first = True
    for t in toks:
        if t.endswith(".") and _fold(t) not in ltwa.abbrs:
            t = t[:-1]              # "Comptes Rendus. Physique": a separator
        if t == "-":
            glue = bool(out)
            continue
        if t in (":", "(", ")"):
            if t == ":" and out:
                out[-1] += ":"
            elif t == "(":
                out.append("(")
            elif out:
                out[-1] += ")"
            continue
        section = len(t) == 1 and t.isupper() and not first  # "Phys. Rev. A"
        first = first and not t[0].isalnum()
        if not t[0].isalnum() or (_fold(t) in _STOP and not glue and not section):
            continue
        if section or t.isdigit() or t.endswith(".") or _acronym(t):
            a = t
        else:
            a = t if t is single else _word(t, ltwa)
            if a is None:
                a = t
                unknown.append(t)
        if glue:
            out[-1] += "-" + a
        elif out and out[-1] == "(":
            out[-1] += a
        else:
            out.append(a)
        glue = False
    return Abbrev(" ".join(out), RULE, tuple(unknown))


# ---------- the normaliser ----------

def _looks_abbreviated(title: str) -> bool:
    words = [t for t in _TOKEN.findall(title) if t[0].isalnum()]
    return (any(len(w) > 2 and w.endswith(".") for w in words)
            and all(w.endswith(".") or _acronym(w) or len(w) == 1 or w.isdigit()
                    or _fold(w) in _STOP for w in words))


def normalise(title: str | None, *, table: dict[str, str] | None = None,
              ltwa: Ltwa | None = None) -> Abbrev | None:
    """ISO 4 abbreviation of a journal title, or None (no opinion). `table`
    and `ltwa` default to the shipped table and `$ZOTKIT_LTWA`."""
    title = re.sub(r"\s+", " ", title or "").strip()
    if not title or is_non_latin(title):
        return None
    table = _load_registered() if table is None else table
    hit = table.get(_title_key(title))
    if hit:
        return Abbrev(hit, REGISTERED)
    if _looks_abbreviated(title):
        return Abbrev(title, TITLE)
    ltwa = _ltwa_from_env() if ltwa is None else ltwa
    return apply_rules(title, ltwa) if ltwa else None


def has_field(d: dict) -> bool:
    """Item types that carry a journalAbbreviation field (the API returns every
    field of the type, empty ones included)."""
    return "journalAbbreviation" in d or d.get("itemType") == "journalArticle"


def check(d: dict, **kw) -> Abbrev | None:
    """The normaliser's answer for item data `d`, or None when the item has
    no such field or the normaliser has no opinion."""
    if not has_field(d):
        return None
    return normalise(d.get("publicationTitle"), **kw)
