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


def test_el_puerto_deja_de_escuchar_y_las_conexiones_lentas_no_bloquean(db, tmp_path):
    import socket
    window = receipts.open_window(lambda d, n: receipts.save_receipt(db, tmp_path / "r", d, n), address="127.0.0.1", seconds=30)
    port = int(window.url.split(":")[2].split("/")[0])
    slow = [socket.create_connection(("127.0.0.1", port)) for _ in range(6)]  # never send anything
    for s in slow:
        s.send(b"GE")
    time.sleep(0.3)
    window.close()
    time.sleep(0.5)
    with pytest.raises(OSError):
        socket.create_connection(("127.0.0.1", port), timeout=1)
    for s in slow:
        s.close()


def test_un_recibo_descartado_vuelve_al_subirlo_otra_vez(db, tmp_path):
    first = receipts.save_receipt(db, tmp_path / "r", JPEG, "a.jpg")
    db.execute("UPDATE receipt SET state = 'dismissed'")
    assert receipts.save_receipt(db, tmp_path / "r", JPEG, "a.jpg") == first
    assert db.execute("SELECT state FROM receipt").fetchone()[0] == "pending"
    db.execute("UPDATE receipt SET state = 'filed'")
    with pytest.raises(receipts.UploadError):
        receipts.save_receipt(db, tmp_path / "r", JPEG, "a.jpg")


def test_carpeta_propuesta_por_ambito(db):
    from agora_core import fiscal, mail, mail_rules
    trabajo = db.execute("INSERT INTO scope (slug, name, created_at) VALUES ('trabajo', 'Trabajo', 'x')").lastrowid
    casa = db.execute("INSERT INTO scope (slug, name, created_at) VALUES ('casa', 'Casa', 'x')").lastrowid
    humanitek = db.execute("INSERT INTO scope (slug, name, created_at) VALUES ('hk', 'Humanitek', 'x')").lastrowid
    autonomo = db.execute("INSERT INTO fiscal_folder (name, kind, path, scope_id, created_at) VALUES ('Autónomo', 'autonomo', '/a', ?, 'x')", (trabajo,)).lastrowid
    empresa = db.execute("INSERT INTO fiscal_folder (name, kind, path, scope_id, created_at) VALUES ('HK', 'empresa', '/b', ?, 'x')", (humanitek,)).lastrowid
    def message(scope):
        account = mail.create_account(db, {"address": f"c{scope}@gmail.com", "provider": "gmail", "scopeId": scope})
        return db.execute("INSERT INTO mail_message (account_id, folder, uidvalidity, uid, from_address, received_at) VALUES (?, 'INBOX', 1, 1, 'f@p.com', 'x')",
                          (account,)).lastrowid
    assert fiscal.suggested_folder(db, message(trabajo)) == autonomo
    assert fiscal.suggested_folder(db, message(casa)) is None, "un ámbito sin carpeta no cae en la de autónomo"
    personal = message(None)
    assert fiscal.suggested_folder(db, personal) is None, "con dos carpetas profesionales no se adivina"
    rule = mail_rules.create_rule(db, {"name": "HK", "action": "invoice", "sender": "p.com", "scopeId": humanitek})
    db.execute("INSERT INTO mail_summary (message_id, kind, source, rule_id, confidentiality, created_at) VALUES (?, 'invoice', 'rule', ?, 'normal', 'x')", (personal, rule))
    assert fiscal.suggested_folder(db, personal) == empresa, "la regla manda sobre la cuenta"


def _old(path, seconds=60):
    """A file that has rested, as one the bot finished writing a while ago."""
    import os
    stamp = time.time() - seconds
    os.utime(path, (stamp, stamp))


