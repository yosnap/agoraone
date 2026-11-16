"""A meeting about a Central project, and the GitHub issue Watson proposes for that project's repository:
checked against Central, created only on confirmation, with the user's own `gh` (here a stand-in)."""

import asyncio
import json
import subprocess
from contextlib import contextmanager

import pytest

from agora_core import brain_tools, github_issues, meetings
from agora_core.central import github_repo, shape
from agora_core.db import DB_NAME, connect, migrate
from agora_core.embed import VectorCache

OWNER = "b" * 64
SNAPSHOT = {"clients": [{"name": "Acme", "projects": [{"name": "Web", "repo": "acme/web"}, {"name": "App", "repo": None}]},
                        {"name": "Beta", "projects": [{"name": "Web", "repo": "beta/web"}]}]}


def test_el_repositorio_sale_de_central():
    assert github_repo("https://github.com/acme/web.git") == "acme/web" and github_repo("git@github.com:acme/web") == "acme/web"
    assert github_repo("https://gitlab.com/acme/web") is None and github_repo("/Users/x/web") is None and github_repo(None) is None
    raw = {"clients": [{"name": "Acme"}], "projects": [{"client": "Acme", "name": "Web", "repo": "https://github.com/acme/web"}]}
    assert shape(raw)["clients"][0]["projects"][0]["repo"] == "acme/web"


@pytest.fixture
def database(tmp_path):
    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    connection.execute("INSERT INTO setting (key, value) VALUES ('central.snapshot', ?)", (json.dumps(SNAPSHOT),))
    connection.commit()
    yield connection
    connection.close()


def test_el_proyecto_es_del_cliente(database, tmp_path):
    recorder = meetings.Recorder(tmp_path, lambda: connect(tmp_path / DB_NAME))
    with pytest.raises(meetings.MeetingError, match="cliente"):
        meetings.central_project(database, None, "Web")
    with pytest.raises(meetings.MeetingError, match="no es de Acme"):
        meetings.central_project(database, "Acme", "Otro")
    assert meetings.central_project(database, "Acme", "web") == "Web" and meetings.central_project(database, "Acme", "") is None
    database.execute("INSERT INTO meeting (owner, title, status, started_at, mic_type, client, project) VALUES (?, 'x', 'recorded', '2026-11-16T10:00:00Z', 'webm', 'Acme', 'Web')", (OWNER,))
    database.commit()
    assert recorder.update(database, OWNER, 1, {"client": "Beta"})["project"] is None, "otro cliente se lleva el proyecto"
    assert recorder.update(database, OWNER, 1, {"project": "Web"})["project"] == "Web"
    with pytest.raises(meetings.MeetingError):
        recorder.update(database, OWNER, 1, {"client": "Acme", "project": "Nada"})


def _meeting(database, project, level="normal"):
    database.execute(
        "INSERT INTO meeting (owner, title, confidentiality, status, started_at, mic_type, client, project, transcript) VALUES (?, 'Kickoff', ?, 'recorded', '2026-11-16T10:00:00Z', 'webm', 'Acme', ?, '[]')",
        (OWNER, level, project))
    database.commit()
    return database.execute("SELECT max(id) FROM meeting").fetchone()[0]


def test_la_propuesta_va_al_repositorio_del_proyecto(database):
    with_web, with_app, private = _meeting(database, "Web"), _meeting(database, "App"), _meeting(database, "Web", "private")
    base = {"titulo": "Exportar a Excel", "cuerpo": "Lo pidió el cliente."}
    with pytest.raises(github_issues.IssueError, match="Busca antes"):
        github_issues.propose(database, OWNER, {**base, "reunion": with_web}, set())
    issue = github_issues.propose(database, OWNER, {**base, "reunion": with_web}, {with_web})
    assert issue["repo"] == "acme/web" and issue["project"] == "Web" and issue["meeting"] == "Kickoff"
    with pytest.raises(github_issues.IssueError, match="no tiene repositorio"):
        github_issues.propose(database, OWNER, {**base, "reunion": with_app}, {with_app})
    with pytest.raises(github_issues.IssueError, match="ya no está"):
        github_issues.propose(database, OWNER, {**base, "reunion": private}, {private})
    with pytest.raises(github_issues.IssueError, match="varios"):
        github_issues.propose(database, OWNER, {**base, "proyecto": "web"}, set())
    assert github_issues.propose(database, OWNER, {**base, "proyecto": "web", "cliente": "beta"}, set())["repo"] == "beta/web"
    with pytest.raises(github_issues.IssueError, match="título"):
        github_issues.propose(database, OWNER, {"cuerpo": "x", "proyecto": "web", "cliente": "beta"}, set())


def test_watson_propone_y_no_crea(database, tmp_path):
    meeting = _meeting(database, "Web")

    @contextmanager
    def opened():
        connection = connect(tmp_path / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()
    box = brain_tools.Toolbox(opened, None, VectorCache())
    box.owner, box.meetings_seen = OWNER, {meeting}
    answer = json.loads(asyncio.run(box.call("proponer_issue", {"reunion": meeting, "titulo": "T", "cuerpo": "C"})))
    assert answer["propuesta"]["repositorio"] == "acme/web" and "No está creada" in answer["estado"]
    (kept,) = box.proposals.values()
    assert kept["issue"]["repo"] == "acme/web" and box.history[-1]["tool"] == "issue_proposal"


def test_se_crea_con_gh_y_argumentos(monkeypatch):
    monkeypatch.setattr(github_issues, "_gh", lambda: "/bin/gh")
    calls = []

    def runner(command, **options):
        calls.append((command, options["input"]))
        return subprocess.CompletedProcess(command, 0, stdout="https://github.com/acme/web/issues/7\n", stderr="")
    issue = {"repo": "acme/web", "title": "$(rm -rf /)", "body": "## Hola\n`x`"}
    assert github_issues.create(issue, runner) == "https://github.com/acme/web/issues/7"
    assert calls == [(["/bin/gh", "issue", "create", "--repo", "acme/web", "--title", "$(rm -rf /)", "--body-file", "-"], "## Hola\n`x`")]
    failing = lambda command, **o: subprocess.CompletedProcess(command, 1, stdout="", stderr="could not resolve to a Repository")  # noqa: E731
    with pytest.raises(github_issues.IssueError, match="could not resolve"):
        github_issues.create(issue, failing)
    with pytest.raises(github_issues.IssueError, match="no válido"):
        github_issues.create({**issue, "repo": "acme/web --x"}, runner)
    monkeypatch.setattr(github_issues, "_gh", lambda: None)
    with pytest.raises(github_issues.IssueError, match="gh auth login"):
        github_issues.create(issue, runner)
