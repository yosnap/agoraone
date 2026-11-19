"""The connectors' contract: the same shape for every connector, never a key in what is answered, the saved key never
sent to another origin, forgetting that touches only the connector's own key (never what was read), and the routes
working with every module off."""

import json
import re

import httpx
import pytest
from fastapi.testclient import TestClient

from agora_core import central, central_api, connectors
from agora_core.db import DB_NAME, connect
from test_central_api import HEADERS, KEY, URL, FakeCentral, app_with, reference_raw
from test_assistant import MemorySecrets

LOOKS_LIKE_KEY = re.compile(r"cen_[A-Za-z0-9_-]{8,}|crm_[A-Za-z0-9_-]{8,}|Bearer", re.IGNORECASE)
IDS = ["central", "fabrica", "costguard", "cerebro-mcp"]


class RecordingSecrets(MemorySecrets):
    """Remembers every account touched, to prove a connector touches only its own."""

    def __init__(self):
        super().__init__()
        self.touched: list[tuple[str, str]] = []

    def get(self, account):
        self.touched.append(("get", account))
        return super().get(account)

    def put(self, account, value):
        self.touched.append(("put", account))
        super().put(account, value)


@pytest.fixture
def fake(monkeypatch):
    found = FakeCentral()
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(found))
    return found


def listed(client) -> dict[str, dict]:
    answer = client.get("/connectors", headers=HEADERS)
    assert answer.status_code == 200
    return {c["id"]: c for c in answer.json()["connectors"]}


def test_todos_los_conectores_con_el_mismo_esquema(tmp_path, fake):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        found = listed(client)
    assert list(found) == IDS
    fields = {"id", "name", "description", "kind", "modules", "views", "window", "scopes", "hint", "state"}
    for entry in found.values():
        assert set(entry) == fields, entry["id"]
        assert set(entry["state"]) == {"status", "configured", "notice", "storeProblem"}, entry["id"]
        assert entry["state"]["status"] in connectors.STATUSES
    assert {e["id"]: e["kind"] for e in found.values()} == {"central": "web_api", "fabrica": "local_port", "costguard": "local_file", "cerebro-mcp": "guide"}
    assert set(found["central"]["modules"]) == {"central", "presupuestos"} and found["central"]["scopes"] == list(central_api.SCOPES)
    assert found["central"]["state"]["configured"] == {"url": None, "hasKey": False} and found["central"]["state"]["status"] == "not_configured"
    assert found["fabrica"]["state"]["configured"] == {"path": None, "port": 8742}
    assert found["cerebro-mcp"]["state"]["status"] == "guide" and found["cerebro-mcp"]["modules"] == {}


def test_ninguna_respuesta_tiene_algo_con_pinta_de_clave(tmp_path, fake):
    secrets = MemorySecrets()
    settings, app = app_with(tmp_path, secrets)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        saved = client.put("/connectors/central", json={"url": URL, "key": KEY}, headers=HEADERS)
        assert saved.status_code == 200 and saved.json()["state"]["status"] == "saved"
        assert saved.json()["state"]["configured"] == {"url": URL, "hasKey": True}
        tested = client.post("/connectors/central/test", headers=HEADERS)
        for answer in (saved, tested, client.get("/connectors", headers=HEADERS)):
            assert not LOOKS_LIKE_KEY.search(answer.text), answer.text
        for body in (b"[1, 2]", f'"{KEY}"'.encode(), b"{no es json", f'{{"url": "{URL}", "key": 5, "x": "{KEY}"}}'.encode()):
            refused = client.put("/connectors/central", content=body, headers=HEADERS)
            assert refused.status_code == 422 and KEY not in refused.text, body
    c = connect(settings.data_dir / DB_NAME)
    try:
        dumped = "\n".join(str(tuple(row)) for row in c.execute("SELECT * FROM setting"))
        assert KEY not in dumped, "la clave nunca va a la base de datos"
    finally:
        c.close()


