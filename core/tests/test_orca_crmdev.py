"""«Lanzar en Orca» from a task or a ticket of CRMDev: only when its CRMDev project is linked with the Central project
chosen; the record goes fenced as data, without lines that look like keys and never with the address or the name of
who opened a ticket; a record that left CRMDev or a project unlinked meanwhile stops the launch."""

import pytest

from agora_core import central, crmdev_api, crmdev_sync, modules, orca_crmdev, orca_launch, project_links
from test_orca_launch import CANARY, SNAPSHOT, FakeOrca, database, installed  # noqa: F401 - pytest fixtures

TASK = {"id": "t1", "title": "Arreglar el menú", "description": f"No se ve en el móvil.\npassword: supersecreta123\n{CANARY}", "status": "TODO",
        "priority": "HIGH", "projectId": "x1"}
TICKET = {"id": "k1", "title": "No carga", "description": "Ayuda", "status": "OPEN", "category": "BUG", "guestName": "Luis Pérez",
          "guestEmail": "luis@example.com", "project": {"id": "x1", "name": "Web CRM"}}


@pytest.fixture
def crmdev(monkeypatch):
    state = {"links": {"x1": "p-web"}, "rows": {"list_tasks": [TASK], "list_tickets": [TICKET]}}
    monkeypatch.setattr(modules, "state", lambda _c: {"crmdev": True, "central": True, "orca": True})
    monkeypatch.setattr(crmdev_sync, "active", lambda _c: True)
    monkeypatch.setattr(crmdev_api, "connection_of", lambda _c, _s: object())
    monkeypatch.setattr(crmdev_api, "call", lambda _t, tool, _a=None, fresh=False: state["rows"][tool])
    monkeypatch.setattr(project_links, "build", lambda _c: {"crmdev": [{"id": k, "centralId": v} for k, v in state["links"].items()]})
    monkeypatch.setattr(central, "snapshot", lambda _c: {**SNAPSHOT, "projects": [{"id": "p-web", "name": "Web", "client": "Acme"},
                                                                      {"id": "p-shop", "name": "Tienda", "client": "Acme"}]})
    return state


def plan(connection, kind="crmdev_task", remote="t1", project="Web"):
    return orca_launch.preview(connection, {"client": "Acme", "project": project, "task": "Arréglalo", "agent": "claude",
                                            "source": {"kind": kind, "remote": remote}}, runner=FakeOrca())


def test_a_task_of_a_linked_project_goes_as_fenced_data(database, crmdev):
    found = plan(database)
    assert found["repo"] == "Acme/Web" and found["source"]["label"] == "Tarea de CRMDev «Arreglar el menú»"
    prompt = found["prompt"]
    assert "una tarea de CRMDev" in prompt and "Prioridad: HIGH" in prompt and "supersecreta123" not in prompt
    mark = prompt.split("<<<", 1)[1].split("\n", 1)[0]
    assert prompt.index(CANARY) > prompt.index(f"<<<{mark}") and prompt.index(CANARY) < prompt.index(f"{mark}>>>")


def test_a_ticket_never_carries_who_opened_it(database, crmdev):
    prompt = plan(database, "crmdev_ticket", "k1")["prompt"]
    assert "No carga" in prompt and "Categoría: BUG" in prompt
    assert "Luis" not in prompt and "luis@example.com" not in prompt


def test_another_project_or_an_unlinked_one_is_refused(database, crmdev):
    crmdev["links"] = {"x1": "p-shop"}  # linked with another Central project than the one chosen
    with pytest.raises(orca_launch.OrcaError, match="no está enlazado"):
        plan(database)
    crmdev["links"] = {}
    with pytest.raises(orca_launch.OrcaError, match="no está enlazado"):
        plan(database)


def test_a_record_that_left_crmdev_stops_the_launch(database, crmdev):
    found = plan(database)
    crmdev["rows"]["list_tasks"] = []
    with pytest.raises(orca_launch.OrcaError, match="ya no está"):
        orca_launch.recheck(database, found)


def test_odd_ids_and_crmdev_off_are_refused(database, crmdev, monkeypatch):
    with pytest.raises(orca_launch.OrcaError, match="no válido"):
        plan(database, remote="../t1")
    monkeypatch.setattr(crmdev_sync, "active", lambda _c: False)
    with pytest.raises(orca_launch.OrcaError, match="apagado"):
        plan(database)


def test_shapes_give_the_project_id():
    from agora_core.crmdev_shapes import shape_task, shape_ticket

    assert shape_task(TASK)["projectId"] == "x1" and shape_ticket(TICKET)["projectId"] == "x1"
    assert orca_crmdev.WHAT["crmdev_ticket"] == "un ticket de CRMDev"
