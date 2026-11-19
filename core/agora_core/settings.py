"""Configuración del núcleo, leída del entorno que le pasa el backend de AgoraOne."""

import os
import re
from dataclasses import dataclass
from pathlib import Path

HOST = "127.0.0.1"
PORT = 4318
# AgoraOne's server (agora_server::PORT in desktop/server/src/lib.rs; a test there checks both say the same).
SERVER_PORT = 4317
SECRET_ENV = "AGORA_CORE_SECRET"
DATA_ENV = "AGORA_CORE_DATA"
_SECRET = re.compile(r"[a-f0-9]{64}")
# core/agora_core/settings.py → repository root → .agora/core
DEFAULT_DATA = Path(__file__).resolve().parents[2] / ".agora" / "core"


class SettingsError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    secret: str
    data_dir: Path = DEFAULT_DATA
    host: str = HOST
    port: int = PORT
    server_port: int = SERVER_PORT

    @property
    def authority(self) -> str:
        return f"{self.host}:{self.port}"


def data_dir(env: dict[str, str] | None = None) -> Path:
    value = (env if env is not None else os.environ).get(DATA_ENV, "")
    if value and not Path(value).is_absolute():
        raise SettingsError(f"{DATA_ENV} debe ser una ruta absoluta.")
    return Path(value) if value else DEFAULT_DATA


def load_settings(env: dict[str, str] | None = None) -> Settings:
    """El núcleo no arranca sin el secreto que genera el backend en cada arranque."""
    source = env if env is not None else dict(os.environ)
    secret = source.get(SECRET_ENV, "")
    if not _SECRET.fullmatch(secret):
        raise SettingsError(
            f"Falta {SECRET_ENV}: el núcleo solo se arranca desde AgoraOne (pnpm dev o pnpm start)."
        )
    return Settings(secret=secret, data_dir=data_dir(source))
