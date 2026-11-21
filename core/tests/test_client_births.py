"""Clients are born in Central: senders of mail and WhatsApp and people and clients of meetings who are no client yet
come up as proposals (only from what is «normal», never what the directory already knows, never an address nor a
number in the list), and «Crear en Central» creates the ticked ones in one batch, exactly as shown, once, linking a
client kept here. Central is test_central_write's stand-in, with a new id for each creation."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from agora_core import central_api, central_batch, client_births
from agora_core.db import DB_NAME, connect
from test_assistant import MemorySecrets
from test_central_api import HEADERS, KEY, URL, app_with
from test_central_write import FakeCentral

NOW = "2026-11-20T10:00:00Z"


class ManyCentral(FakeCentral):
    """Each new client gets its own id, and Central's list shows the ones created."""

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/api/v1/clientes":
            self.seen.append(request)
            rows = [{**self.client, "version": self.client_version()}] + [{"id": f"c{n:024d}", **c} for n, c in enumerate(self.created, 2)]
            return httpx.Response(200, json={"clients": rows, "nextCursor": None})
        answer = super().__call__(request)
        if request.method == "POST" and request.url.path == "/api/v1/clientes" and answer.status_code == 201:
            made = json.loads(answer.content)["client"]
            made["id"] = f"c{len(self.created) + 1:024d}"
            return httpx.Response(201, json={"client": made})
        return answer


@pytest.fixture(autouse=True)
def no_pause(monkeypatch):
    monkeypatch.setattr(central_batch, "PAUSE_SECONDS", 0)


@pytest.fixture
def fake(monkeypatch):
    found = ManyCentral()
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(found))
    return found


@pytest.fixture
def setup(tmp_path, fake):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        assert client.put("/connectors/central", json={"url": URL, "key": KEY}, headers=HEADERS).status_code == 200
        client.put("/modules", json={"modules": {"central": True}}, headers=HEADERS)
        assert client.post("/central/refresh", headers=HEADERS).status_code == 200
        connection = connect(settings.data_dir / DB_NAME)
        try:
            fill(connection)
        finally:
            connection.close()
        yield client, settings


def fill(connection):
    connection.execute("INSERT INTO mail_account (id, address, provider, username, imap_host, imap_port, created_at) "
                       "VALUES (1, 'yo@mio.es', 'other', 'yo', 'imap.mio.es', 993, ?)", (NOW,))
    mails = [("ana@acme-studio.es", "Ana", "client", "normal"), ("luis@acme-studio.es", "Luis", "job", "normal"),
             ("pepe@gmail.com", "Pepe Pérez", "client", "normal"), ("secreto@oculto.es", "Oculto", "client", "private"),
             ("info@clienteuno.com", "Uno", "client", "normal"), ("boletin@tienda.es", "Tienda", "advertising", "normal"),
             ("yo@mio.es", "Yo", "client", "normal")]
    for n, (address, name, kind, level) in enumerate(mails, 1):
        connection.execute("INSERT INTO mail_message (id, account_id, folder, uidvalidity, uid, from_address, from_name, sent_at, received_at) "
                           "VALUES (?, 1, 'INBOX', 1, ?, ?, ?, datetime('now', '-1 day'), datetime('now', '-1 day'))", (n, n, address, name))
        connection.execute("INSERT INTO mail_summary (message_id, kind, source, confidentiality, created_at) VALUES (?, ?, 'local', ?, ?)",
                           (n, kind, level, NOW))
    connection.execute("INSERT INTO chat_account (id, remote_id, created_at) VALUES (1, 'acc', ?)", (NOW,))
    connection.execute("INSERT INTO chat_conversation (id, account_id, remote_id, participant_name, participant_phone, last_incoming_at) "
                       "VALUES (7, 1, 'conv', 'Marta Reformas', '+34 611 222 333', ?)", (NOW,))
    connection.execute("INSERT INTO chat_summary (conversation_id, kind, source, confidentiality, updated_at) VALUES (7, 'job', 'local', 'normal', ?)", (NOW,))
    connection.execute("INSERT INTO chat_conversation (id, account_id, remote_id, participant_name, participant_phone, last_incoming_at) "
                       "VALUES (8, 1, 'conv2', '34618440999', '+34 618 440 999', ?)", (NOW,))
    connection.execute("INSERT INTO chat_summary (conversation_id, kind, source, confidentiality, updated_at) VALUES (8, 'client', 'local', 'normal', ?)", (NOW,))
    connection.execute("INSERT INTO meeting (owner, title, status, started_at, mic_type, client, people, confidentiality) "
                       "VALUES ('yo', 'Kickoff', 'recorded', ?, 'webm', 'Gamma Labs', ?, 'normal')",
                       (NOW, json.dumps([{"name": "Eva", "email": "eva@gamma.example"}, {"name": "Ana", "email": "ana@acme-studio.es"}])))
    connection.execute("INSERT INTO meeting (owner, title, status, started_at, mic_type, client, confidentiality) "
                       "VALUES ('yo', 'Privada', 'recorded', ?, 'webm', 'Secreta SA', 'private')", (NOW,))
    connection.commit()


