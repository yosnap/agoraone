"""Opening apps: only installed ones, by their identifier; the allowed ones without asking, the rest only
once confirmed; nothing typed ever becomes a command."""

import pytest

from agora_core import apps
from agora_core.db import DB_NAME, connect, migrate


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(apps, "installed", lambda: [{"id": "com.apple.Notes", "name": "Notas"}, {"id": "com.spotify.client", "name": "Spotify"}])
    opened = []
    monkeypatch.setattr(apps.subprocess, "run", lambda command, **kw: opened.append(command) or type("Done", (), {"returncode": 0})())
    monkeypatch.setattr(apps.sys, "platform", "darwin")
    c = connect(tmp_path / DB_NAME)
    migrate(c)
    yield c, opened
    c.close()


def test_abrir_solo_lo_instalado_y_lo_permitido(setup):
    c, opened = setup
    assert apps.save_allowed(c, ["com.apple.Notes", "rm -rf /", "com.desconocida"]) == ["com.apple.Notes"]
    assert apps.open_app(c, "com.apple.Notes", confirmed=False) == "Abierta Notas."
    assert opened[-1] == ["/usr/bin/open", "-b", "com.apple.Notes"]
    with pytest.raises(apps.AppsError) as refused:
        apps.open_app(c, "com.spotify.client", confirmed=False)
    assert refused.value.status == 409 and len(opened) == 1, "sin permitir, pide confirmación"
    assert apps.open_app(c, "com.spotify.client", confirmed=True) == "Abierta Spotify."
    with pytest.raises(apps.AppsError) as missing:
        apps.open_app(c, "; rm -rf ~", confirmed=True)
    assert missing.value.status == 404 and len(opened) == 2


def test_oye_watson_apagado_por_defecto(tmp_path):
    from fastapi.testclient import TestClient
    from agora_core.app import SECRET_HEADER, create_app
    from agora_core.keystore import MemoryStore
    from agora_core.settings import load_settings
    from tests.test_fiscal_excel import MemorySecrets
    settings = load_settings({"AGORA_CORE_SECRET": "a" * 64, "AGORA_CORE_DATA": str(tmp_path / "data")})
    with TestClient(create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=MemorySecrets()), base_url=f"http://{settings.authority}") as client:
        h = {SECRET_HEADER: "a" * 64}
        assert client.get("/wake/settings", headers=h).json() == {"enabled": False, "state": None, "attempt": 0}
        assert client.put("/wake/settings", json={"enabled": True}, headers=h).json() == {"enabled": True, "state": None, "attempt": 1}
        assert client.post("/wake/status", json={"state": "no_offline"}, headers=h).json() == {"state": "no_offline"}
        assert client.get("/wake/settings", headers=h).json()["state"] == "no_offline", "la app de escritorio cuenta por qué no escucha"
        assert client.post("/wake/status", json={"state": "rm -rf"}, headers=h).status_code == 400
