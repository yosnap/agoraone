import shutil
import stat
import sys
from datetime import UTC, datetime, timedelta

import pytest

from agora_core.backup import BackupError, create_backup, decrypt, ensure_daily, list_backups, prune, restore
from agora_core.db import DB_NAME, connect, migrate
from agora_core.keystore import KeyStoreError, MemoryStore, ensure_key, key_from_recovery, recovery_code

NOW = datetime(2026, 11, 13, 12, 0, tzinfo=UTC)


@pytest.fixture
def data(tmp_path):
    folder = tmp_path / "data"
    database = connect(folder / DB_NAME)
    migrate(database)
    database.execute("INSERT INTO scope (slug, name, created_at) VALUES ('prueba', 'Prueba', '2026-01-01T00:00:00Z')")
    database.close()
    return folder


def scopes(folder):
    database = connect(folder / DB_NAME)
    try:
        return [r[0] for r in database.execute("SELECT slug FROM scope ORDER BY id")]
    finally:
        database.close()


def test_copia_cifrada_privada_y_restauracion_identica(data):
    store = MemoryStore()
    made = create_backup(data, store, "manual", NOW)
    if sys.platform != "win32":
        assert stat.S_IMODE(made.path.stat().st_mode) == 0o600
    assert b"prueba" not in made.path.read_bytes(), "el contenido no queda en claro"
    database = connect(data / DB_NAME)
    database.execute("DELETE FROM scope WHERE slug = 'prueba'")
    database.close()
    aside = restore(data, made.path, store.key)
    assert scopes(data) == ["personal", "prueba"]
    assert aside.exists(), "la base anterior se conserva aparte"


def test_clave_erronea_o_archivo_manipulado(data):
    store = MemoryStore()
    made = create_backup(data, store, at=NOW)
    with pytest.raises(BackupError):
        decrypt(b"\x00" * 32, made.path.read_bytes())
    blob = bytearray(made.path.read_bytes())
    blob[-1] ^= 1
    with pytest.raises(BackupError):
        decrypt(store.key, bytes(blob))
    with pytest.raises(BackupError):
        decrypt(store.key, b"no es una copia")


def test_restaurar_con_la_clave_de_recuperacion(data):
    store = MemoryStore()
    made = create_backup(data, store, at=NOW)
    code = recovery_code(store.key)
    assert key_from_recovery(code.lower()) == store.key
    # A middle character: the last one also carries base32 padding bits, so changing it may not alter the key.
    typo = code[:10] + ("A" if code[10] != "A" else "B") + code[11:]
    with pytest.raises(KeyStoreError):
        key_from_recovery(typo)
    restore(data, made.path, key_from_recovery(code))
    assert scopes(data) == ["personal", "prueba"]


def test_la_clave_se_crea_una_vez(data):
    store = MemoryStore()
    key, created = ensure_key(store, data)
    assert created and len(key) == 32
    assert ensure_key(store, data) == (key, False)
    with pytest.raises(KeyStoreError):
        ensure_key(MemoryStore(b"corta"), data)


def test_retencion_diaria_semanal_manuales_y_previas(data):
    store = MemoryStore()
    for day in range(70):  # one daily backup per day, ten weeks back
        create_backup(data, store, "daily", NOW - timedelta(days=day))
    for n in range(12):
        create_backup(data, store, "manual", NOW - timedelta(hours=n))  # several on the same day
    for n in range(7):
        create_backup(data, store, "premigration", NOW - timedelta(days=n, minutes=5))
    prune(data, NOW)
    kept = list_backups(data)
    daily = [b for b in kept if b.kind == "daily"]
    assert len({b.created.date() for b in daily}) == len(daily), "una diaria por día como mucho"
    recent = [b for b in daily if NOW - b.created < timedelta(days=14)]
    assert len(recent) == 14, "las de los 14 últimos días"
    older = [b for b in daily if NOW - b.created >= timedelta(days=14)]
    assert older and all(NOW - b.created < timedelta(weeks=8) for b in older), "semanales dentro de 8 semanas"
    weeks = {b.created.isocalendar()[:2] for b in daily}
    window = {(NOW - timedelta(days=d)).isocalendar()[:2] for d in range(56)}
    assert weeks == window, "una por cada semana (ISO) que toca la ventana de 8 semanas"
    assert len([b for b in kept if b.kind == "manual"]) == 10, "las 10 manuales más recientes, aunque sean del mismo día"
    assert len([b for b in kept if b.kind == "premigration"]) == 5


def test_una_copia_con_fecha_futura_no_bloquea_las_diarias_ni_se_borra(data):
    store = MemoryStore()
    future = create_backup(data, store, "daily", NOW + timedelta(days=30))
    assert ensure_daily(data, store, NOW) is not None
    assert future.path.exists(), "si el reloj retrocedió, no se borran copias reales"


def test_dos_copias_en_el_mismo_instante_no_se_pisan(data):
    store = MemoryStore()
    first = create_backup(data, store, "manual", NOW)
    second = create_backup(data, store, "manual", NOW)
    assert first.path != second.path and first.path.exists() and second.path.exists()


def test_copia_diaria_solo_si_hace_falta(data):
    store = MemoryStore()
    assert ensure_daily(data, store, NOW) is not None
    assert ensure_daily(data, store, NOW + timedelta(hours=3)) is None
    assert ensure_daily(data, store, NOW + timedelta(hours=25)) is not None


def test_sin_base_no_hay_copia(tmp_path):
    with pytest.raises(BackupError):
        create_backup(tmp_path, MemoryStore())
    assert ensure_daily(tmp_path, MemoryStore()) is None


