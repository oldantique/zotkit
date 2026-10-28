"""Offline tests for `create --doi --oa-pdf` (#16): Unpaywall lookup shapes,
and the owner's stop rule — only the best open-access PDF, one attempt, and
the first refusal stops every further download. HTTP and the Zotero client
are faked; nothing is downloaded."""
import types

import httpx
import pytest

from zotkit import cli
from zotkit import metadata as md

PDF = b"%PDF-1.7 fake"


def _unpaywall(url_for_pdf="https://publisher.example/a.pdf", **best):
    loc = dict({"url_for_pdf": url_for_pdf, "license": "cc-by",
                "host_type": "publisher", "version": "publishedVersion",
                "url_for_landing_page": "https://doi.org/10.9999/x"}, **best)
    return {"is_oa": True, "best_oa_location": loc}


def _resp(status, body=b"", ctype="application/pdf", json=None):
    if json is not None:
        return httpx.Response(status, json=json)
    return httpx.Response(status, content=body, headers={"content-type": ctype})


@pytest.fixture
def http(monkeypatch):
    """Routes httpx.get by URL substring; each route is a list of responses
    served in order. Records every URL requested."""
    routes, seen = {}, []

    def get(url, **kw):
        seen.append(url)
        for frag, answers in routes.items():
            if frag in url:
                return answers.pop(0)
        raise AssertionError(f"unexpected GET {url}")
    monkeypatch.setattr(md.httpx, "get", get)
    monkeypatch.setattr(md, "_MIN_INTERVAL", {})          # no pacing sleeps
    return types.SimpleNamespace(routes=routes, seen=seen)


# ---------- lookup ----------

def test_best_location_with_a_pdf(http):
    http.routes["unpaywall"] = [_resp(200, json=_unpaywall())]
    loc = md.oa_location("10.9999/x")
    assert loc["url"] == "https://publisher.example/a.pdf"
    assert md.oa_extra_line(loc) == ("oa-pdf: cc-by · publisher · publishedVersion · "
                                     "https://publisher.example/a.pdf")


@pytest.mark.parametrize("body, why", [
    ({"is_oa": False, "best_oa_location": None}, "no open-access copy"),
    (_unpaywall(url_for_pdf=None), "a web page, not a PDF"),
])
def test_no_pdf_to_get(http, body, why):
    http.routes["unpaywall"] = [_resp(200, json=body)]
    assert why in md.oa_location("10.9999/x")["none"]


def test_placeholder_email_is_explained(http):
    http.routes["unpaywall"] = [_resp(422, json={"error": True})]
    with pytest.raises(md.MetadataError, match="ZOTKIT_MAILTO"):
        md.oa_location("10.9999/x")


# ---------- the stop rule ----------

def test_a_429_is_not_retried_for_an_oa_download(http, tmp_path):
    http.routes["publisher"] = [_resp(429), _resp(200, PDF)]
    with pytest.raises(md.MetadataError, match="HTTP 429"):
        md.download_pdf("https://publisher.example/a.pdf", tmp_path / "a.pdf",
                        retry=False)
    assert len(http.seen) == 1


def test_a_bot_wall_answering_200_html_is_a_refusal(http, tmp_path):
    http.routes["publisher"] = [_resp(200, b"<html>Just a moment...</html>", "text/html")]
    with pytest.raises(md.MetadataError, match="did not return a PDF"):
        md.download_pdf("https://publisher.example/a.pdf", tmp_path / "a.pdf",
                        retry=False)


class FakeZot:
    def __init__(self):
        self.attached, self.extra = [], []

    def attach(self, key, path, title=None):
        assert path.read_bytes() == PDF
        self.attached.append((key, title))
        return {"attachment_key": f"ATT{key}", "filename": path.name}

    def append_extra(self, key, line):
        self.extra.append((key, line))


def _new(n, title=None):
    """create_items' result rows for n created items (each carries its DOI)."""
    return [{"key": f"K{i}", "title": title or f"Paper {i}", "DOI": f"10.9999/p{i}"}
            for i in range(n)]


def test_first_refusal_stops_every_further_download(http, capsys):
    new = _new(3)
    http.routes["unpaywall"] = [_resp(200, json=_unpaywall("https://a.example/0.pdf")),
                                _resp(200, json=_unpaywall("https://b.example/1.pdf"))]
    http.routes["a.example"] = [_resp(200, PDF)]
    http.routes["b.example"] = [_resp(403, b"Forbidden", "text/html")]
    zot = FakeZot()
    assert cli._oa_attach(zot, new) is False
    out = capsys.readouterr()
    assert zot.attached == [("K0", "Full Text PDF")]
    assert zot.extra == [("K0", "oa-pdf: cc-by · publisher · publishedVersion · "
                                "https://a.example/0.pdf")]
    assert "oa-pdf K1: STOPPED — PDF download failed: HTTP 403" in out.err
    assert "oa-pdf K2: not attempted — stopped after b.example refused" in out.out
    # nothing else was asked of anyone: no retry, no other location, no 3rd lookup
    assert http.seen == ["https://api.unpaywall.org/v2/10.9999/p0",
                         "https://a.example/0.pdf",
                         "https://api.unpaywall.org/v2/10.9999/p1",
                         "https://b.example/1.pdf"]


def test_no_oa_copy_is_not_a_failure(http, capsys):
    new = _new(1)
    http.routes["unpaywall"] = [_resp(200, json={"is_oa": False})]
    zot = FakeZot()
    assert cli._oa_attach(zot, new) is True
    assert "oa-pdf K0: none — no open-access copy" in capsys.readouterr().out
    assert zot.attached == []


def test_dry_run_never_requests_the_pdf(http, capsys):
    http.routes["unpaywall"] = [_resp(200, json=_unpaywall())]
    cli._oa_dry({"DOI": "10.9999/x"})
    assert "would download https://publisher.example/a.pdf (cc-by, publisher, " \
           "publishedVersion)" in capsys.readouterr().out
    assert len(http.seen) == 1


def test_oa_pdf_needs_doi(monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["zotkit", "create", "--arxiv", "2401.00001",
                                     "--oa-pdf"])
    monkeypatch.setattr(cli, "Zot", lambda *a, **kw: None)
    assert cli.main() == 1
    assert "--oa-pdf works with --doi only" in capsys.readouterr().err


def test_same_title_items_each_get_their_own_pdf(http):
    new = _new(2, title="Editorial")
    http.routes["unpaywall"] = [_resp(200, json=_unpaywall("https://a.example/0.pdf")),
                                _resp(200, json=_unpaywall("https://a.example/1.pdf"))]
    http.routes["a.example"] = [_resp(200, PDF), _resp(200, PDF)]
    zot = FakeZot()
    assert cli._oa_attach(zot, new) is True
    assert [line.rsplit(" ", 1)[1] for _, line in zot.extra] == [
        "https://a.example/0.pdf", "https://a.example/1.pdf"]
