"""Trabajos' settings: the central bot is the root profile until the user picks another, by Hermes name."""

from fastapi.testclient import TestClient

from agora_core.app import SECRET_HEADER, create_app
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings
from tests.test_fiscal_excel import MemorySecrets

SECRET, OWNER = "a" * 64, "b" * 64


def test_bot_central_por_defecto_y_cambiado(tmp_path):
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=MemorySecrets())
    headers = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        assert client.get("/jobs/settings", headers=headers).json() == {"central": "default"}
        assert client.put("/jobs/settings", json={"central": "pro"}, headers=headers).json() == {"central": "pro"}
        assert client.get("/jobs/settings", headers=headers).json() == {"central": "pro"}
        for wrong in ["../pro", "Pro Bot", "", "x" * 65]:
            assert client.put("/jobs/settings", json={"central": wrong}, headers=headers).status_code in (400, 422)
        assert client.get("/jobs/settings", headers=headers).json() == {"central": "pro"}
