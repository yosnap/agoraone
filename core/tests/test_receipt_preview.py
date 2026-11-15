"""A receipt from the phone can be looked at while filling its data, and read by Claude only when the user
allows it in Settings; nothing outside the receipts' folder is ever served."""

from fastapi.testclient import TestClient

from agora_core import receipts
from agora_core.app import SECRET_HEADER, create_app
from agora_core.db import DB_NAME, connect
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings
from tests.test_fiscal_excel import MemorySecrets

SECRET, OWNER = "a" * 64, "b" * 64
PNG = bytes.fromhex("89504e470d0a1a0a") + bytes(64)
H = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}


def test_ver_y_leer_un_recibo(tmp_path):
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        c = connect(settings.data_dir / DB_NAME)
        receipt = receipts.save_receipt(c, settings.data_dir / "receipts", PNG, "ticket.png")
        c.execute("INSERT INTO setting (key, value) VALUES ('fiscal.readWithClaude', 'false')")
        c.commit()
        c.close()
        shown = client.get(f"/fiscal/receipts/{receipt}/preview", headers=H)
        assert shown.status_code == 200 and shown.headers["content-type"] == "image/png" and shown.content == PNG
        assert client.get("/fiscal/receipts/999/preview", headers=H).status_code == 404
        refused = client.post(f"/fiscal/receipts/{receipt}/read", headers=H)
        assert refused.status_code == 422 and "desactivada" in refused.json()["error"]
