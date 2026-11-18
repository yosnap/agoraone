"""«Arrancar la fábrica» (the user's decision, 18/11/2026): the only add-on AgoraOne starts, and only on macOS, by
asking launchd to start the service the fábrica installed for itself (`fabrica servicio instalar`). It is
`launchctl kickstart` without `-k`: it starts the service when it is not running and does nothing when it is. AgoraOne
never stops it, never installs, enables or changes it, and runs nothing of the fábrica itself."""

import os
import subprocess
import sys

LABEL = "com.sn4p.fabrica"
LAUNCHCTL = "/bin/launchctl"
TIMEOUT = 10
# launchctl's answer when launchd does not know the service («Could not find service»).
NOT_FOUND = 113


class StartError(RuntimeError):
    """`kind`: `unsupported` (not macOS), `not_installed` (launchd does not know the service) or `error`."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


def supported() -> bool:
    return sys.platform == "darwin"


def start() -> None:
    if not supported():
        raise StartError("unsupported", "AgoraOne solo arranca la fábrica en macOS: arráncala con `fabrica servir`.")
    try:
        done = subprocess.run([LAUNCHCTL, "kickstart", f"gui/{os.getuid()}/{LABEL}"], capture_output=True, timeout=TIMEOUT, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise StartError("error", "No se pudo pedir a macOS que arranque la fábrica.") from error
    if done.returncode == NOT_FOUND:
        raise StartError("not_installed", "Su servicio no está instalado: ejecuta `fabrica servicio instalar` en la carpeta de la fábrica.")
    if done.returncode != 0:
        raise StartError("error", "macOS no pudo arrancar el servicio de la fábrica (quizá está desactivado): arráncala en la terminal con `fabrica servir`.")
