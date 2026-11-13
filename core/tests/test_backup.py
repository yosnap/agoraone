import stat
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
    typo = code[:-1] + ("A" if code[-1] != "A" else "B")
    with pytest.raises(KeyStoreError):
        key_from_recovery(typo)
    restore(data, made.path, key_from_recovery(code))
    assert scopes(data) == ["personal", "prueba"]


def test_la_clave_se_crea_una_vez(data):
    store = MemoryStore()
    key, created = ensure_key(store)
    assert created and len(key) == 32
    assert ensure_key(store) == (key, False)
    with pytest.raises(KeyStoreError):
        ensure_key(MemoryStore(b"corta"))


def test_retencion_diaria_semanal_y_previas(data):
    store = MemoryStore()
    for day in range(60):  # one backup per day, plus a second one on the most recent day
        create_backup(data, store, "daily", NOW - timedelta(days=day))
    create_backup(data, store, "manual", NOW - timedelta(hours=1))
    for n in range(7):
        create_backup(data, store, "premigration", NOW - timedelta(days=n, minutes=5))
    prune(data, NOW)
    kept = list_backups(data)
    regular = [b for b in kept if b.kind != "premigration"]
    assert len({b.created.date() for b in regular}) == len(regular), "una por día como mucho"
    assert all(NOW - b.created <= timedelta(weeks=8) for b in regular)
    recent_days = {b.created.date() for b in regular if NOW - b.created <= timedelta(days=14)}
    assert len(recent_days) == 15  # los 14 días más el de hoy, contando el límite
    assert len([b for b in kept if b.kind == "premigration"]) == 5


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
    key, _ = ensure_key(store)
    fake = tmp_path / "falsa.agb"
    fake.write_bytes(encrypt(key, b"esto no es sqlite" * 100))
    with pytest.raises(BackupError):
        restore(data, fake, key)
    assert scopes(data) == ["personal", "prueba"], "la base actual no se toca"
