"""Orca's bots and AgoraOne's mailbox: the CLI runs without a shell and without ORCA_* variables; the mailbox is created
only on request, used only while `cat` runs in it, found again by its tab after a restart, and never another
terminal's; a too old Orca is said so."""

import json
import subprocess

import pytest

from agora_core import orca_bots, orca_launch
from agora_core.db import DB_NAME, connect, migrate
from agora_core.orca_launch import OrcaError

H1 = "term_" + "1" * 8 + "-1111-1111-1111-" + "1" * 12
H2 = "term_" + "2" * 8 + "-2222-2222-2222-" + "2" * 12


class FakeOrca:
    """Answers like Orca's CLI; `terminals` maps handle → its terminal (`list` shows them all)."""

    def __init__(self, version="1.4.267"):
        self.calls, self.version = [], version
        self.terminals: dict[str, dict] = {}
        self.bots = [{"id": "b1", "name": "Seguridad", "agent": "claude", "paused": False, "specialty": "Revisa sin cambiar código"},
                     {"id": "b2", "name": "Junior", "agent": "pi", "paused": True, "specialty": None}, {"name": ""}]

    def __call__(self, argv, **kwargs):
        assert isinstance(argv, list) and "shell" not in kwargs, "nunca por un shell"
        assert not any(k.startswith("ORCA_") for k in kwargs.get("env", {})), "sin variables de Orca"
        self.calls.append(argv[1:])
        if argv[1:] == ["--version"]:
            return subprocess.CompletedProcess(argv, 0, f"{self.version}\n", "")
        args = argv[1:-1]
        if args[:2] == ["bot", "list"]:
            result = {"bots": self.bots}
        elif args[:2] == ["terminal", "show"]:
            found = self.terminals.get(args[2].split("=", 1)[1])
            if found is not None and getattr(self, "starting", 0):
                self.starting -= 1
                if not self.starting:
                    found["title"] = "cat"
            if found is None:
                return subprocess.CompletedProcess(argv, 1, json.dumps({"ok": False, "error": {"code": "terminal_handle_stale"}}), "")
            result = {"terminal": found}
        elif args[:2] == ["terminal", "list"]:
            result = {"terminals": list(self.terminals.values())}
        elif args[:2] == ["worktree", "list"]:
            result = {"worktrees": [{"id": "r1::/p/otro", "path": "/p/otro"}, {"id": "r2::/p/agoraone", "path": "/p/agoraone"}]}
        elif args[:2] == ["terminal", "create"]:
            self.terminals[H1] = {"handle": H1, "tabId": "tab1", "title": "zsh", "connected": True}  # the shell starts first
            self.starting = 2
            result = {"terminal": {"handle": H1, "tabId": "tab1"}}
        elif args[:2] == ["orchestration", "send"]:
            if getattr(self, "send_fails", False):
                return subprocess.CompletedProcess(argv, 1, "", "timeout")
            result = {"messageId": "msg_abc123def456"}
        else:
            raise AssertionError(f"orden inesperada: {args}")
        return subprocess.CompletedProcess(argv, 0, json.dumps({"ok": True, "result": result}), "")


@pytest.fixture(autouse=True)
def installed(monkeypatch):
    monkeypatch.setattr(orca_launch, "binary", lambda: "/Applications/Orca.app/Contents/Resources/bin/orca")


@pytest.fixture
def database(tmp_path):
    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    yield connection
    connection.close()


def test_the_bots_are_listed_and_odd_rows_left_out():
    found = orca_bots.bots(FakeOrca())
    assert [b["name"] for b in found] == ["Seguridad", "Junior"]
    assert found[0]["purpose"] == "Revisa sin cambiar código" and found[1]["paused"] is True


def test_an_old_or_missing_orca_is_said(monkeypatch):
    with pytest.raises(OrcaError, match="1.4.267"):
        orca_bots.bots(FakeOrca(version="1.4.266"))
    monkeypatch.setattr(orca_launch, "binary", lambda: None)
    with pytest.raises(OrcaError, match="no está instalado"):
        orca_bots.bots(FakeOrca())


def test_the_mailbox_is_created_on_request_running_cat(database):
    orca = FakeOrca()
    assert orca_bots.status(database, orca)["state"] == "missing"
    with pytest.raises(OrcaError):
        orca_bots.handle(database, orca)  # nothing is sent without a mailbox
    assert not any(c[:2] == ["terminal", "create"] for c in orca.calls), "solo con el botón"
    made = orca_bots.create(database, orca, sleep=lambda _s: None)
    create = next(c for c in orca.calls if c[:2] == ["terminal", "create"])
    assert "--command=cat > /dev/null" in create and "--title=Buzón de AgoraOne" in create
    assert "--worktree=id:r2::/p/agoraone" in create and made["where"] == "/p/agoraone"  # AgoraOne's repository when Orca has it
    assert orca_bots.handle(database, orca) == H1
    assert made["state"] == "ready"  # it waited for the shell to start `cat`
    with pytest.raises(OrcaError, match="ya está"):
        orca_bots.create(database, orca)


