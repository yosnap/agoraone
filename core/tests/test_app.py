import pytest
from fastapi.testclient import TestClient

from agora_core import __version__
from agora_core.app import OWNER_HEADER, SECRET_HEADER, create_app
from agora_core.keystore import MemoryStore
from agora_core.settings import SettingsError, load_settings

SECRET = "a" * 64
OWNER = "b" * 64


@pytest.fixture
def client(tmp_path):
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    with TestClient(create_app(settings, MemoryStore(), scheduler=False), base_url=f"http://{settings.authority}") as client:
        yield client


def test_no_arranca_sin_secreto_valido():
    for env in ({}, {"AGORA_CORE_SECRET": ""}, {"AGORA_CORE_SECRET": "corto"}, {"AGORA_CORE_SECRET": "G" * 64}):
        with pytest.raises(SettingsError):
            load_settings(env)


def test_rechaza_peticiones_sin_secreto_o_con_secreto_erroneo(client):
    assert client.get("/health").status_code == 401
    assert client.get("/health", headers={SECRET_HEADER: "c" * 64}).status_code == 401
    assert client.get("/health", headers={SECRET_HEADER: SECRET[:-1]}).status_code == 401


def test_rechaza_host_ajeno_aunque_lleve_secreto(client):
    response = client.get("/health", headers={SECRET_HEADER: SECRET, "host": "evil.example:4318"})
    assert response.status_code == 403


def test_health_con_secreto(client):
    response = client.get("/health", headers={SECRET_HEADER: SECRET})
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": __version__}
    assert response.headers["cache-control"] == "no-store"


def test_whoami_exige_propietario_valido(client):
    assert client.get("/whoami", headers={SECRET_HEADER: SECRET}).status_code == 400
    assert client.get("/whoami", headers={SECRET_HEADER: SECRET, OWNER_HEADER: "x"}).status_code == 400
    response = client.get("/whoami", headers={SECRET_HEADER: SECRET, OWNER_HEADER: OWNER})
    assert response.json() == {"owner": OWNER}


def test_sin_documentacion_publica(client):
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path, headers={SECRET_HEADER: SECRET}).status_code == 404


def test_ruta_de_datos_relativa_rechazada():
    with pytest.raises(SettingsError):
        load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": "relativa"})


def test_copias_por_api(client):
    headers = {SECRET_HEADER: SECRET}
    assert client.get("/backups", headers=headers).json() == {"backups": [], "recoveryKeyPending": False}
    made = client.post("/backups", headers=headers)
    assert made.status_code == 201 and made.json()["kind"] == "manual"
    listed = client.get("/backups", headers=headers).json()
    assert [b["name"] for b in listed["backups"]] == [made.json()["name"]]
    assert listed["recoveryKeyPending"] is True, "la clave se acaba de crear y aún no se ha mostrado"
    assert client.post("/backups").status_code == 401
