"""Offline tests for the `fetch` default-output hazard: git-worktree detection
and the warning emitted when --out was left implicit inside a repo. Pure
filesystem work against tmp_path — no subprocess, no network."""
import types
from pathlib import Path

import pytest

from zotkit import cli


# ---------- _inside_git_worktree ----------

def test_no_git_anywhere_is_false(tmp_path):
    d = tmp_path / "a" / "b"
    d.mkdir(parents=True)
    assert cli._inside_git_worktree(d) is False


def test_git_directory_in_ancestor_is_true(tmp_path):
    (tmp_path / ".git").mkdir()
    d = tmp_path / "a" / "b"
    d.mkdir(parents=True)
    assert cli._inside_git_worktree(d) is True


def test_git_file_in_ancestor_is_true(tmp_path):
    # linked worktree / submodule: .git is a file pointing at the real gitdir
    (tmp_path / ".git").write_text("gitdir: /elsewhere/.git/worktrees/x\n",
                                   encoding="utf-8")
    d = tmp_path / "a"
    d.mkdir()
    assert cli._inside_git_worktree(d) is True


def test_git_in_start_dir_itself_is_true(tmp_path):
    (tmp_path / ".git").mkdir()
    assert cli._inside_git_worktree(tmp_path) is True


# ---------- warning decision ----------

def test_implicit_out_in_repo_warns(tmp_path, capsys):
    (tmp_path / ".git").mkdir()
    assert cli._fetch_out_dir(None, tmp_path) == "downloads"
    err = capsys.readouterr().err
    assert "--out" in err and "git repository" in err
    assert "library-of-record" in err


def test_implicit_out_outside_repo_is_silent(tmp_path, capsys):
    assert cli._fetch_out_dir(None, tmp_path) == "downloads"
    assert capsys.readouterr().err == ""


def test_explicit_out_never_warns_even_in_repo(tmp_path, capsys):
    (tmp_path / ".git").mkdir()
    assert cli._fetch_out_dir("/somewhere/else", tmp_path) == "/somewhere/else"
    assert capsys.readouterr().err == ""


def test_default_is_unchanged_and_documented_in_help(capsys):
    # the effective default must stay ./downloads, and --help must say so
    with pytest.raises(SystemExit):
        cli.main(["fetch", "--help"])
    out = capsys.readouterr().out
    assert "downloads" in out


def test_fetch_prints_absolute_paths(tmp_path, monkeypatch, capsys):
    saved = tmp_path / "out" / "paper.pdf"
    saved.parent.mkdir()
    saved.write_text("x", encoding="utf-8")

    fake = types.SimpleNamespace(
        fetch=lambda k, out: [Path("out") / "paper.pdf"],
        find=lambda *a, **k: [],
    )
    monkeypatch.setattr(cli, "Zot", lambda *a, **k: fake)
    monkeypatch.chdir(tmp_path)
    assert cli.main(["fetch", "--key", "K1", "--out", "out"]) == 0
    out = capsys.readouterr().out
    assert str(saved.resolve()) in out
    assert str((tmp_path / "out").resolve()) in out
