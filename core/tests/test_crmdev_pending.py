"""«Pendiente en CRMDev»: what Central has and CRMDev lacks or has otherwise, computed from the directory of clients and
the pairs of projects; a dismissed warning stays hidden until what it says changes. Nothing is sent here."""

import pytest

from agora_core import central, clients, crmdev_pending, crmdev_sync
from agora_core.db import connect, migrate

CENTRAL_RAW = {
    "clients": [{"id": "c1", "name": "Cliente Uno"}, {"id": "c2", "name": "Bravo"}, {"id": "c3", "name": "Gamma"}, {"id": "c4", "name": "Delta"}],
    "projects": [{"id": "p1", "name": "Tienda", "status": "ACTIVE", "client": "Cliente Uno"},
                 {"id": "p2", "name": "Blog", "status": "DORMANT", "client": "Bravo"},
                 {"id": "p3", "name": "Viejo", "status": "ARCHIVED"},
                 {"id": "p4", "name": "Nuevo", "status": "ACTIVE", "client": "Gamma"}],
    "websites": [], "servers": [],
    "details": {"Cliente Uno": {"email": "hola@uno.example", "company": "Uno SL"}, "Bravo": {"email": "info@bravo.example"},
                "Delta": {"email": "ana@delta.example"}},
}


def crmdev_snapshot(**changes):
    snap = {"clients": [{"id": "r1", "name": "Cliente Uno", "company": "Uno Grupo", "email": "hola@uno.example", "status": "CUSTOMER", "domains": []},
                        {"id": "r2", "name": "Bravo", "company": None, "email": None, "status": "LEAD", "domains": []},
                        {"id": "r4", "name": "Luis", "company": "Delta", "email": "luis@delta.example", "status": "LEAD", "domains": []},
                        {"id": "r9", "name": "Hecho a mano", "company": None, "email": None, "status": "PROSPECT", "domains": []}],
            "projects": [{"id": "x1", "name": "Tienda", "status": "IN_PROGRESS", "type": "OTHER", "clientId": "r1"},
                         {"id": "x2", "name": "Blog", "status": "COMPLETED", "type": "OTHER", "clientId": "r2"}],
            "fetchedAt": "2026-11-20T10:00:00Z", "truncated": False, "projectsTruncated": False}
    snap.update(changes)
    return snap


@pytest.fixture
def world(tmp_path, monkeypatch):
    connection = connect(tmp_path / "agora.db")
    migrate(connection)
    state = {"central": central.shape(CENTRAL_RAW), "crmdev": crmdev_snapshot()}
    monkeypatch.setattr(central, "snapshot", lambda _c: state["central"])
    monkeypatch.setattr(crmdev_sync, "snapshot", lambda _c, org=None: state["crmdev"])
    monkeypatch.setattr(crmdev_sync, "snapshots", lambda _c: {"o1": state["crmdev"]} if state["crmdev"] else {})
    clients._changed()
    yield connection, state
    connection.close()


def by_key(result):
    return {i["key"]: i for i in result["items"]}


def test_every_kind_is_found(world):
    connection, _ = world
    found = by_key(crmdev_pending.build(connection))
    assert set(found) == {"client_missing:c3", "contact_missing:c2", "client_changed:c1:r1", "crmdev_only:r9",
                          "project_missing:p4", "project_changed:p2:x2", "contact_missing:c4"}
    assert found["client_changed:c1:r1"]["changes"] == [{"field": "company", "label": "Empresa", "central": "Uno SL", "crmdev": "Uno Grupo"}]
    assert found["project_changed:p2:x2"]["changes"][0]["field"] == "status"
    assert "project_missing:p3" not in found  # archived and not in CRMDev: nothing to do


def test_addresses_never_travel_in_a_warning(world):
    connection, state = world
    state["crmdev"] = crmdev_snapshot(clients=[{**crmdev_snapshot()["clients"][0], "email": "otro@uno.example"}])
    clients._changed()
    text = repr(crmdev_pending.build(connection))
    assert "@" not in text
    changed = by_key(crmdev_pending.build(connection))["client_changed:c1:r1"]["changes"]
    assert {"field": "email", "label": "Correo"} in changed


def test_a_dismissed_warning_comes_back_when_it_changes(world):
    connection, state = world
    item = by_key(crmdev_pending.build(connection))["client_changed:c1:r1"]
    crmdev_pending.dismiss(connection, item["key"], item["signature"])
    result = crmdev_pending.build(connection)
    assert "client_changed:c1:r1" not in by_key(result) and result["dismissed"] == 1
    assert by_key(crmdev_pending.build(connection, include_dismissed=True))["client_changed:c1:r1"]["dismissed"] is True
    rows = crmdev_snapshot()["clients"]
    state["crmdev"] = crmdev_snapshot(clients=[{**rows[0], "company": "Otra"}, *rows[1:]])
    clients._changed()
    assert "client_changed:c1:r1" in by_key(crmdev_pending.build(connection))
    crmdev_pending.dismiss(connection, "client_changed:c1:r1", None)
    assert connection.execute("SELECT count(*) FROM crmdev_pending_dismissed").fetchone()[0] == 0


def test_odd_keys_are_refused(world):
    connection, _ = world
    for key in ("otra:c1", "client_missing", "client_missing:../x", "client_missing:a:b:c"):
        with pytest.raises(crmdev_pending.PendingError):
            crmdev_pending.dismiss(connection, key, "0" * 64)
    with pytest.raises(crmdev_pending.PendingError):
        crmdev_pending.dismiss(connection, "client_missing:c3", "nope")


def test_nothing_while_either_is_not_a_source(world, monkeypatch):
    connection, _ = world
    monkeypatch.setattr(crmdev_sync, "snapshot", lambda _c, org=None: None)
    result = crmdev_pending.build(connection)
    assert result["active"] is False and result["items"] == []


def test_routes(tmp_path):
    from fastapi.testclient import TestClient

    from test_assistant import MemorySecrets
    from test_central_api import HEADERS, app_with

    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        found = client.get("/crmdev-pending", headers=HEADERS)
        assert found.status_code == 200 and found.json()["active"] is False
        assert client.post("/crmdev-pending/dismiss", headers=HEADERS, json={"key": "client_missing:c1", "signature": "a" * 64}).json() == {"done": True}
        assert client.post("/crmdev-pending/dismiss", headers=HEADERS, json={"key": "raro:c1", "signature": "a" * 64}).status_code == 422
        assert client.post("/crmdev-pending/dismiss", headers=HEADERS, json={"key": "client_missing:c1", "signature": "x"}).status_code == 422
