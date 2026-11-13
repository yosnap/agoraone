import pytest
from fastapi.testclient import TestClient

from agora_core import __version__
from agora_core.app import OWNER_HEADER, SECRET_HEADER, create_app
from agora_core.settings import SettingsError, load_settings

SECRET = "a" * 64
OWNER = "b" * 64


@pytest.fixture
def client():
    settings = load_settings({"AGORA_CORE_SECRET": SECRET})
    return TestClient(create_app(settings), base_url=f"http://{settings.authority}")


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
