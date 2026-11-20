"""Where the backup key lives: the macOS Keychain in real use, memory in tests.

The key is never created silently once backups exist (they would be encrypted with a key the user holds
no recovery code for), and creation is serialised across threads and processes so the core and the
terminal cannot each make a different one.
"""

import base64
import hashlib
import secrets
import sys
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Protocol
from . import system_words

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl

SERVICE = "AgoraOne"
ACCOUNT = "backup-key"
KEY_BYTES = 32
SHOWN_FLAG = "recovery-key-shown"
_LOCK = threading.Lock()
# Base32 has no 0, 1 or 8: read them as the letters they are usually mistaken for.
_LOOKALIKES = str.maketrans({"0": "O", "1": "I", "8": "B"})


class KeyStoreError(RuntimeError):
    pass


class KeyStore(Protocol):
    def get(self) -> bytes | None: ...
    def put(self, key: bytes) -> None: ...


class KeychainStore:
    """Through `keyring`, which talks to the Security framework: the key never appears in a command line."""

    def get(self) -> bytes | None:
        import keyring

        value = keyring.get_password(SERVICE, ACCOUNT)
        return bytes.fromhex(value) if value else None

    def put(self, key: bytes) -> None:
        import keyring

        keyring.set_password(SERVICE, ACCOUNT, key.hex())


class MemoryStore:
    def __init__(self, key: bytes | None = None):
        self.key = key

    def get(self) -> bytes | None:
        return self.key

    def put(self, key: bytes) -> None:
        self.key = key


@contextmanager
def key_lock(folder: Path):
    """One key operation at a time, in this process (thread lock) and across processes (file lock)."""
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    with _LOCK, open(folder / ".key.lock", "a+b") as handle:
        if sys.platform == "win32":
            handle.seek(0)
            for attempt in range(6):
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                    break
                except OSError as error:
                    if attempt == 5:
                        raise KeyStoreError("No se pudo bloquear el almacén de claves.") from error
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)


def _checked(key: bytes) -> bytes:
    if len(key) != KEY_BYTES:
        raise KeyStoreError(f"La clave de copias del {system_words.KEYSTORE} no es válida.")
    return key


def ensure_key(store: KeyStore, folder: Path, allow_create: bool = True) -> tuple[bytes, bool]:
    """The installation's key. Returns (key, created). Without a stored key it is created only when
    allowed; the caller forbids it once backups exist."""
    with key_lock(folder):
        key = store.get()
        if key is not None:
            return _checked(key), False
        if not allow_create:
            raise KeyStoreError(
                f"Falta la clave de las copias en el {system_words.KEYSTORE} y ya hay copias hechas con ella. No se crea otra: "
                "restaura con «restore --recovery» y tu clave de recuperación para recuperarla."
            )
        store.put(secrets.token_bytes(KEY_BYTES))
        stored = store.get()
        if stored is None:
            raise KeyStoreError(f"No se pudo guardar la clave de las copias en el {system_words.KEYSTORE}.")
        return _checked(stored), True


def adopt_key(store: KeyStore, folder: Path, key: bytes) -> bool:
    """After restoring with the recovery code: keep that key if the Keychain has none. Never replaces a
    different stored key, which would make the backups made with it unreadable. Returns True if saved."""
    with key_lock(folder):
        current = store.get()
        if current is None:
            store.put(_checked(key))
            return True
        return False


def fingerprint(key: bytes) -> str:
    """Identifies a key without revealing it, to know which one the user already copied."""
    return hashlib.sha256(b"agoraone-backup-key:" + key).hexdigest()[:16]


def mark_shown(folder: Path, key: bytes) -> None:
    flag = folder / SHOWN_FLAG
    flag.write_text(fingerprint(key) + "\n", encoding="utf-8")
    flag.chmod(0o600)


def recovery_pending(store: KeyStore, folder: Path) -> bool:
    """True when the stored key is not the one whose recovery code the user was shown."""
    key = store.get()
    if key is None:
        return False
    flag = folder / SHOWN_FLAG
    shown = flag.read_text(encoding="utf-8").strip() if flag.exists() else ""
    return shown != fingerprint(key)


def recovery_code(key: bytes) -> str:
    """The key in a form to copy to paper: base32 in groups of four, with a 2-byte checksum for typos."""
    raw = key + hashlib.sha256(key).digest()[:2]
    text = base64.b32encode(raw).decode().rstrip("=")
    return "-".join(text[i : i + 4] for i in range(0, len(text), 4))


def key_from_recovery(code: str) -> bytes:
    text = "".join(ch for ch in code.upper() if ch.isalnum()).translate(_LOOKALIKES)
    try:
        raw = base64.b32decode(text + "=" * (-len(text) % 8))
    except ValueError as error:
        raise KeyStoreError("La clave de recuperación no es válida.") from error
    key, check = raw[:KEY_BYTES], raw[KEY_BYTES:]
    if len(key) != KEY_BYTES or check != hashlib.sha256(key).digest()[:2]:
        raise KeyStoreError("La clave de recuperación no es válida: revisa que esté completa y sin erratas.")
    return key
