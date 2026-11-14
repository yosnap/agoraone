import time

import httpx
import pytest

from agora_core import receipts
from agora_core.db import DB_NAME, connect, migrate

JPEG = b"\xff\xd8\xff\xe0 recibo de prueba"


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "data" / DB_NAME)
    migrate(connection)
    yield connection
    connection.close()


def test_una_sola_subida_y_se_cierra(db, tmp_path):
    stored = []

    def store(data, name):
        stored.append(name)
        return receipts.save_receipt(db, tmp_path / "recibos", data, name)
    window = receipts.open_window(store, address="127.0.0.1", seconds=30)
    base = window.url.rsplit("/", 1)[0]
    assert httpx.get(base + "/otro-token").status_code == 404, "sin el enlace exacto no hay nada"
    page = httpx.get(window.url)
    assert page.status_code == 200 and 'type="file"' in page.text and page.headers["cache-control"] == "no-store"
    refused = httpx.post(window.url, files={"recibo": ("x.txt", b"hola", "text/plain")})
    assert refused.status_code == 415 and stored == ["x.txt"]
    done = httpx.post(window.url, files={"recibo": ("ticket.jpg", JPEG, "image/jpeg")})
    assert done.status_code == 200 and "Recibido" in done.text
    row = db.execute("SELECT media_type, original_name, state FROM receipt").fetchone()
    assert tuple(row) == ("image/jpeg", "ticket.jpg", "pending")
    for _ in range(50):
        if window.closed:
            break
        time.sleep(0.05)
    assert window.closed
    with pytest.raises(httpx.HTTPError):
        httpx.get(window.url, timeout=2)


def test_caduca_sin_subir_nada(db, tmp_path):
    window = receipts.open_window(lambda d, n: 1, address="127.0.0.1", seconds=1)
    time.sleep(1.3)
    assert window.closed


def test_solo_red_local_privada_y_qr():
    assert receipts.qr_svg("http://192.168.1.5:5000/abc").lstrip().startswith("<svg")


def test_la_carpeta_unica_anterior_pasa_a_ser_la_primera(tmp_path):
    from agora_core.db import available_migrations
    connection = connect(tmp_path / DB_NAME)
    # Apply everything up to 0011, then the old setting, then the rest.
    connection.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)")
    migrations = available_migrations()
    from agora_core import db as dbmod
    original = dbmod.available_migrations
    dbmod.available_migrations = lambda: [m for m in migrations if m[0] <= 11]
    try:
        migrate(connection)
    finally:
        dbmod.available_migrations = original
    connection.execute("INSERT INTO setting (key, value) VALUES ('fiscal.folder', '\"/Users/x/Trabajo\"')")
    migrate(connection)
    assert tuple(connection.execute("SELECT name, kind, path FROM fiscal_folder").fetchone()) == ("Autónomo", "autonomo", "/Users/x/Trabajo")
    assert connection.execute("SELECT count(*) FROM setting WHERE key = 'fiscal.folder'").fetchone()[0] == 0
