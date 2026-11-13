"""Where the backup key lives: the macOS Keychain in real use, memory in tests."""

import base64
import hashlib
import secrets
from typing import Protocol

SERVICE = "AgoraOne"
ACCOUNT = "backup-key"
KEY_BYTES = 32


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


def ensure_key(store: KeyStore) -> tuple[bytes, bool]:
    """The installation's key, created the first time. Returns (key, created)."""
    key = store.get()
    if key is not None:
        if len(key) != KEY_BYTES:
            raise KeyStoreError("La clave de copias del Llavero no es válida.")
        return key, False
    key = secrets.token_bytes(KEY_BYTES)
    store.put(key)
    return key, True


def recovery_code(key: bytes) -> str:
    """The key in a form to copy to paper: base32 in groups of four, with a 2-byte checksum for typos."""
    raw = key + hashlib.sha256(key).digest()[:2]
    text = base64.b32encode(raw).decode().rstrip("=")
    return "-".join(text[i : i + 4] for i in range(0, len(text), 4))


def key_from_recovery(code: str) -> bytes:
    text = "".join(ch for ch in code.upper() if ch.isalnum())
    try:
        raw = base64.b32decode(text + "=" * (-len(text) % 8))
    except ValueError as error:
        raise KeyStoreError("La clave de recuperación no es válida.") from error
    key, check = raw[:KEY_BYTES], raw[KEY_BYTES:]
    if len(key) != KEY_BYTES or check != hashlib.sha256(key).digest()[:2]:
        raise KeyStoreError("La clave de recuperación no es válida: revisa que esté completa y sin erratas.")
    return key
