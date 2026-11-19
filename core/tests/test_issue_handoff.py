"""Issues from a mail or a note, and handing one to a session waiting in Orca: never from what is private, only one
line that points to the issue, without Enter, and only in a waiting session of that repository."""

import json
import subprocess

import pytest

from agora_core import coding_sessions, issue_handoff, orca_launch

from test_orca_launch import add_mail, database  # noqa: F401 - fixture

URL = "https://github.com/Acme/Web/issues/42"


def test_la_issue_sale_solo_de_un_correo_normal_y_de_un_proyecto_con_repositorio(database):  # noqa: F811
    normal = add_mail(database)
    issue = issue_handoff.from_source(database, {"client": "Acme", "project": "Web", "title": " Menú  roto ", "body": "No se ve", "source": {"kind": "mail", "id": normal}})
    assert issue == {"repo": "Acme/Web", "title": "Menú roto", "body": "No se ve"}
    database.execute("UPDATE mail_summary SET confidentiality = 'private' WHERE message_id = ?", (normal,))
    with pytest.raises(issue_handoff.HandoffError, match="privado"):
        issue_handoff.from_source(database, {"client": "Acme", "project": "Web", "title": "x", "body": "y", "source": {"kind": "mail", "id": normal}})
    database.execute("UPDATE mail_summary SET confidentiality = 'normal' WHERE message_id = ?", (normal,))
    with pytest.raises(issue_handoff.HandoffError, match="repositorio"):
        issue_handoff.from_source(database, {"client": "Acme", "project": "Sin repo", "title": "x", "body": "y", "source": {"kind": "mail", "id": normal}})
    with pytest.raises(issue_handoff.HandoffError, match="índice"):
        issue_handoff.from_source(database, {"client": "Acme", "project": "Web", "title": "x", "body": "y", "source": {"kind": "note", "source": "v", "ref": "n", "revision": "r"}})


def test_la_linea_solo_remite_a_la_issue_de_ese_repositorio():
    text = issue_handoff.line("Acme/Web", URL)
    assert "#42" in text and "gh issue view 42 --repo Acme/Web" in text and "\n" not in text and "\x1b" not in text
    with pytest.raises(issue_handoff.HandoffError):
        issue_handoff.line("Acme/Otro", URL)
    with pytest.raises(issue_handoff.HandoffError):
        issue_handoff.line("Acme/Web", URL + "\x1b[2J")
    with pytest.raises(issue_handoff.HandoffError):
        issue_handoff.line("Acme/We\u017f", "https://github.com/Acme/Wes/issues/1")  # «ſ» folds to «s»: refused
    assert "--repo Acme/Web»" in issue_handoff.line("acme/web", URL), "el repositorio tal como lo escribe la URL"


def test_la_issue_no_lleva_claves_ni_caracteres_de_control(database):  # noqa: F811
    normal = add_mail(database)
    base = {"client": "Acme", "project": "Web", "source": {"kind": "mail", "id": normal}}
    with pytest.raises(issue_handoff.HandoffError, match="clave"):
        issue_handoff.from_source(database, {**base, "title": "x", "body": "Hola\npassword: hunter2"})
    assert issue_handoff.from_source(database, {**base, "title": "Menú\x1b[2J", "body": "ok"})["title"] == "Menú[2J"


def setup(monkeypatch, terminals, sessions, cwd):
    monkeypatch.setattr(orca_launch, "binary", lambda: "/Applications/Orca.app/Contents/Resources/bin/orca")
    monkeypatch.setattr(orca_launch, "projects", lambda runner=None, fresh=False: {"acme/web": {"id": "github:acme/web", "name": "Web", "repoIds": ["r1"]}})
    monkeypatch.setattr(coding_sessions, "orca_terminals", lambda runner=None, fresh=False: terminals)
    monkeypatch.setattr(coding_sessions, "sessions", lambda orca=None, **k: sessions)
    monkeypatch.setattr(coding_sessions, "session_cwd", lambda session_id: cwd.get(session_id))
    calls = []
    def orca(args, **kwargs):
        calls.append(args[1:])
        return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "result": {}}), "")
    return orca, calls


def session(ident, state):
    return {"id": ident, "tool": "claude", "project": "web", "branch": "main", "model": "m", "lastAt": "x", "state": state, "inOrca": True}


def test_solo_escribe_en_la_unica_terminal_de_agente_y_sin_enter(monkeypatch):
    terminals = [{"path": "/w/web", "handle": "term_agente", "repoId": "r1", "agent": True, "last": 5},
                 {"path": "/w/web", "handle": "term_shell", "repoId": "r1", "agent": False, "last": 99},
                 {"path": "/w/web/vendor/otro", "handle": "term_otro", "repoId": "r2", "agent": True, "last": 9}]
    orca, calls = setup(monkeypatch, terminals, [session("aaaaaaaaaaaa", "waiting")], {"aaaaaaaaaaaa": "/w/web/src"})
    assert [s["id"] for s in issue_handoff.waiting("Acme/Web", orca)] == ["aaaaaaaaaaaa"]
    typed = issue_handoff.send("Acme/Web", URL, "aaaaaaaaaaaa", orca)
    assert calls[0] == ["terminal", "send", "--terminal=term_agente", f"--text={typed}", "--json"], "la de agente, no la shell con más salida"
    assert "--enter" not in calls[0] and ["terminal", "switch", "--terminal=term_agente", "--json"] in calls


def test_no_escribe_si_hay_duda(monkeypatch):
    agent = {"path": "/w/web", "handle": "term_a", "repoId": "r1", "agent": True, "last": 5}
    cwd = {"aaaaaaaaaaaa": "/w/web", "bbbbbbbbbbbb": "/w/web"}
    cases = [
        ([agent], [session("aaaaaaaaaaaa", "waiting"), session("bbbbbbbbbbbb", "working")], "trabajando"),  # another session works there
        ([agent, {**agent, "handle": "term_b"}], [session("aaaaaaaaaaaa", "waiting")], "una sola"),  # two agent terminals
        ([{**agent, "agent": False}], [session("aaaaaaaaaaaa", "waiting")], "una sola"),  # only a shell (the agent was closed)
        ([agent], [session("aaaaaaaaaaaa", "working")], "esperando"),  # it started working
        ([{**agent, "repoId": "r2"}], [session("aaaaaaaaaaaa", "waiting")], "repositorio"),  # another repository's workspace
    ]
    for terminals, sessions, why in cases:
        orca, calls = setup(monkeypatch, terminals, sessions, cwd)
        with pytest.raises(issue_handoff.HandoffError, match=why):
            issue_handoff.send("Acme/Web", URL, "aaaaaaaaaaaa", orca)
        assert calls == [], why
