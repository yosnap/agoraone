import json
import logging

import pytest
from fastapi.testclient import TestClient

from agora_core import app_log
from agora_core.app import SECRET_HEADER, create_app
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings

SECRET = "a" * 64
H = {SECRET_HEADER: SECRET}


@pytest.fixture
def made(tmp_path):
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False)

    @app.get("/boom-for-test")
    async def boom():
        raise RuntimeError("fallo de prueba")

    with TestClient(app, base_url=f"http://{settings.authority}", raise_server_exceptions=False) as client:
        yield client, settings


def test_el_arranque_y_un_error_sin_controlar_quedan_en_el_registro(made):
    client, settings = made
    response = client.get("/boom-for-test?correo=privado", headers=H)
    assert response.status_code == 500 and "Registro" in response.json()["error"]
    entries = client.get("/logs", headers=H).json()["entries"]
    assert entries[0]["level"] == "error" and "GET /boom-for-test" in entries[0]["message"] and "RuntimeError" in entries[0]["message"]
    assert "privado" not in json.dumps(entries)  # never the query string
    assert any("Núcleo arrancado" in e["message"] for e in entries)


def test_la_interfaz_anade_errores_acotados_y_se_filtran(made):
    client, _ = made
    assert client.post("/logs/client", headers=H, json={"level": "error", "area": "bandeja", "message": "No cargó"}).status_code == 204
    assert client.post("/logs/client", headers=H, json={"level": "critical", "message": "x"}).status_code == 422
    assert client.post("/logs/client", headers=H, json={"level": "error", "message": "x" * 2001}).status_code == 422
    errors = client.get("/logs?level=error&source=interfaz", headers=H).json()["entries"]
    assert [(e["area"], e["message"], e["source"]) for e in errors] == [("bandeja", "No cargó", "interfaz")]
    assert client.get("/logs?q=no%20carg", headers=H).json()["entries"][0]["message"] == "No cargó"
    assert client.get("/logs", headers={}).status_code == 401


def test_las_lineas_con_pinta_de_clave_se_ocultan_y_el_texto_se_recorta():
    assert app_log.clean("token: abcdefghijkl") == "[oculto: parece una clave]"
    assert "sk-" not in app_log.clean("fallo con sk-ant-api03-abcdefghijklmnopqrstuv dentro")
    assert len(app_log.clean("y" * 5000)) == app_log.MAX_MESSAGE
    assert app_log.clean("uno\ndos") == "uno ⏎ dos"


def test_el_archivo_rota_y_no_crece_sin_limite(tmp_path, monkeypatch):
    monkeypatch.setattr(app_log, "MAX_BYTES", 2000)
    logger = app_log.setup(tmp_path)
    handler = next(h for h in logger.handlers if getattr(h, "agora_log", None))
    handler.maxBytes = 2000
    for n in range(400):
        logging.getLogger("agora_core.prueba").warning("mensaje %s %s", n, "z" * 50)
    files = sorted((tmp_path / "logs").iterdir())
    assert len(files) == app_log.BACKUPS + 1
    assert all(f.stat().st_size <= 2200 for f in files)
    newest = app_log.read(tmp_path, limit=1)[0]
    assert newest["message"].startswith("mensaje 399") and newest["area"] == "prueba"