def test_restaurar_algo_que_no_es_una_base(data, tmp_path):
    from agora_core.backup import encrypt

    store = MemoryStore()
    key, _ = ensure_key(store, data)
    fake = tmp_path / "falsa.agb"
    fake.write_bytes(encrypt(key, b"esto no es sqlite" * 100))
    with pytest.raises(BackupError):
        restore(data, fake, key)
    assert scopes(data) == ["personal", "prueba"], "la base actual no se toca"


def test_no_crea_una_clave_nueva_si_ya_hay_copias(data):
    store = MemoryStore()
    create_backup(data, store, at=NOW)
    store.key = None  # Llavero vaciado
    with pytest.raises(KeyStoreError):
        create_backup(data, store, at=NOW + timedelta(hours=1))
    assert store.key is None


def test_la_clave_es_la_misma_aunque_dos_hilos_la_pidan_a_la_vez(data):
    import threading
    import time

    class Slow(MemoryStore):
        def get(self):
            value = self.key
            time.sleep(0.01)
            return value

    store, keys = Slow(), []
    threads = [threading.Thread(target=lambda: keys.append(ensure_key(store, data)[0])) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(set(keys)) == 1 and keys[0] == store.key


@pytest.mark.skipif(sys.platform == "win32", reason="Windows no deja renombrar una base con una conexión abierta")
def test_restaurar_con_wal_pendiente_conserva_la_base_anterior_completa(data):
    store = MemoryStore()
    made = create_backup(data, store, at=NOW)
    live = connect(data / DB_NAME)
    live.execute("INSERT INTO scope (slug, name, created_at) VALUES ('wal', 'En el WAL', '2026-01-01T00:00:00Z')")
    aside = restore(data, made.path, store.key)
    live.close()
    import sqlite3

    old = sqlite3.connect(aside)
    assert "wal" in [r[0] for r in old.execute("SELECT slug FROM scope")], "lo que estaba en el WAL viaja con la base apartada"
    old.close()
    assert scopes(data) == ["personal", "prueba"]


def test_restaurar_con_wal_pendiente_sin_conexiones_abiertas(data, tmp_path):
    """As the CLI restores (the core stopped): a WAL left behind is folded into the database set aside."""
    store = MemoryStore()
    made = create_backup(data, store, at=NOW)
    live_dir = tmp_path / "live"
    live_dir.mkdir()
    shutil.copy2(data / DB_NAME, live_dir / DB_NAME)
    live = connect(live_dir / DB_NAME)
    live.execute("PRAGMA wal_autocheckpoint = 0")
    live.execute("INSERT INTO scope (slug, name, created_at) VALUES ('wal', 'En el WAL', '2026-01-01T00:00:00Z')")
    for name in (DB_NAME, f"{DB_NAME}-wal", f"{DB_NAME}-shm"):
        if (live_dir / name).exists():
            shutil.copy2(live_dir / name, data / name)
    live.close()
    aside = restore(data, made.path, store.key)
    import sqlite3

    old = sqlite3.connect(aside)
    assert "wal" in [r[0] for r in old.execute("SELECT slug FROM scope")], "lo que estaba en el WAL viaja con la base apartada"
    old.close()
    assert scopes(data) == ["personal", "prueba"]


def test_no_restaura_una_copia_de_una_version_mas_nueva(data, tmp_path):
    import sqlite3

    store = MemoryStore()
    made = create_backup(data, store, at=NOW)
    newer = tmp_path / "nueva.db"
    newer.write_bytes(decrypt(store.key, made.path.read_bytes()))
    conn = sqlite3.connect(newer)
    conn.execute("INSERT INTO schema_migrations VALUES (999, 'futura', 'x')")
    conn.commit()
    conn.close()
    from agora_core.backup import encrypt

    future = tmp_path / "futura.agb"
    future.write_bytes(encrypt(store.key, newer.read_bytes()))
    with pytest.raises(BackupError):
        restore(data, future, store.key)


def test_sin_temporales_y_limpieza_al_arrancar(data):
    from agora_core.backup import backups_dir, clean_leftovers

    create_backup(data, MemoryStore(), at=NOW)
    assert not [p for p in backups_dir(data).iterdir() if p.name.startswith(".")]
    (backups_dir(data) / ".snapshot-abc").write_bytes(b"restos")
    (data / ".restore-1.db").write_bytes(b"restos")
    clean_leftovers(data)
    assert not [p for p in backups_dir(data).iterdir() if p.name.startswith(".")]
    assert not (data / ".restore-1.db").exists()


def test_codigo_de_recuperacion_tolera_confusiones_tipicas(data):
    key, _ = ensure_key(MemoryStore(), data)
    code = recovery_code(key)
    assert key_from_recovery(code.replace("O", "0").replace("I", "1").replace("B", "8")) == key


def test_el_bloqueo_de_clave_espera_entre_procesos(tmp_path):
    import subprocess
    import time

    from agora_core.keystore import key_lock

    code = (
        "import sys, time; from pathlib import Path; from agora_core.keystore import key_lock\n"
        "with key_lock(Path(sys.argv[1])):\n"
        "    print('locked', flush=True)\n"
        "    time.sleep(0.4)\n"
    )
    child = subprocess.Popen([sys.executable, "-c", code, str(tmp_path)], stdout=subprocess.PIPE, text=True)
    assert child.stdout.readline().strip() == "locked"
    started = time.monotonic()
    with key_lock(tmp_path):
        elapsed = time.monotonic() - started
    child.wait(timeout=5)
    assert elapsed >= 0.25, "el segundo proceso espera hasta que el primero suelta el bloqueo"
