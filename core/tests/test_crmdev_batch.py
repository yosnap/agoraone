"""«Enviar a CRMDev»: the ticked warnings of «Pendiente en CRMDev» go in one batch with the exact operations, the tool
fixed by the core, Central's tax id never sent, a project's client created in the same batch, a change that moved in
CRMDev not sent, a batch sent once and each creation linked afterwards. CRMDev is test_crmdev_write's stand-in."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from agora_core import central, crmdev_batch, modules
from agora_core.db import DB_NAME, connect
from test_assistant import MemorySecrets
from test_central_api import HEADERS, app_with
from test_crmdev_api import KEY, URL
from test_crmdev_write import StatefulCrmdev, empty_cache, fake  # noqa: F401 - pytest fixtures

CENTRAL = {
    "clients": [{"id": "k1", "name": "Cliente Uno"}, {"id": "k2", "name": "Bravo"}],
    "projects": [{"id": "q1", "name": "Web Uno", "status": "DORMANT", "client": "Cliente Uno"},
                 {"id": "q2", "name": "Tienda Bravo", "status": "ACTIVE", "client": "Bravo", "repo": "https://github.com/bravo/tienda"}],
    "websites": [{"url": "https://bravo.example", "client": "Bravo", "status": "ok"}], "servers": [],
    "details": {"Cliente Uno": {"email": "info@cliente.example", "company": "Uno Holding"},
                "Bravo": {"email": "hola@bravo.example", "phone": "+34 600 000 000", "taxId": "B99999999", "company": "Bravo SL"}},
}


@pytest.fixture(autouse=True)
def no_pause(monkeypatch):
    monkeypatch.setattr(crmdev_batch, "PAUSE_SECONDS", 0)


@pytest.fixture
def setup(tmp_path, fake):  # noqa: F811
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        assert client.put("/connectors/crmdev", json={"url": URL, "key": KEY}, headers=HEADERS).status_code == 200
        assert client.post("/crmdev/clients/refresh", headers=HEADERS).status_code == 200
        connection = connect(settings.data_dir / DB_NAME)
        try:
            central.refresh(connection, None, fetch=lambda origin: CENTRAL)
        finally:
            connection.close()
        yield client, settings


def pending(client) -> dict:
    return {i["key"]: i for i in client.get("/crmdev-pending", headers=HEADERS).json()["items"]}


def preview(client, keys, **extra):
    return client.post("/crmdev/batch/preview", headers=HEADERS, json={"keys": keys, **extra})


def test_the_whole_batch_goes_in_order_and_is_linked(setup, fake):  # noqa: F811
    client, _ = setup
    found = pending(client)
    assert {"client_missing:k2", "client_changed:k1:c1", "project_missing:q2", "project_changed:q1:p1"} <= set(found)
    shown = preview(client, list(found))
    assert shown.status_code == 200, shown.text
    body = shown.json()
    assert [o["kind"] for o in body["operations"]] == ["crear-cliente", "cambiar-cliente", "crear-proyecto", "cambiar-proyecto"]
    assert "B99999999" not in shown.text  # the tax id never goes to CRMDev
    assert fake.writes() == []  # a review sends nothing
    sent = client.post("/crmdev/batch/confirm", headers=HEADERS, json={"token": body["token"]}).json()
    assert sent["sent"] == 4, sent
    writes = {w["tool"]: w["arguments"] for w in fake.writes()}
    assert writes["create_client"] == {"name": "Bravo", "email": "hola@bravo.example", "company": "Bravo SL", "phone": "+34 600 000 000", "status": "CUSTOMER"}
    assert writes["update_client"] == {"clientId": "c1", "company": "Uno Holding"}
    project = writes["create_project"]
    assert project["clientId"] == "n2" and project["type"] == "GITHUB" and project["status"] == "IN_PROGRESS"
    assert "https://github.com/bravo/tienda" in project["description"] and "https://bravo.example" in project["description"]
    assert writes["update_project"] == {"projectId": "p1", "status": "ON_HOLD"}
    assert all(not w["tool"].startswith("delete_") for w in fake.writes())
    after = pending(client)
    assert not {"client_missing:k2", "client_changed:k1:c1", "project_missing:q2", "project_changed:q1:p1"} & set(after)
    again = client.post("/crmdev/batch/confirm", headers=HEADERS, json={"token": body["token"]}).json()
    assert again["repeated"] is True and len(fake.writes()) == 4  # a batch goes once


def test_a_project_goes_with_its_crmdev_client_or_warns(setup, fake):  # noqa: F811
    client, _ = setup
    found = pending(client)
    assert found["project_missing:q2"]["clientInCrmdev"] is False
    alone = preview(client, ["project_missing:q2"]).json()
    assert "clientId" not in [r["field"] for r in alone["operations"][0]["rows"]]
    assert any("Bravo" in w and "sin cliente" in w for w in alone["warnings"])
    # Its client appeared in CRMDev (not yet read here): the project is paired with it by name, without warning.
    fake.rows["list_clients"].append({"id": "c7", "name": "Bravo", "email": None, "company": None, "status": "CUSTOMER"})
    paired = preview(client, ["project_missing:q2"]).json()
    assert {r["field"]: r["after"] for r in paired["operations"][0]["rows"]}["clientId"] == "Bravo" and not paired["warnings"]
    sent = client.post("/crmdev/batch/confirm", headers=HEADERS, json={"token": paired["token"]}).json()
    assert sent["sent"] == 1 and fake.writes()[0]["arguments"]["clientId"] == "c7"


def test_a_change_that_moved_in_crmdev_is_not_sent(setup, fake):  # noqa: F811
    client, _ = setup
    body = preview(client, ["client_changed:k1:c1"]).json()
    fake.rows["list_clients"][0]["company"] = "Otra cosa"
    sent = client.post("/crmdev/batch/confirm", headers=HEADERS, json={"token": body["token"]}).json()
    assert sent["results"][0]["outcome"] == "conflict" and fake.writes() == []


def test_what_cannot_go_says_why_and_a_crmdev_client_is_never_sent(setup, fake):  # noqa: F811
    client, _ = setup
    refused = preview(client, ["crmdev_only:c9", "client_missing:nadie"])
    assert refused.status_code == 422 and refused.json()["status"] == "nothing"
    assert len(refused.json()["skipped"]) == 2
    assert preview(client, ["../x"]).status_code == 422


def test_a_creation_without_answer_waits_for_anyway(setup, fake):  # noqa: F811
    client, _ = setup
    body = preview(client, ["client_missing:k2"]).json()
    fake.after_write = httpx.ReadTimeout("cut")
    sent = client.post("/crmdev/batch/confirm", headers=HEADERS, json={"token": body["token"]}).json()
    assert sent["results"][0]["outcome"] == "unknown"
    fake.rows["list_clients"] = [r for r in fake.rows["list_clients"] if r["name"] != "Bravo"]  # it was not created after all
    assert preview(client, ["client_missing:k2"]).json()["status"] == "nothing"
    again = preview(client, ["client_missing:k2"], anyway=["client_missing:k2"]).json()
    assert again["warnings"] and again["operations"][0]["kind"] == "crear-cliente"


def test_module_off_is_404(setup):
    client, settings = setup
    connection = connect(settings.data_dir / DB_NAME)
    try:
        modules.save(connection, {"crmdev": False})
    finally:
        connection.close()
    assert preview(client, ["client_missing:k2"]).status_code == 404


def test_an_expired_review_sends_nothing(setup, fake, monkeypatch):  # noqa: F811
    import time

    from agora_core import confirmed_change

    client, _ = setup
    body = preview(client, ["client_missing:k2"]).json()
    later = time.time() + 16 * 60
    monkeypatch.setattr(confirmed_change, "_now", lambda: later)
    answer = client.post("/crmdev/batch/confirm", headers=HEADERS, json={"token": body["token"]})
    assert answer.status_code == 410 and fake.writes() == []


def test_a_batch_of_changes_alone_reads_crmdev_again(setup, fake):  # noqa: F811
    client, _ = setup
    body = preview(client, ["client_changed:k1:c1"]).json()
    assert client.post("/crmdev/batch/confirm", headers=HEADERS, json={"token": body["token"]}).json()["sent"] == 1
    assert "client_changed:k1:c1" not in pending(client)  # the warning goes at once, not at the next reading


def test_when_crmdev_asks_to_wait_the_batch_waits_and_goes_on(setup, fake, monkeypatch):  # noqa: F811
    from agora_core import crmdev_api

    client, _ = setup
    clock = {"now": 1000.0}
    monkeypatch.setattr(crmdev_api, "_clock", lambda: clock["now"])
    monkeypatch.setattr(crmdev_batch.time, "sleep", lambda seconds: clock.update(now=clock["now"] + seconds))
    writes = {"n": 0}

    def limited(request):
        if request.method == "POST" and not json.loads(request.content)["tool"].startswith("list_"):
            writes["n"] += 1
            if writes["n"] == 2:  # the second write: CRMDev's 429, nothing written
                return httpx.Response(429, json={"error": "Too many requests", "retryAfter": 7})
        return fake(request)
    monkeypatch.setattr(crmdev_api, "TRANSPORT", httpx.MockTransport(limited))
    body = preview(client, ["client_missing:k2", "client_changed:k1:c1", "project_missing:q2"]).json()
    sent = client.post("/crmdev/batch/confirm", headers=HEADERS, json={"token": body["token"]}).json()
    assert [r["outcome"] for r in sent["results"]] == ["sent", "sent", "sent"], sent
    assert len(fake.writes()) == 3 and clock["now"] >= 1007  # it waited what CRMDev said
