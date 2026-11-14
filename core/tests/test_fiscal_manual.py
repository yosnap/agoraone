"""Data typed by hand: only for invoices nothing could be read from; everything readable stays as read."""
import time
from pathlib import Path

from fastapi.testclient import TestClient

from agora_core.app import SECRET_HEADER, create_app
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings
from tests.test_fiscal import _pdf
from tests.test_fiscal_excel import MemorySecrets

SECRET, OWNER = "a" * 64, "b" * 64


def test_solo_lo_ilegible_se_completa_a_mano(tmp_path, monkeypatch):
    home = tmp_path / "home"
    work = home / "Trabajo" / "Actividad"
    received = work / "Facturas Entrantes" / "2026" / "3T"
    received.mkdir(parents=True)
    (received / "rota.pdf").write_bytes(b"%PDF-1.4 rota sin nada que leer")
    (received / "buena.pdf").write_bytes(_pdf(b"Proveedor B44444444 Fecha 02/07/2026 Base imponible 10,00 IVA 21% 2,10 Total 12,10 EUR"))
    monkeypatch.setattr(Path, "home", lambda: home)
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    with TestClient(create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=MemorySecrets()), base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}
        client.put("/fiscal/reading", json={"withClaude": False}, headers=headers)
        folder = client.post("/fiscal/folders", json={"name": "Actividad", "kind": "autonomo", "path": str(work)}, headers=headers).json()["folders"][0]
        url = f"/fiscal/folders/{folder['id']}"

        def quarter():
            for _ in range(100):
                view = client.get(f"{url}/quarter?year=2026&quarter=3", headers=headers).json()
                if not view["reading"]:
                    return view
                time.sleep(0.05)
            raise AssertionError("la lectura no terminó")
        before = quarter()
        broken = next(e for e in before["expenses"] if e["file"].endswith("rota.pdf"))
        assert broken["total"] == "0" and any(i["key"] == "images" for i in before["issues"]), "sin texto: escaneada y sin leer"
        typed = {"name": "Gasolinera", "taxId": "B12345678", "issuedOn": "2026-08-01", "base": "50,00", "vatRate": "21", "vat": "10,50", "total": "60,50"}
        refused = client.put(f"{url}/manual", json={"path": "Facturas Entrantes/2026/3T/buena.pdf", "fields": typed}, headers=headers)
        assert refused.status_code == 422 and "tal como se leyó" in refused.json()["error"], "lo que se lee no se corrige a mano"
        outside = client.put(f"{url}/manual", json={"path": "../fuera.pdf", "fields": typed}, headers=headers)
        assert outside.status_code == 422
        assert client.put(f"{url}/manual", json={"path": "Facturas Entrantes/2026/3T/rota.pdf", "fields": typed}, headers=headers).json() == {"ok": True}
        after = quarter()
        hand = next(e for e in after["expenses"] if e["file"].endswith("rota.pdf"))
        assert (hand["supplier"], hand["taxId"], hand["issuedOn"], hand["base"], hand["vat"], hand["total"]) == ("Gasolinera", "B12345678", "2026-08-01", "50.00", "10.50", "60.50")
        assert "Datos escritos a mano" in hand["doubts"] and hand["manual"]["vatRate"] == 0.21
        assert not any(i["key"] == "images" for i in after["issues"]), "deja de salir como sin leer"
        (received / "rota.pdf").write_bytes(b"%PDF-1.4 otra version distinta")
        changed = next(e for e in quarter()["expenses"] if e["file"].endswith("rota.pdf"))
        assert changed["total"] == "0" and changed["manual"] is None, "si el archivo cambia, lo escrito a mano deja de valer"
        assert client.delete(f"{url}/manual?path=Facturas%20Entrantes/2026/3T/rota.pdf", headers=headers).json() == {"ok": True}


def test_lo_escrito_a_mano_se_comprueba():
    import pytest
    from agora_core import fiscal, fiscal_manual
    ok = fiscal_manual.clean({"issuedOn": "2026-08-01", "total": "1.234,50", "vatRate": "21", "withholdingRate": "1", "taxId": "ESB12345678"})
    assert (ok["total"], ok["vatRate"], ok["withholdingRate"], ok["taxId"], ok["currency"]) == ("1234.50", 0.21, 0.01, "B12345678", "EUR")
    for bad in ({"total": "10"}, {"issuedOn": "2026-08-01"}, {"issuedOn": "2026-08-01", "total": "10", "taxId": "??"},
                {"issuedOn": "2026-08-01", "total": "10", "vatRate": "121"}, {"issuedOn": "2026-08-01", "total": "10", "currency": "EURO"}):
        with pytest.raises(fiscal.FiscalError):
            fiscal_manual.clean(bad)