def test_a_mailbox_no_longer_running_cat_is_not_used(database):
    orca = FakeOrca()
    orca_bots.create(database, orca, sleep=lambda _s: None)
    orca.terminals[H1]["title"] = "zsh"  # someone interrupted cat: a shell would get what Orca types
    assert orca_bots.status(database, orca)["state"] == "broken"
    with pytest.raises(OrcaError, match="cat"):
        orca_bots.handle(database, orca)
    creates = sum(c[:2] == ["terminal", "create"] for c in orca.calls)
    with pytest.raises(OrcaError, match="ciérralo"):
        orca_bots.create(database, orca)  # never a second mailbox: the broken one is closed in Orca first
    assert sum(c[:2] == ["terminal", "create"] for c in orca.calls) == creates


def test_after_a_restart_it_is_found_by_its_tab_never_another_terminal(database):
    orca = FakeOrca()
    orca_bots.create(database, orca, sleep=lambda _s: None)
    orca.terminals = {H2: {"handle": H2, "tabId": "tab1", "title": "cat", "connected": True}}  # same tab, new handle
    assert orca_bots.handle(database, orca) == H2 and orca_bots.saved(database)["handle"] == H2
    orca.terminals = {H1: {"handle": H1, "tabId": "otra", "title": "cat", "connected": True}}  # stale handle reused elsewhere
    orca_bots._keep(database, {**orca_bots.saved(database), "handle": H2})
    assert orca_bots.status(database, orca)["state"] == "missing"


def test_with_the_module_off_orca_is_not_asked(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from agora_core import routes_orca_bots
    from test_assistant import MemorySecrets
    from test_central_api import HEADERS, app_with

    orca = FakeOrca()
    real = routes_orca_bots.modules.state
    monkeypatch.setattr(orca_bots, "bots", lambda runner=None: orca_bots.ready(orca) or [])
    monkeypatch.setattr(routes_orca_bots.modules, "state", lambda c: {**real(c), "orca": False})
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        assert client.get("/orca/bots", headers=HEADERS).json()["on"] is False
        assert client.post("/orca/mailbox", headers=HEADERS).status_code == 404
    assert orca.calls == []


LAUNCH = {"client": "Acme", "project": "Web", "repo": "acme/web", "orcaName": "Web de Acme", "source": {"kind": "mail", "id": 7},
          "prompt": "Arregla el menú\n\nProyecto «Web» de Central (cliente «Acme»), enviado desde AgoraOne."}


@pytest.fixture
def launch(monkeypatch):
    checks = []
    monkeypatch.setattr(orca_launch, "preview", lambda _c, args, runner=None, secrets_store=None: {**LAUNCH, "task": args["task"]})
    monkeypatch.setattr(orca_launch, "recheck", lambda _c, plan, secrets_store=None: checks.append(plan["source"]))
    return checks


def errand(**extra):
    return {"client": "Acme", "project": "Web", "task": "Arregla el menú\ncon cuidado", "bot": "b1", "kind": "handoff", **extra}


def test_an_errand_is_previewed_exactly_and_sent_once_to_a_new_chat(database, launch):
    orca = FakeOrca()
    with pytest.raises(OrcaError, match="buzón"):
        orca_bots.preview(database, errand(), orca)  # without a mailbox nothing is even previewed
    orca_bots.create(database, orca, sleep=lambda _s: None)
    plan = orca_bots.preview(database, errand(), orca)
    assert plan["bot"]["name"] == "Seguridad" and plan["subject"] == "Web: Arregla el menú"
    assert plan["body"].startswith(LAUNCH["prompt"]) and "acme/web" in plan["body"]
    assert not any(c[:2] == ["orchestration", "send"] for c in orca.calls), "la vista previa no envía"
    done = orca_bots.send(database, plan, orca)
    sent = [c for c in orca.calls if c[:2] == ["orchestration", "send"]]
    assert len(sent) == 1 and done["messageId"] == "msg_abc123def456"
    assert f"--from={H1}" in sent[0] and "--to=bot:b1" in sent[0] and "--chat=new" in sent[0] and "--type=handoff" in sent[0]
    assert f"--body={plan['body']}" in sent[0] and launch == [{"kind": "mail", "id": 7}]  # the source was checked again
    row = database.execute("SELECT bot_name, kind, subject, source_kind FROM orca_bot_request").fetchone()
    assert tuple(row) == ("Seguridad", "handoff", "Web: Arregla el menú", "mail")
    logged = database.execute("SELECT detail FROM action_log WHERE action = 'orca.bot'").fetchone()[0]
    assert "menú" not in logged.replace("Web", "")  # the log keeps who and where, never the text


def test_a_paused_unknown_bot_or_odd_kind_is_refused(database, launch):
    orca = FakeOrca()
    orca_bots.create(database, orca, sleep=lambda _s: None)
    for args, said in ((errand(bot="b2"), "pausa"), (errand(bot="b9"), "ya no está"), (errand(kind="borrar"), "Encargar")):
        with pytest.raises(OrcaError, match=said):
            orca_bots.preview(database, args, orca)


def test_a_send_orca_did_not_confirm_is_never_said_unsent(database, launch):
    orca = FakeOrca()
    orca_bots.create(database, orca, sleep=lambda _s: None)
    plan = orca_bots.preview(database, errand(), orca)
    orca.send_fails = True
    with pytest.raises(orca_bots.UnsureSend, match="antes de repetirlo"):
        orca_bots.send(database, plan, orca)
    assert database.execute("SELECT COUNT(*) FROM orca_bot_request").fetchone()[0] == 0
