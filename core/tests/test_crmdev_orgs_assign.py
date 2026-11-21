"""The organization of each client and project of Central: the link wins, a choice is remembered, a project goes
with its client, a batch goes to the organization chosen above «Desde Central» (never what belongs to another one)
and what had none is remembered once sent. CRMDev is two stand-ins, one per key."""

import httpx
import pytest
from fastapi.testclient import TestClient

from agora_core import central, crmdev_api, crmdev_batch, crmdev_orgs, crmdev_orgs_assign
from agora_core.db import DB_NAME, connect
from test_assistant import MemorySecrets
from test_central_api import HEADERS, app_with
from test_crmdev_api import KEY, URL
from test_crmdev_batch import CENTRAL, pending, preview
from test_crmdev_write import StatefulCrmdev, empty_cache  # noqa: F401 - pytest fixtures

KEY2 = "crm_" + "9f8e7d6c" * 6


class TwoOrgs:
    """The first organization answers to KEY, the second (with no clients nor projects yet) to KEY2."""

    def __init__(self):
        self.first, self.second = StatefulCrmdev(), StatefulCrmdev()
        self.second.rows["list_clients"], self.second.rows["list_projects"] = [], []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization") == f"Bearer {KEY2}":
            headers = {**request.headers, "authorization": f"Bearer {KEY}"}
            return self.second(httpx.Request(request.method, request.url, headers=headers, content=request.content))
        return self.first(request)


@pytest.fixture(autouse=True)
def no_pause(monkeypatch):
    monkeypatch.setattr(crmdev_batch, "PAUSE_SECONDS", 0)


@pytest.fixture
def two(monkeypatch):
    found = TwoOrgs()
    monkeypatch.setattr(crmdev_api, "TRANSPORT", httpx.MockTransport(found))
    return found


@pytest.fixture
def setup(tmp_path, two):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        assert client.put("/connectors/crmdev", json={"url": URL, "key": KEY}, headers=HEADERS).status_code == 200
        added = client.post("/crmdev/orgs", json={"name": "Segunda", "key": KEY2}, headers=HEADERS)
        assert added.status_code == 200 and "warning" not in added.json(), added.text
        assert client.post("/crmdev/clients/refresh", headers=HEADERS).status_code == 200
        connection = connect(settings.data_dir / DB_NAME)
        try:
            central.refresh(connection, None, fetch=lambda origin: CENTRAL)
        finally:
            connection.close()
        yield client, settings


def assign(client, keys, org):
    return client.post("/crmdev/orgs/assign", headers=HEADERS, json={"keys": keys, "org": org})


def test_linked_records_have_their_organization_and_new_ones_none(setup):
    client, _ = setup
    found = pending(client)
    assert (found["client_changed:k1:c1"]["org"], found["client_changed:k1:c1"]["orgFrom"]) == ("o1", "link")
    assert found["project_changed:q1:p1"]["org"] == "o1"
    assert found["client_missing:k2"]["org"] is None and found["project_missing:q2"]["org"] is None
    assert [o["id"] for o in client.get("/crmdev-pending", headers=HEADERS).json()["orgs"]] == ["o1", "o2"]


def test_a_choice_is_remembered_the_project_follows_its_client_and_can_be_forgotten(setup):
    client, _ = setup
    assert assign(client, ["client_missing:k2"], "o2").json() == {"assigned": 1}
    found = pending(client)
    assert (found["client_missing:k2"]["org"], found["client_missing:k2"]["orgFrom"]) == ("o2", "chosen")
    assert (found["project_missing:q2"]["org"], found["project_missing:q2"]["orgFrom"]) == ("o2", "client")
    assert assign(client, ["project_missing:q2"], "o1").status_code == 200
    assert pending(client)["project_missing:q2"]["org"] == "o1"  # its own choice beats its client's
    assert assign(client, ["client_missing:k2", "project_missing:q2"], None).json() == {"assigned": 2}
    assert pending(client)["client_missing:k2"]["org"] is None


def test_only_what_is_missing_is_assigned_and_only_to_a_known_organization(setup):
    client, _ = setup
    assert assign(client, ["client_changed:k1:c1"], "o2").status_code == 422  # linked: its link decides
    assert assign(client, ["client_missing:k2"], "o7").status_code == 422
    assert assign(client, ["client_missing:k2"], 3).status_code == 422
    assert client.post("/crmdev/orgs/assign", headers=HEADERS, json={"keys": ["client_missing:k2"]}).status_code == 422


def test_a_batch_goes_to_the_chosen_organization_and_remembers_it(setup, two):
    client, settings = setup
    keys = ["client_changed:k1:c1", "client_missing:k2", "project_missing:q2"]
    shown = preview(client, keys, org="o2")
    assert shown.status_code == 200, shown.text
    body = shown.json()
    assert body["org"] == {"id": "o2", "name": "Segunda"}
    assert [o["kind"] for o in body["operations"]] == ["crear-cliente", "crear-proyecto"]
    assert [s["key"] for s in body["skipped"]] == ["client_changed:k1:c1"]
    assert "«Organización 1»" in body["skipped"][0]["reason"]
    sent = client.post("/crmdev/batch/confirm", headers=HEADERS, json={"token": body["token"]}).json()
    assert sent["sent"] == 2, sent
    assert two.first.writes() == []  # nothing went to the other organization
    project = next(w["arguments"] for w in two.second.writes() if w["tool"] == "create_project")
    assert project["clientId"] == next(r["id"] for r in two.second.rows["list_clients"] if r["name"] == "Bravo")
    found = pending(client)
    assert "client_missing:k2" not in found and "project_missing:q2" not in found
    connection = connect(settings.data_dir / DB_NAME)
    try:
        assert crmdev_orgs_assign.chosen(connection) == {("client", "k2"): "o2", ("project", "q2"): "o2"}
    finally:
        connection.close()


def test_a_project_never_takes_a_client_of_another_organization(setup, two):
    client, _ = setup
    shown = preview(client, ["project_missing:q2"], org="o1").json()  # Bravo is in neither: no client
    assert "clientId" not in str(shown["operations"][0]["rows"])
    two.first.rows["list_clients"].append({"id": "c7", "name": "Bravo", "status": "CUSTOMER"})
    assert client.post("/crmdev/clients/refresh", headers=HEADERS).status_code == 200
    assert pending(client)["project_missing:q2"]["org"] == "o1"  # its client is now linked in the first one
    refused = preview(client, ["project_missing:q2"], org="o2").json()
    assert refused["status"] == "nothing" and "«Organización 1»" in refused["skipped"][0]["reason"]


def test_an_unknown_organization_is_refused_and_a_forgotten_one_is_no_choice(setup):
    client, settings = setup
    assert preview(client, ["client_missing:k2"], org="o9").status_code == 409
    assert preview(client, ["client_missing:k2"], org="../x").status_code == 422
    assert assign(client, ["client_missing:k2"], "o2").status_code == 200
    assert client.delete("/crmdev/orgs/o2", headers=HEADERS).status_code == 200
    assert pending(client)["client_missing:k2"]["org"] is None
    connection = connect(settings.data_dir / DB_NAME)
    try:
        assert crmdev_orgs.orgs(connection) == [{"id": "o1", "name": "Organización 1"}]
    finally:
        connection.close()
