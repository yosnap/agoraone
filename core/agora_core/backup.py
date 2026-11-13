"""Encrypted backups of the core's database: create, list, prune and restore.

Each file is an SQLite snapshot (backup API, consistent while the core runs), compressed and encrypted
with AES-256-GCM. The format is MAGIC | nonce (12 bytes) | ciphertext+tag; the magic is authenticated too.
"""

import os
import re
import sqlite3
import tempfile
import zlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .db import DB_NAME, connect, private_dir
from .keystore import KeyStore, ensure_key

MAGIC = b"AGB1"
KINDS = ("daily", "manual", "premigration")
DAILY_DAYS = 14
WEEKLY_WEEKS = 8
PREMIGRATION_KEEP = 5
_NAME = re.compile(r"agora-(daily|manual|premigration)-(\d{8}T\d{6}Z)\.agb")


class BackupError(RuntimeError):
    pass


@dataclass(frozen=True)
class Backup:
    path: Path
    kind: str
    created: datetime

    @property
    def name(self) -> str:
        return self.path.name


def backups_dir(data_dir: Path) -> Path:
    return data_dir / "backups"


def list_backups(data_dir: Path) -> list[Backup]:
    folder = backups_dir(data_dir)
    if not folder.is_dir():
        return []
    found = []
    for path in folder.iterdir():
        match = _NAME.fullmatch(path.name)
        if match:
            created = datetime.strptime(match[2], "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
            found.append(Backup(path, match[1], created))
    return sorted(found, key=lambda b: b.created, reverse=True)


def _write_private(path: Path, data: bytes) -> None:
    """Atomic write with mode 0600: a temporary file in the same folder, then rename."""
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def encrypt(key: bytes, plain: bytes) -> bytes:
    nonce = os.urandom(12)
    return MAGIC + nonce + AESGCM(key).encrypt(nonce, zlib.compress(plain, 6), MAGIC)


def decrypt(key: bytes, blob: bytes) -> bytes:
    if not blob.startswith(MAGIC) or len(blob) < len(MAGIC) + 12 + 16:
        raise BackupError("No es una copia de AgoraOne.")
    nonce, body = blob[4:16], blob[16:]
    try:
        return zlib.decompress(AESGCM(key).decrypt(nonce, body, MAGIC))
    except (InvalidTag, zlib.error) as error:
        raise BackupError("No se puede abrir la copia: la clave no es la suya o el archivo está dañado.") from error


def snapshot(database: Path) -> bytes:
    """A consistent copy of the live database through SQLite's backup API."""
    folder = private_dir(database.parent / "backups")
    descriptor, temporary = tempfile.mkstemp(dir=folder, prefix=".snapshot-")
    os.close(descriptor)
    try:
        source = sqlite3.connect(database)
        target = sqlite3.connect(temporary)
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()
        return Path(temporary).read_bytes()
    finally:
        Path(temporary).unlink(missing_ok=True)


def create_backup(data_dir: Path, store: KeyStore, kind: str = "manual", at: datetime | None = None) -> Backup:
    if kind not in KINDS:
        raise BackupError("Tipo de copia no válido.")
    database = data_dir / DB_NAME
    if not database.exists():
        raise BackupError("Todavía no hay base de datos que copiar.")
    key, _ = ensure_key(store)
    created = (at or datetime.now(UTC)).replace(microsecond=0)
    folder = private_dir(backups_dir(data_dir))
    path = folder / f"agora-{kind}-{created.strftime('%Y%m%dT%H%M%SZ')}.agb"
    _write_private(path, encrypt(key, snapshot(database)))
    return Backup(path, kind, created)


def prune(data_dir: Path, now: datetime | None = None) -> list[Backup]:
    """Keeps the newest regular backup of each of the last 14 days and of each of the last 8 weeks, and the
    last 5 taken before a migration. Returns what was deleted."""
    now = now or datetime.now(UTC)
    regular = [b for b in list_backups(data_dir) if b.kind != "premigration"]
    keep: set[Path] = set()
    days: set = set()
    weeks: set = set()
    for backup in regular:  # newest first
        day = backup.created.date()
        week = backup.created.isocalendar()[:2]
        if now - backup.created <= timedelta(days=DAILY_DAYS) and day not in days:
            days.add(day)
            keep.add(backup.path)
        if now - backup.created <= timedelta(weeks=WEEKLY_WEEKS) and week not in weeks:
            weeks.add(week)
            keep.add(backup.path)
    premigration = [b for b in list_backups(data_dir) if b.kind == "premigration"]
    keep.update(b.path for b in premigration[:PREMIGRATION_KEEP])
    deleted = [b for b in regular + premigration if b.path not in keep]
    for backup in deleted:
        backup.path.unlink(missing_ok=True)
    return deleted


def ensure_daily(data_dir: Path, store: KeyStore, now: datetime | None = None) -> Backup | None:
    """Takes the daily backup if the last regular one is older than 24 h, then prunes."""
    now = now or datetime.now(UTC)
    if not (data_dir / DB_NAME).exists():
        return None
    regular = [b for b in list_backups(data_dir) if b.kind != "premigration"]
    made = None
    if not regular or now - regular[0].created >= timedelta(hours=24):
        made = create_backup(data_dir, store, "daily", now)
    prune(data_dir, now)
    return made


def restore(data_dir: Path, backup: Path, key: bytes) -> Path:
    """Replaces the database with a backup, keeping the current one aside. The core must be stopped."""
    plain = decrypt(key, backup.read_bytes())
    database = data_dir / DB_NAME
    private_dir(data_dir)
    candidate = data_dir / f".restore-{os.getpid()}.db"
    _write_private(candidate, plain)
    try:
        check = sqlite3.connect(candidate)
        try:
            if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise BackupError("La copia descifrada no es una base de datos íntegra.")
        finally:
            check.close()
    except sqlite3.DatabaseError as error:
        candidate.unlink(missing_ok=True)
        raise BackupError("La copia descifrada no es una base de datos válida.") from error
    except BackupError:
        candidate.unlink(missing_ok=True)
        raise
    aside = data_dir / f"{DB_NAME}.before-restore-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
    if database.exists():
        os.replace(database, aside)
        for suffix in ("-wal", "-shm"):
            sidecar = Path(f"{database}{suffix}")
            if sidecar.exists():
                os.replace(sidecar, Path(f"{aside}{suffix}"))
    os.replace(candidate, database)
    connect(database).close()
    return aside
