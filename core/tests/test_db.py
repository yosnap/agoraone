import sqlite3
import stat

import pytest

from agora_core import db
from agora_core.db import DB_NAME, MigrationError, connect, migrate


def test_esquema_inicial_y_datos_genericos(tmp_path):
    database = connect(tmp_path / "data" / DB_NAME)
    assert migrate(database) == [m[0] for m in db.available_migrations()]
    assert migrate(database) == [], "una migración aplicada no se repite"
    assert [r[0] for r in database.execute("SELECT slug FROM scope")] == ["personal"]
    assert database.execute("SELECT count(*) FROM kind").fetchone()[0] == 6
    tables = {r[0] for r in database.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"scope", "kind", "project", "activity", "item", "event", "action_log", "agent", "schema_migrations"} <= tables


def test_permisos_privados(tmp_path):
    folder = tmp_path / "data"
    connect(folder / DB_NAME).close()
    assert stat.S_IMODE(folder.stat().st_mode) == 0o700
    assert stat.S_IMODE((folder / DB_NAME).stat().st_mode) == 0o600


def test_restricciones(tmp_path):
    database = connect(tmp_path / DB_NAME)
    migrate(database)
    stamp = db.now()
    insert = "INSERT INTO item (class, source, ref, confidentiality, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    with pytest.raises(sqlite3.IntegrityError):
        database.execute(insert, ("note", "vault", "a", "secreto", stamp, stamp))
    database.execute(insert, ("note", "vault", "a", "private", stamp, stamp))
    with pytest.raises(sqlite3.IntegrityError):
        database.execute(insert, ("note", "vault", "a", "normal", stamp, stamp))
    with pytest.raises(sqlite3.IntegrityError):
        database.execute("INSERT INTO project (name, scope_id, created_at, updated_at) VALUES ('x', 999, ?, ?)", (stamp, stamp))
    with pytest.raises(sqlite3.IntegrityError):
        database.execute("INSERT INTO agent (name, class, created_at, updated_at) VALUES ('h', 'hermes', ?, ?)", (stamp, stamp))
    with pytest.raises(sqlite3.IntegrityError):
        database.execute("INSERT INTO action_log (occurred_at, actor, action, outcome, detail) VALUES (?, 'w', 'x', 'done', 'no json')", (stamp,))


def _with_extra_migration(monkeypatch, sql):
    original = db.available_migrations()
    monkeypatch.setattr(db, "available_migrations", lambda: original + [(999, "extra", sql)])


def test_migracion_pendiente_hace_copia_previa(tmp_path, monkeypatch):
    database = connect(tmp_path / DB_NAME)
    migrate(database)
    _with_extra_migration(monkeypatch, "CREATE TABLE extra (id INTEGER PRIMARY KEY);")
    calls = []
    assert migrate(database, backup_first=lambda: calls.append("copia")) == [999]
    assert calls == ["copia"]


def test_sin_copia_no_se_migra(tmp_path, monkeypatch):
    database = connect(tmp_path / DB_NAME)
    migrate(database)
    _with_extra_migration(monkeypatch, "CREATE TABLE extra (id INTEGER PRIMARY KEY);")

    def failing():
        raise OSError("disco lleno")

    with pytest.raises(MigrationError):
        migrate(database, backup_first=failing)
    assert database.execute("SELECT count(*) FROM sqlite_master WHERE name = 'extra'").fetchone()[0] == 0


def test_migracion_fallida_se_deshace_entera(tmp_path, monkeypatch):
    database = connect(tmp_path / DB_NAME)
    migrate(database)
    _with_extra_migration(monkeypatch, "CREATE TABLE extra (id INTEGER PRIMARY KEY);\nINSERT INTO nada VALUES (1);")
    with pytest.raises(MigrationError):
        migrate(database)
    assert database.execute("SELECT count(*) FROM sqlite_master WHERE name = 'extra'").fetchone()[0] == 0
    assert 999 not in db.applied_versions(database)


def test_division_de_sentencias(monkeypatch):
    sql = "-- comentario\nCREATE TABLE a (x TEXT DEFAULT ';');\n-- otro\nINSERT INTO a VALUES ('b;c');\n"
    assert len(db._statements(sql)) == 2
    with pytest.raises(MigrationError):
        db._statements("CREATE TABLE a (x INTEGER);\n-- nota\nINSERT INTO a VALUES (1)")
