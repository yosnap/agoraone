"""SQLite database of the core: opening, private permissions and versioned migrations."""

import os
import re
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime
from importlib import resources
from pathlib import Path

DB_NAME = "agora.db"
_MIGRATION = re.compile(r"(\d{4})_([a-z0-9_]+)\.sql")


class MigrationError(RuntimeError):
    pass


def now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def private_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)
    return path


def connect(path: Path) -> sqlite3.Connection:
    """Opens the database with foreign keys and WAL; the file and its WAL siblings stay 0600."""
    private_dir(path.parent)
    previous = os.umask(0o077)
    try:
        connection = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        connection.execute("PRAGMA journal_mode = WAL")
    finally:
        os.umask(previous)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    path.chmod(0o600)
    return connection


def available_migrations() -> list[tuple[int, str, str]]:
    folder = resources.files("agora_core") / "migrations"
    found = []
    for entry in folder.iterdir():
        match = _MIGRATION.fullmatch(entry.name)
        if match:
            found.append((int(match[1]), match[2], entry.read_text(encoding="utf-8")))
    return sorted(found)


def applied_versions(connection: sqlite3.Connection) -> set[int]:
    connection.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
    )
    return {row[0] for row in connection.execute("SELECT version FROM schema_migrations")}


def has_user_tables(connection: sqlite3.Connection) -> bool:
    row = connection.execute(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT IN ('schema_migrations') AND name NOT LIKE 'sqlite_%'"
    ).fetchone()
    return row[0] > 0


def migrate(connection: sqlite3.Connection, backup_first: Callable[[], object] | None = None) -> list[int]:
    """Applies pending migrations, each in its own transaction. When the database already holds data, a
    backup is taken first; if that backup fails, nothing is migrated."""
    pending = [m for m in available_migrations() if m[0] not in applied_versions(connection)]
    if not pending:
        return []
    if backup_first and has_user_tables(connection):
        try:
            backup_first()
        except Exception as error:
            raise MigrationError("No se pudo hacer la copia previa; no se ha migrado la base de datos.") from error
    done = []
    for version, name, sql in pending:
        try:
            connection.execute("BEGIN IMMEDIATE")
            for statement in _statements(sql):
                connection.execute(statement)
            connection.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", (version, name, now())
            )
            connection.execute("COMMIT")
        except Exception as error:
            connection.execute("ROLLBACK")
            raise MigrationError(f"Falló la migración {version:04d}_{name}; la base queda como estaba.") from error
        done.append(version)
    return done


def _statements(sql: str) -> list[str]:
    """Splits a migration into statements, honouring quotes and comments (sqlite3.complete_statement)."""
    statements, current = [], ""
    for line in sql.splitlines(keepends=True):
        current += line
        if sqlite3.complete_statement(current):
            if current.strip():
                statements.append(current)
            current = ""
    if current.strip() and not current.strip().startswith("--"):
        raise MigrationError("Migración con una sentencia incompleta.")
    return statements
