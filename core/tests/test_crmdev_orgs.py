"""Several organizations of CRMDev: each with the name the user gives it and its own key under its own account (the
first one keeps the key saved before organizations existed); each is read into its own snapshot, and the directory
joins the clients of all of them, each with its organization. A key never travels to another address."""

import json

import pytest

from agora_core import clients, crmdev_api, crmdev_orgs, crmdev_sync, modules, web_api
from agora_core.db import connect, migrate
from test_assistant import MemorySecrets
from test_crmdev_api import KEY, URL

OTHER = "crm_" + "f" * 48


@pytest.fixture
def world(tmp_path, monkeypatch):
    connection = connect(tmp_path / "agora.db")
    migrate(connection)
    web_api.save_url(crmdev_api.SPEC, connection, URL)
    secrets = MemorySecrets()
    secrets.put(crmdev_api.SECRET, KEY)
    monkeypatch.setattr(modules, "state", lambda _c: {"crmdev": True, "central": False})
    crmdev_api.clear_cache()
    yield connection, secrets
    connection.close()


def test_the_connection_made_before_is_the_first_organization(world):
    connection, secrets = world
    assert crmdev_orgs.orgs(connection) == [{"id": "o1", "name": "Organización 1"}]
    assert crmdev_api.connection_of(connection, secrets).key == KEY
    assert crmdev_orgs.connection_of(connection, secrets, "o1").key == KEY


def test_a_new_organization_has_its_own_key_and_name(world):
    connection, secrets = world
    org = crmdev_orgs.add(connection, secrets, "  Codeia  ", OTHER)
    assert org == {"id": "o2", "name": "Codeia"}
    assert secrets.values[crmdev_orgs.secret_of("o2")] == OTHER and secrets.values[crmdev_api.SECRET] == KEY
    assert crmdev_api.connection_of(connection, secrets, "o2").key == OTHER
    assert crmdev_api.connection_of(connection, secrets).key == KEY  # nothing chosen: still the first one
    with pytest.raises(crmdev_orgs.OrgError, match="Ya hay"):
        crmdev_orgs.add(connection, secrets, "codeia", OTHER)
    with pytest.raises(crmdev_orgs.OrgError):
        crmdev_orgs.add(connection, secrets, "Otra", "no-es-una-clave")
    crmdev_orgs.rename(connection, "o1", "Personal")
    assert [o["name"] for o in crmdev_orgs.orgs(connection)] == ["Personal", "Codeia"]
    assert "crm_" not in json.dumps(crmdev_orgs.orgs(connection))  # keys only in the store


def test_forgetting_one_keeps_the_others(world):
    connection, secrets = world
    crmdev_orgs.add(connection, secrets, "Codeia", OTHER)
    crmdev_orgs.forget(connection, secrets, "o2")
    assert crmdev_orgs.secret_of("o2") not in secrets.values and crmdev_orgs.orgs(connection) == [{"id": "o1", "name": "Organización 1"}]
    with pytest.raises(crmdev_orgs.OrgError, match="única"):
        crmdev_orgs.forget(connection, secrets, "o1")
    assert crmdev_api.connection_of(connection, secrets, "o9") is None  # an unknown organization has no connection


def test_each_organization_is_read_into_its_own_snapshot_and_the_directory_joins_them(world, monkeypatch):
    connection, secrets = world
    crmdev_orgs.add(connection, secrets, "Codeia", OTHER)
    data = {KEY: [{"id": "c1", "name": "Cliente Uno", "status": "CUSTOMER"}], OTHER: [{"id": "c2", "name": "Cliente Dos", "status": "LEAD"}]}

    def call(target, tool, arguments=None, fresh=False):
        return data[target.key] if tool == "list_clients" else []
    monkeypatch.setattr(crmdev_api, "call", call)
    crmdev_sync.read_now(connection, secrets, crmdev_sync.CrmdevHealth())
    assert [c["id"] for c in crmdev_sync.stored(connection, "o1")["clients"]] == ["c1"]
    assert [c["id"] for c in crmdev_sync.stored(connection, "o2")["clients"]] == ["c2"]
    assert connection.execute("SELECT count(*) FROM setting WHERE key = 'crmdev.clients:o2'").fetchone()[0] == 1
    assert {(c["id"], c["org"]) for c in crmdev_sync.rows(connection, "clients")} == {("c1", "o1"), ("c2", "o2")}
    clients._changed()
    assert {e["crmdevId"] for e in clients.directory(connection)} == {"c1", "c2"}


def test_forgetting_crmdev_or_moving_its_address_drops_the_other_keys(world):
    from agora_core import connectors

    connection, secrets = world
    adapter = connectors.REGISTRY["crmdev"].adapter
    crmdev_orgs.add(connection, secrets, "Codeia", OTHER)
    adapter.save(connection, secrets, {"url": "https://otro-crm.example.com", "key": KEY})  # another server
    assert crmdev_orgs.secret_of("o2") not in secrets.values and [o["id"] for o in crmdev_orgs.orgs(connection)] == ["o1"]
    crmdev_orgs.add(connection, secrets, "Codeia", OTHER)
    adapter.save(connection, secrets, {"url": "https://otro-crm.example.com"})  # same server: they stay
    assert secrets.values[crmdev_orgs.secret_of("o2")] == OTHER
    adapter.forget(connection, secrets)
    assert crmdev_api.SECRET not in secrets.values and crmdev_orgs.secret_of("o2") not in secrets.values