def test_la_clave_guardada_no_viaja_a_otro_origen(tmp_path, fake):
    secrets = MemorySecrets()
    settings, app = app_with(tmp_path, secrets)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        client.put("/connectors/central", json={"url": URL, "key": KEY}, headers=HEADERS)
        before = len(fake.seen)
        moved = client.put("/connectors/central", json={"url": "https://central.example.net"}, headers=HEADERS)
        assert moved.status_code == 422 and moved.json()["error"] == connectors.NEW_ORIGIN
        tested = client.post("/connectors/central/test", json={"url": "https://central.example.net"}, headers=HEADERS)
        assert tested.status_code == 422 and tested.json()["status"] == "config"
        assert len(fake.seen) == before
        assert listed(client)["central"]["state"]["configured"]["url"] == URL


def test_olvidar_central_solo_borra_su_clave(tmp_path, fake):
    secrets = RecordingSecrets()
    secrets.put("otra-cuenta", "intocable")
    settings, app = app_with(tmp_path, secrets)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        client.put("/connectors/central", json={"url": URL, "key": KEY}, headers=HEADERS)
        c = connect(settings.data_dir / DB_NAME)
        try:
            central.refresh(c, central_api.Connection(URL, KEY), fetch=lambda origin: reference_raw())
            kept = central.stored(c)
        finally:
            c.close()
        secrets.touched.clear()
        gone = client.delete("/connectors/central", headers=HEADERS)
        assert gone.status_code == 200 and gone.json()["state"]["configured"] == {"url": URL, "hasKey": False}
        assert {account for _, account in secrets.touched} == {central_api.SECRET}, "solo su propia cuenta"
        assert ("put", central_api.SECRET) in secrets.touched and secrets.values == {"otra-cuenta": "intocable"}
        c = connect(settings.data_dir / DB_NAME)
        try:
            assert central.stored(c) == kept, "lo leído se conserva"
            assert central_api.saved_url(c) == URL
        finally:
            c.close()
        for other in ("fabrica", "costguard", "cerebro-mcp"):
            secrets.touched.clear()
            assert client.delete(f"/connectors/{other}", headers=HEADERS).status_code == 200
            assert not any(kind == "put" for kind, _ in secrets.touched), f"{other} no toca el almacén"


def test_con_todos_los_modulos_apagados_se_puede_conectar(tmp_path, fake):
    secrets = MemorySecrets()
    settings, app = app_with(tmp_path, secrets)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        client.put("/modules", json={"modules": {"central": False, "presupuestos": False, "fabrica": False, "conectores": False}}, headers=HEADERS)
        found = listed(client)
        assert found["central"]["modules"] == {"central": False, "presupuestos": False}
        assert client.put("/connectors/central", json={"url": URL, "key": KEY}, headers=HEADERS).status_code == 200
        assert client.post("/connectors/central/test", headers=HEADERS).json()["version"] == "0.5.0"
        assert client.put("/connectors/fabrica", json={"port": 9001}, headers=HEADERS).json()["state"]["configured"]["port"] == 9001
        assert client.post("/connectors/fabrica/test", json={"port": 9001}, headers=HEADERS).json()["status"] == "not_configured"
        assert client.delete("/connectors/central", headers=HEADERS).status_code == 200
        assert client.delete("/connectors/fabrica", headers=HEADERS).json()["state"]["configured"]["port"] == 8742


def test_conector_desconocido_y_guia(tmp_path, fake):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        for method, path in (("put", "/connectors/otro"), ("post", "/connectors/otro/test"), ("delete", "/connectors/otro")):
            assert getattr(client, method)(path, headers=HEADERS).status_code == 404
        assert client.put("/connectors/cerebro-mcp", json={}, headers=HEADERS).status_code == 422
        assert client.post("/connectors/cerebro-mcp/test", headers=HEADERS).json() == {"status": "guide"}
        assert client.post("/connectors/fabrica/test", json={"port": 80}, headers=HEADERS).status_code == 422
        assert client.put("/connectors/fabrica", json={"dataPath": "/x"}, headers=HEADERS).status_code == 422, "solo sus propios ajustes"


def test_la_carpeta_antigua_de_central_se_ve_como_legacy(tmp_path, fake):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        c = connect(settings.data_dir / DB_NAME)
        try:
            c.execute("INSERT INTO setting (key, value) VALUES ('addons.central', ?)", (json.dumps({"path": "/ruta/de/central"}),))
            c.commit()
        finally:
            c.close()
        state = listed(client)["central"]["state"]
        assert state["status"] == "legacy" and state["notice"] == central.MOVED