def births(client, **params):
    return client.get("/client-births", params=params, headers=HEADERS).json()


def test_proposals_only_from_normal_and_never_known(setup):
    client, _ = setup
    found = births(client)
    names = {i["name"]: i for i in found["items"]}
    assert set(names) == {"Acme Studio", "Pepe Pérez", "Marta Reformas", "Gamma Labs", "Eva", client_births.UNNAMED}  # a number is never a name
    assert names["Acme Studio"]["count"] == 3 and names["Acme Studio"]["hint"] == "acme-studio.es"  # two mails and a meeting
    text = json.dumps([{k: v for k, v in i.items() if k != "key"} for i in found["items"]])  # the keys are hashes
    assert "@" not in text and "611" not in text and "618" not in text  # never an address nor a number in the list


def test_a_dismissed_proposal_can_come_back(setup):
    client, _ = setup
    key = next(i["key"] for i in births(client)["items"] if i["name"] == "Eva")
    assert client.post("/client-births/dismiss", json={"key": key}, headers=HEADERS).json() == {"done": True}
    assert "Eva" not in {i["name"] for i in births(client)["items"]}
    assert births(client)["dismissed"] == 1
    client.post("/client-births/dismiss", json={"key": key, "dismissed": False}, headers=HEADERS)
    assert "Eva" in {i["name"] for i in births(client)["items"]}
    assert client.post("/client-births/dismiss", json={"key": "otra:1"}, headers=HEADERS).status_code == 422


def test_create_in_central_in_one_batch(setup, fake):
    client, _ = setup
    own = client.post("/clients", json={"name": "Cliente Propio", "email": "hola@propio.es", "taxId": "B87654321"}, headers=HEADERS).json()
    by_name = {i["name"]: i["key"] for i in births(client)["items"]}
    items = [{"key": f"local:{own['localId']}"}, {"key": by_name["Acme Studio"], "name": "Acme Studio SL"}, {"key": by_name["Marta Reformas"]},
             {"key": "local:999"}]
    shown = client.post("/central/batch/preview", json={"items": items}, headers=HEADERS)
    assert shown.status_code == 200, shown.text
    body = shown.json()
    rows = {o["title"]: {r["field"]: r["after"] for r in o["rows"]} for o in body["operations"]}
    assert rows["Cliente nuevo en Central «Acme Studio SL»"] == {"name": "Acme Studio SL", "company": "Acme Studio", "email": "ana@acme-studio.es"}
    assert rows["Cliente nuevo en Central «Marta Reformas»"] == {"name": "Marta Reformas", "phone": "+34 611 222 333"}
    assert [s["reason"] for s in body["skipped"]] == ["Ya no está en AgoraOne."]
    assert fake.created == []  # a review creates nothing
    sent = client.post("/central/batch/confirm", json={"token": body["token"]}, headers=HEADERS).json()
    assert sent["sent"] == 3, sent
    assert {c["name"] for c in fake.created} == {"Cliente Propio", "Acme Studio SL", "Marta Reformas"}
    assert client.get(f"/clients/{own['localId']}", headers=HEADERS).json()["centralId"]
    assert {"Acme Studio", "Marta Reformas"}.isdisjoint({i["name"] for i in births(client)["items"]})  # now they are clients
    again = client.post("/central/batch/confirm", json={"token": body["token"]}, headers=HEADERS).json()
    assert again["repeated"] is True and len(fake.created) == 3


def test_a_client_central_has_is_not_created_again(setup, fake):
    client, _ = setup
    own = client.post("/clients", json={"name": "Recién llegado"}, headers=HEADERS).json()
    fake.created.append({"name": "Recién llegado"})  # created in Central after its last reading
    refused = client.post("/central/batch/preview", json={"items": [{"key": f"local:{own['localId']}"}]}, headers=HEADERS)
    assert refused.status_code == 422 and "Central ya tiene" in refused.json()["skipped"][0]["reason"]
    assert client.post("/central/batch/preview", json={"items": [{"key": "../x"}]}, headers=HEADERS).status_code == 422


def test_without_write_permission_nothing_is_asked(setup, fake):
    client, _ = setup
    fake.scopes = ["lectura"]
    key = births(client)["items"][0]["key"]
    assert client.post("/central/batch/preview", json={"items": [{"key": key}]}, headers=HEADERS).status_code == 403
    assert fake.writes() == []


def test_keys_are_safe():
    assert client_births.KEY.fullmatch("chat:7") and client_births.KEY.fullmatch("mail:" + "a" * 24)
    assert not central_batch.valid_key("mail:../../x") and not central_batch.valid_key("local:abc")


def test_an_expired_review_creates_nothing(setup, fake, monkeypatch):
    import time

    from agora_core import confirmed_change

    client, _ = setup
    key = births(client)["items"][0]["key"]
    body = client.post("/central/batch/preview", json={"items": [{"key": key}]}, headers=HEADERS).json()
    later = time.time() + 16 * 60
    monkeypatch.setattr(confirmed_change, "_now", lambda: later)
    answer = client.post("/central/batch/confirm", json={"token": body["token"]}, headers=HEADERS)
    assert answer.status_code == 410 and fake.created == []
