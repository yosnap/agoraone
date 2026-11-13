"""Configuración del núcleo, leída del entorno que le pasa el backend de AgoraOne."""

import os
import re
from dataclasses import dataclass

HOST = "127.0.0.1"
PORT = 4318
SECRET_ENV = "AGORA_CORE_SECRET"
_SECRET = re.compile(r"[a-f0-9]{64}")


class SettingsError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    secret: str
    host: str = HOST
    port: int = PORT

    @property
    def authority(self) -> str:
        return f"{self.host}:{self.port}"


def load_settings(env: dict[str, str] | None = None) -> Settings:
    """El núcleo no arranca sin el secreto que genera el backend en cada arranque."""
    secret = (env if env is not None else os.environ).get(SECRET_ENV, "")
    if not _SECRET.fullmatch(secret):
        raise SettingsError(
            f"Falta {SECRET_ENV}: el núcleo solo se arranca desde AgoraOne (npm run dev o npm start)."
        )
    return Settings(secret=secret)
