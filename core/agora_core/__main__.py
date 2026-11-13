"""Arranque del núcleo: `uv run python -m agora_core`, lanzado por el backend de AgoraOne."""

import os
import socket
import sys
import threading
import time

import uvicorn

from .app import create_app
from .settings import SettingsError, load_settings


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((host, port))
        except OSError:
            return False
    return True


def _exit_with_parent() -> None:
    """Si el backend muere sin avisar, el núcleo termina solo en lugar de quedar huérfano."""
    parent = os.getppid()
    while True:
        time.sleep(2)
        if os.getppid() != parent:
            os._exit(0)


def main() -> int:
    try:
        settings = load_settings()
    except SettingsError as error:
        print(error, file=sys.stderr)
        return 2
    if not _port_free(settings.host, settings.port):
        print(
            f"El puerto {settings.port} está ocupado: ya hay un núcleo de AgoraOne en marcha u otro "
            "proceso lo usa. Detenlo antes de arrancar de nuevo.",
            file=sys.stderr,
        )
        return 3
    threading.Thread(target=_exit_with_parent, daemon=True).start()
    uvicorn.run(
        create_app(settings), host=settings.host, port=settings.port,
        log_level="warning", server_header=False, date_header=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
