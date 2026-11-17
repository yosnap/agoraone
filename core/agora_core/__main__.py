"""Arranque del núcleo: `uv run python -m agora_core`, lanzado por el backend de AgoraOne."""

import os
import socket
import sys
import threading
import time

import uvicorn

from .app import create_app
from .engines import scrub_api_keys
from .settings import SettingsError, load_settings


BACKEND_PID_ENV = "AGORA_BACKEND_PID"


def port_free(host: str, port: int) -> bool:
    """Igual que uvicorn (SO_REUSEADDR): las conexiones en TIME_WAIT de un arranque anterior no cuentan."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, port))
        except OSError:
            return False
    return True


def alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5
        try:
            code = ctypes.c_ulong()
            return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(code)) and code.value == 259)
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def backend_pid(env: dict[str, str]) -> int:
    """El backend se identifica por su PID: entre ambos está `uv run`, así que el padre directo no sirve."""
    value = env.get(BACKEND_PID_ENV, "")
    return int(value) if value.isdigit() else os.getppid()


def _exit_with_backend(pid: int) -> None:
    """Si el backend muere sin avisar, el núcleo termina solo en lugar de quedar huérfano."""
    while alive(pid):
        time.sleep(2)
    os._exit(0)


def main() -> int:
    try:
        settings = load_settings()
    except SettingsError as error:
        print(error, file=sys.stderr)
        return 2
    if not port_free(settings.host, settings.port):
        print(
            f"El puerto {settings.port} está ocupado: ya hay un núcleo de AgoraOne en marcha u otro "
            "proceso lo usa. Detenlo antes de arrancar de nuevo.",
            file=sys.stderr,
        )
        return 3
    scrub_api_keys()
    threading.Thread(target=_exit_with_backend, args=(backend_pid(dict(os.environ)),), daemon=True).start()
    uvicorn.run(
        create_app(settings), host=settings.host, port=settings.port,
        log_level="warning", server_header=False, date_header=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
