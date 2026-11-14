"""Encrypted backups of the core's database: create, list, prune and restore.

Each file is an SQLite snapshot (backup API into memory, consistent while the core runs; the unencrypted
copy never touches the disk), compressed and encrypted with AES-256-GCM. The format is
MAGIC | nonce (12 bytes) | ciphertext+tag; the magic is authenticated too.
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

from .db import DB_NAME, available_migrations, connect, private_dir
from .keystore import KeyStore, ensure_key

MAGIC = b"AGB1"
KINDS = ("daily", "manual", "premigration")
DAILY_DAYS = 14
WEEKLY_WEEKS = 8
KEEP_APART = {"manual": 10, "premigration": 5}
# AES-GCM in one piece accepts up to 2 GiB; the database holds indexes and metadata, far below that.
MAX_BYTES = 2**31 - 1024
_NAME = re.compile(r"agora-(daily|manual|premigration)-(\d{8}T\d{6})(\d{6})?Z\.agb")
_LEFTOVER = re.compile(r"\.(tmp|snapshot)-.*")


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


def _stamp(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y%m%dT%H%M%S%fZ")


def list_backups(data_dir: Path) -> list[Backup]:
    folder = backups_dir(data_dir)
    if not folder.is_dir():
        return []
    found = []
    for path in folder.iterdir():
        match = _NAME.fullmatch(path.name)
        if match:
            created = datetime.strptime(match[2], "%Y%m%dT%H%M%S").replace(
                microsecond=int(match[3] or 0), tzinfo=UTC
            )
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
    packed = zlib.compress(plain, 6)
    if len(packed) > MAX_BYTES:
        raise BackupError("La base de datos supera el tamaño máximo de una copia (2 GiB).")
    nonce = os.urandom(12)
    return MAGIC + nonce + AESGCM(key).encrypt(nonce, packed, MAGIC)


def decrypt(key: bytes, blob: bytes) -> bytes:
    if not blob.startswith(MAGIC) or len(blob) < len(MAGIC) + 12 + 16:
        raise BackupError("No es una copia de AgoraOne.")
    nonce, body = blob[4:16], blob[16:]
    try:
        return zlib.decompress(AESGCM(key).decrypt(nonce, body, MAGIC))
    except (InvalidTag, zlib.error) as error:
        raise BackupError("No se puede abrir la copia: la clave no es la suya o el archivo está dañado.") from error


def snapshot(database: Path) -> bytes:
    """A consistent copy of the live database, built in memory."""
    if database.stat().st_size > MAX_BYTES:
        raise BackupError("La base de datos supera el tamaño máximo de una copia (2 GiB).")
    source = sqlite3.connect(database)
    target = sqlite3.connect(":memory:")
    try:
        source.backup(target)
        return target.serialize()
    finally:
        target.close()
        source.close()


def clean_leftovers(data_dir: Path) -> None:
    """Removes temporary files left by an interrupted backup or restore. Only at startup, when nothing
    else is writing (a running backup has its own temporary file)."""
    for folder in (data_dir, backups_dir(data_dir)):
        if folder.is_dir():
            for path in folder.iterdir():
                if _LEFTOVER.fullmatch(path.name) or path.name.startswith(".restore-"):
                    path.unlink(missing_ok=True)


def create_backup(data_dir: Path, store: KeyStore, kind: str = "manual", at: datetime | None = None) -> Backup:
    if kind not in KINDS:
        raise BackupError("Tipo de copia no válido.")
    database = data_dir / DB_NAME
    if not database.exists():
        raise BackupError("Todavía no hay base de datos que copiar.")
    # A new key only for the very first backup: later, a missing key means it was lost, not unused.
    key, _ = ensure_key(store, data_dir, allow_create=not list_backups(data_dir))
    folder = private_dir(backups_dir(data_dir))
    created = at or datetime.now(UTC)
    path = folder / f"agora-{kind}-{_stamp(created)}.agb"
    while path.exists():
        created += timedelta(microseconds=1)
        path = folder / f"agora-{kind}-{_stamp(created)}.agb"
    _write_private(path, encrypt(key, snapshot(database)))
    return Backup(path, kind, created)


def prune(data_dir: Path, now: datetime | None = None) -> list[Backup]:
    """Keeps the newest daily backup of each of the last 14 days and of each of the last 8 weeks, the
    last 10 manual ones and the last 5 taken before a migration. Backups dated in the future (a clock
    that went back) are kept. Returns what was deleted."""
    now = now or datetime.now(UTC)
    every = list_backups(data_dir)
    keep: set[Path] = {b.path for b in every if b.created > now}
    days: set = set()
    weeks: set = set()
    for backup in (b for b in every if b.kind == "daily" and b.created <= now):  # newest first
        age = now - backup.created
        day, week = backup.created.date(), backup.created.isocalendar()[:2]
        if age < timedelta(days=DAILY_DAYS) and day not in days:
            days.add(day)
            keep.add(backup.path)
        if age < timedelta(weeks=WEEKLY_WEEKS) and week not in weeks:
            weeks.add(week)
            keep.add(backup.path)
    for kind, count in KEEP_APART.items():
        keep.update(b.path for b in [b for b in every if b.kind == kind][:count])
    deleted = [b for b in every if b.path not in keep]
    for backup in deleted:
        backup.path.unlink(missing_ok=True)
    return deleted


def ensure_daily(data_dir: Path, store: KeyStore, now: datetime | None = None) -> Backup | None:
    """Takes the daily backup if the last one is older than 24 h, then prunes."""
    now = now or datetime.now(UTC)
    if not (data_dir / DB_NAME).exists():
        return None
    daily = [b for b in list_backups(data_dir) if b.kind == "daily" and b.created <= now]
    made = None
    if not daily or now - daily[0].created >= timedelta(hours=24):
        made = create_backup(data_dir, store, "daily", now)
    prune(data_dir, now)
    return made


def _check_restorable(candidate: Path) -> None:
    try:
        check = sqlite3.connect(candidate)
        try:
            if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise BackupError("La copia descifrada no es una base de datos íntegra.")
            newest = check.execute("SELECT max(version) FROM schema_migrations").fetchone()[0] or 0
        finally:
            check.close()
    except sqlite3.DatabaseError as error:
        raise BackupError("La copia descifrada no es una base de datos de AgoraOne.") from error
    if newest > max(m[0] for m in available_migrations()):
        raise BackupError("La copia es de una versión más nueva de AgoraOne; actualiza antes de restaurarla.")


def restore(data_dir: Path, backup: Path, key: bytes) -> Path | None:
    """Replaces the database with a backup, keeping the current one aside (returned, if there was one).
    The core must be stopped."""
    plain = decrypt(key, backup.read_bytes())
    database = data_dir / DB_NAME
    private_dir(data_dir)
    candidate = data_dir / f".restore-{os.getpid()}.db"
    _write_private(candidate, plain)
    try:
        _check_restorable(candidate)
    except BackupError:
        candidate.unlink(missing_ok=True)
        raise
    aside = None
    if database.exists():
        aside = data_dir / f"{DB_NAME}.before-restore-{_stamp(datetime.now(UTC))}"
        # Fold the WAL into the database first, so what is set aside is one complete file.
        current = sqlite3.connect(database)
        try:
            current.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            current.close()
        os.replace(database, aside)
    for suffix in ("-wal", "-shm"):
        Path(f"{database}{suffix}").unlink(missing_ok=True)
    os.replace(candidate, database)
    connect(database).close()
    return aside