def test_carpeta_de_entrada_del_bot(db, tmp_path):
    """What the user's Hermes bot leaves in «Recibos por revisar» becomes a pending receipt; links, hidden,
    unknown or half-written files are left alone; dismissed or repeated ones move to «Descartados» and one
    sent again comes back; the original leaves once filed, and only if it is the very same file."""
    receipts._seen.clear()
    root = tmp_path / "Autonomo"
    inbox = root / receipts.INBOX
    inbox.mkdir(parents=True)
    (inbox / "ticket.jpg").write_bytes(JPEG)
    (inbox / ".oculto.jpg").write_bytes(JPEG + b"1")
    (inbox / "notas.txt").write_text("no es un recibo")
    (tmp_path / "fuera.jpg").write_bytes(JPEG + b"2")
    try:
        (inbox / "enlace.jpg").symlink_to(tmp_path / "fuera.jpg")
    except OSError:
        import _winapi

        (tmp_path / "fuera_dir").mkdir()
        _winapi.CreateJunction(str((tmp_path / "fuera_dir").resolve()), str(inbox / "enlace.jpg"))
    for path in inbox.iterdir():
        if not (path.is_symlink() or path.is_junction()):
            _old(path)
    (inbox / "escribiendo.jpg").write_bytes(JPEG + b"3")  # just written: not yet
    db.execute("INSERT INTO fiscal_folder (name, kind, path, created_at) VALUES ('Autónomo', 'autonomo', ?, '2026-11-15')", (str(root),))
    folder_id = db.execute("SELECT id FROM fiscal_folder").fetchone()[0]
    opener = lambda: connect(tmp_path / "data" / DB_NAME)  # noqa: E731
    folders = [(folder_id, root)]
    assert receipts.import_inbox(opener, tmp_path / "r", folders) == 1
    assert [(r["name"], r["source"], r["inboxFolder"]) for r in receipts.receipts(db)] == [("ticket.jpg", "inbox", folder_id)]
    assert receipts.import_inbox(opener, tmp_path / "r", folders) == 0, "una vez traído no se repite"
    _old(inbox / "escribiendo.jpg")
    assert receipts.import_inbox(opener, tmp_path / "r", folders) == 1, "ya terminado, entra"
    row = db.execute("SELECT inbox_name, sha256 FROM receipt WHERE inbox_name = 'ticket.jpg'").fetchone()
    # Dismissed: set aside, and back if it is sent again.
    assert receipts.set_aside(root, row["inbox_name"], row["sha256"])
    db.execute("UPDATE receipt SET state = 'dismissed' WHERE inbox_name = 'ticket.jpg'")
    assert (inbox / receipts.DISCARDED / "ticket.jpg").exists() and not (inbox / "ticket.jpg").exists()
    (inbox / "otra-vez.jpg").write_bytes(JPEG)
    _old(inbox / "otra-vez.jpg")
    assert receipts.import_inbox(opener, tmp_path / "r", folders) == 1
    assert db.execute("SELECT state, inbox_name FROM receipt WHERE sha256 = ?", (row["sha256"],)).fetchone()[:] == ("pending", "otra-vez.jpg")
    # Filing removes only the very same file, never outside the inbox.
    (inbox / "otra-vez.jpg").write_bytes(JPEG + b" cambiado")
    assert not receipts.remove_from_inbox(root, "otra-vez.jpg", row["sha256"]), "un archivo cambiado se queda"
    (inbox / "otra-vez.jpg").write_bytes(JPEG)
    assert not receipts.remove_from_inbox(root, "../fuera.jpg", row["sha256"]), "nada fuera de la carpeta de entrada"
    assert receipts.remove_from_inbox(root, "otra-vez.jpg", row["sha256"])
    db.execute("UPDATE receipt SET state = 'filed' WHERE sha256 = ?", (row["sha256"],))
    # A repeat of one already filed goes to «Descartados» instead of piling up.
    (inbox / "repetido.jpg").write_bytes(JPEG)
    _old(inbox / "repetido.jpg")
    receipts.import_inbox(opener, tmp_path / "r", folders)
    assert not (inbox / "repetido.jpg").exists() and (inbox / receipts.DISCARDED / "repetido.jpg").exists()
    assert (tmp_path / "fuera.jpg").exists()


def test_carpeta_de_entrada_con_muchos_archivos_o_como_enlace(db, tmp_path):
    """The newest files are looked at first, whatever else the folder holds; an inbox that is a link is ignored."""
    receipts._seen.clear()
    root = tmp_path / "Autonomo"
    inbox = root / receipts.INBOX
    inbox.mkdir(parents=True)
    for number in range(205):
        path = inbox / f"viejo-{number}.txt"
        path.write_text("no es un recibo")
        _old(path, 3600)
    (inbox / "nuevo.jpg").write_bytes(JPEG + b"nuevo")
    _old(inbox / "nuevo.jpg", 30)
    db.execute("INSERT INTO fiscal_folder (name, kind, path, created_at) VALUES ('A', 'autonomo', ?, '2026-11-15')", (str(root),))
    folder_id = db.execute("SELECT id FROM fiscal_folder").fetchone()[0]
    opener = lambda: connect(tmp_path / "data" / DB_NAME)  # noqa: E731
    assert receipts.import_inbox(opener, tmp_path / "r", [(folder_id, root)]) == 1, "el nuevo entra aunque haya 205 archivos más"
    other = tmp_path / "Otra"
    other.mkdir()
    (tmp_path / "real").mkdir()
    (tmp_path / "real" / "x.jpg").write_bytes(JPEG + b"x")
    _old(tmp_path / "real" / "x.jpg")
    try:
        (other / receipts.INBOX).symlink_to(tmp_path / "real", target_is_directory=True)
    except OSError:
        import _winapi

        _winapi.CreateJunction(str((tmp_path / "real").resolve()), str(other / receipts.INBOX))
    assert receipts.import_inbox(opener, tmp_path / "r", [(folder_id, other)]) == 0, "una carpeta de entrada que es un enlace no se lee"
