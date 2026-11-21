"""Central's projects paired with CRMDev's: the user's links first, then the same name when it is unique on both
sides and the clients do not contradict it; what only looks alike is a suggestion, and «Son distintos» is kept."""

import pytest

from agora_core import central, crmdev_sync, project_links
from agora_core.db import connect, migrate


@pytest.fixture
def connection(tmp_path):
    found = connect(tmp_path / "agora.db")
    migrate(found)
    yield found
    found.close()


def central_row(project_id, name, client=None):
    return {"id": project_id, "name": name, "client": client, "kind": None, "status": "ACTIVE", "repo": None}


def crmdev_row(project_id, name, client_id=None):
    return {"id": project_id, "name": name, "status": "IN_PROGRESS", "type": "OTHER", "clientId": client_id}


def build(connection, mine, theirs, pairs=None):
    return project_links.build(connection, mine, theirs, pairs or {})


def pair_of(result, central_id):
    found = next(p for p in result["central"] if p["id"] == central_id)
    return found["crmdevId"], found["how"]


def test_same_unique_name_pairs_them(connection):
    result = build(connection, [central_row("a", "Tienda  Online")], [crmdev_row("x", "tienda online")])
    assert pair_of(result, "a") == ("x", "name")
    assert result["crmdev"][0]["centralId"] == "a"
    assert result["suggestions"] == []


def test_a_contradicting_client_is_only_a_suggestion(connection):
    result = build(connection, [central_row("a", "Web", "Cliente Uno")], [crmdev_row("x", "Web", "crm-2")], {"cliente uno": "crm-1"})
    assert pair_of(result, "a") == (None, None)
    assert result["suggestions"] == [{"centralId": "a", "centralName": "Web", "crmdevId": "x", "crmdevName": "Web"}]


def test_matching_client_or_unknown_client_pairs(connection):
    result = build(connection, [central_row("a", "Web", "Cliente Uno"), central_row("b", "App")],
                   [crmdev_row("x", "Web", "crm-1"), crmdev_row("y", "App", "crm-9")], {"cliente uno": "crm-1"})
    assert pair_of(result, "a") == ("x", "name")
    assert pair_of(result, "b") == ("y", "name")


def test_a_repeated_name_is_never_paired_alone(connection):
    result = build(connection, [central_row("a", "Web", "Uno"), central_row("b", "Web", "Dos")], [crmdev_row("x", "Web")])
    assert pair_of(result, "a") == (None, None) and pair_of(result, "b") == (None, None)
    assert {s["centralId"] for s in result["suggestions"]} == {"a", "b"}


def test_alike_names_are_suggested(connection):
    result = build(connection, [central_row("a", "Tienda Café Uno")], [crmdev_row("x", "tienda-cafe")])
    assert pair_of(result, "a") == (None, None)
    assert result["suggestions"][0]["crmdevId"] == "x"
    short = build(connection, [central_row("b", "Web")], [crmdev_row("y", "Webs del cliente")])
    assert short["suggestions"] == []


@pytest.fixture
def seen(monkeypatch):
    rows = {"central": [central_row("a", "Tienda"), central_row("b", "Blog")], "crmdev": [crmdev_row("x", "Tienda"), crmdev_row("y", "Otro blog")]}
    monkeypatch.setattr(project_links, "_central", lambda _c: rows["central"])
    monkeypatch.setattr(project_links, "_crmdev", lambda _c: rows["crmdev"])
    monkeypatch.setattr(project_links, "_client_pairs", lambda _c: {})
    return rows


def test_the_users_link_wins_and_replaces_others(connection, seen):
    project_links.set_link(connection, "b", "x", "linked")
    result = project_links.build(connection)
    assert pair_of(result, "b") == ("x", "user")
    assert pair_of(result, "a") == (None, None)  # «Tienda» lost its pair by name: the user linked CRMDev's to «Blog»
    project_links.set_link(connection, "a", "x", "linked")
    result = project_links.build(connection)
    assert pair_of(result, "a") == ("x", "user") and pair_of(result, "b") == (None, None)
    assert connection.execute("SELECT count(*) FROM project_link WHERE state = 'linked'").fetchone()[0] == 1


def test_distinct_stops_the_pair_and_can_be_undone(connection, seen):
    project_links.set_link(connection, "a", "x", "distinct")
    result = project_links.build(connection)
    assert pair_of(result, "a") == (None, None)
    assert result["distinct"] == [{"centralId": "a", "centralName": "Tienda", "crmdevId": "x", "crmdevName": "Tienda"}]
    assert not any(s["centralId"] == "a" and s["crmdevId"] == "x" for s in result["suggestions"])
    project_links.set_link(connection, "a", "x", "unlinked")
    assert pair_of(project_links.build(connection), "a") == ("x", "name")


def test_projects_not_seen_cannot_be_linked(connection, seen):
    with pytest.raises(project_links.ProjectLinkError):
        project_links.set_link(connection, "a", "nope", "linked")
    with pytest.raises(project_links.ProjectLinkError):
        project_links.set_link(connection, "a", "x", "whatever")


def test_snapshots_keep_project_ids_and_clients():
    shaped = central.shape({"clients": [], "websites": [], "servers": [], "details": {},
                            "projects": [{"id": "p1", "name": "Tienda", "client": "Uno", "status": "ACTIVE", "repo": "https://github.com/a/b"},
                                         {"id": "../x", "name": "Mala"}, {"id": "p2", "name": "  "}]})
    assert shaped["projects"] == [{"id": "p1", "name": "Tienda", "client": "Uno", "kind": None, "status": "ACTIVE", "repo": "a/b"}]
    found = crmdev_sync.shape_projects([{"id": "x", "name": "Web", "status": "IN_PROGRESS", "type": "GITHUB", "client": {"id": "c1"}},
                                        {"id": "y", "name": "App", "status": "RARO", "clientId": "c 2"}, {"id": "", "name": "Nada"}])
    assert found == [{"id": "x", "name": "Web", "status": "IN_PROGRESS", "type": "GITHUB", "clientId": "c1"},
                     {"id": "y", "name": "App", "status": None, "type": None, "clientId": None}]


def test_routes_read_and_refuse_unknown_projects(tmp_path):
    from fastapi.testclient import TestClient

    from test_assistant import MemorySecrets
    from test_central_api import HEADERS, app_with

    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        found = client.get("/project-links", headers=HEADERS)
        assert found.status_code == 200 and found.json() == {"central": [], "crmdev": [], "suggestions": [], "distinct": []}
        refused = client.post("/project-links", headers=HEADERS, json={"centralId": "a", "crmdevId": "x", "state": "linked"})
        assert refused.status_code == 422 and "ya no se ve" in refused.json()["error"]
        odd = client.post("/project-links", headers=HEADERS, json={"centralId": "../a", "crmdevId": "x", "state": "linked"})
        assert odd.status_code == 422
