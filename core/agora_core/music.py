"""The music the computer is playing, behind one interface with an adapter per system:
- macOS: Apple Music and Spotify through AppleScript (`osascript`), the permission «Automatización» asked by
  macOS the first time;
- Linux: any MPRIS player (Spotify, Rhythmbox, the browser…) through `playerctl`;
- Windows: not yet.
Reading what plays never opens a player: only those already running are asked. Commands come from a closed
list, and what to play («pon …») is passed as an argument, never written into a script."""

import shutil
import subprocess
import sys

PLAYERS = {"music": {"name": "Apple Music", "process": "Music", "app": "Music"},
           "spotify": {"name": "Spotify", "process": "Spotify", "app": "Spotify"}}
ACTIONS = {"toggle", "play", "pause", "next", "previous", "louder", "quieter"}
TIMEOUT = 8


class MusicError(RuntimeError):
    pass


def _osascript(script: str, *args: str) -> str:
    try:
        done = subprocess.run(["/usr/bin/osascript", "-e", script, *args], capture_output=True, text=True, timeout=TIMEOUT, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise MusicError("El reproductor no responde.") from error
    if done.returncode != 0:
        if "-1743" in done.stderr or "not allowed" in done.stderr.lower():
            raise MusicError("macOS no deja a AgoraOne controlar la música: dale permiso en Ajustes del Sistema › Privacidad y seguridad › Automatización.")
        raise MusicError("El reproductor no pudo hacerlo.")
    return done.stdout.strip()


def _running(process: str) -> bool:
    try:
        return subprocess.run(["/usr/bin/pgrep", "-x", process], capture_output=True, timeout=3, check=False).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


# --- macOS ---------------------------------------------------------------------------------------------------
NOW_PLAYING = '''tell application "{app}"
  set s to player state as text
  if s is "stopped" then return s
  set t to current track
  set d to duration of t
  return s & tab & (name of t) & tab & (artist of t) & tab & (album of t) & tab & d & tab & (player position) & tab & (sound volume)
end tell'''
COMMANDS = {"toggle": "playpause", "play": "play", "pause": "pause", "next": "next track", "previous": "previous track",
            "louder": "set sound volume to (sound volume + 10)", "quieter": "set sound volume to (sound volume - 10)"}
SEARCH_MUSIC = '''on run argv
  tell application "Music"
    set found to (search playlist "Library" for (item 1 of argv))
    if found is {} then return "none"
    play item 1 of found
    return "ok"
  end tell
end run'''
SEARCH_SPOTIFY = '''on run argv
  tell application "Spotify" to open location ("spotify:search:" & (item 1 of argv))
  return "opened"
end run'''


def _number(text: str) -> float | None:
    try:
        return float(text.replace(",", "."))
    except ValueError:
        return None


def _mac_status() -> list[dict]:
    found = []
    for key, player in PLAYERS.items():
        if not _running(player["process"]):
            continue
        try:
            fields = _osascript(NOW_PLAYING.format(app=player["app"])).split("\t")
        except MusicError as error:
            found.append({"player": key, "name": player["name"], "state": "error", "problem": str(error)})
            continue
        entry = {"player": key, "name": player["name"], "state": fields[0]}
        if len(fields) >= 7:
            duration = _number(fields[4])
            if key == "spotify" and duration:
                duration /= 1000  # Spotify gives milliseconds
            entry.update({"title": fields[1], "artist": fields[2], "album": fields[3], "duration": duration,
                          "position": _number(fields[5]), "volume": _number(fields[6])})
        found.append(entry)
    return found


# --- Linux ---------------------------------------------------------------------------------------------------
def _playerctl(*args: str) -> str:
    try:
        done = subprocess.run(["playerctl", *args], capture_output=True, text=True, timeout=TIMEOUT, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise MusicError("El reproductor no responde.") from error
    if done.returncode != 0:
        raise MusicError("El reproductor no pudo hacerlo.")
    return done.stdout.strip()


def _linux_status() -> list[dict]:
    found = []
    for name in _playerctl("-l").splitlines()[:6]:
        try:
            fields = _playerctl("-p", name, "metadata", "--format", "{{status}}\t{{title}}\t{{artist}}\t{{album}}\t{{mpris:length}}\t{{position}}").split("\t")
        except MusicError:
            continue
        length, position = (_number(fields[4]) if len(fields) > 4 else None), (_number(fields[5]) if len(fields) > 5 else None)
        found.append({"player": name, "name": name.split(".")[0].capitalize(), "state": fields[0].lower(), "title": fields[1] if len(fields) > 1 else None,
                      "artist": fields[2] if len(fields) > 2 else None, "album": fields[3] if len(fields) > 3 else None,
                      "duration": length / 1e6 if length else None, "position": position / 1e6 if position else None, "volume": None})
    return found


# --- the interface -------------------------------------------------------------------------------------------
def available() -> dict:
    if sys.platform == "darwin":
        return {"adapter": "macos", "note": None}
    if sys.platform.startswith("linux") and shutil.which("playerctl"):
        return {"adapter": "linux", "note": None}
    if sys.platform.startswith("linux"):
        return {"adapter": None, "note": "Para controlar la música en Linux hace falta playerctl (MPRIS)."}
    return {"adapter": None, "note": "En este sistema todavía no se controla la música."}


def status() -> dict:
    """The players open now and what each plays; the one playing first."""
    where = available()
    if not where["adapter"]:
        return {"players": [], "note": where["note"]}
    try:
        players = _mac_status() if where["adapter"] == "macos" else _linux_status()
    except MusicError as error:
        return {"players": [], "note": str(error)}
    players.sort(key=lambda p: (p["state"] != "playing", p["state"] != "paused"))
    return {"players": players, "note": None if players else "No hay ningún reproductor abierto (Música o Spotify)."}


def control(player: str, action: str) -> None:
    if action not in ACTIONS:
        raise MusicError("Acción no admitida.")
    where = available()["adapter"]
    if where == "macos":
        if player not in PLAYERS or not _running(PLAYERS[player]["process"]):
            raise MusicError("Ese reproductor no está abierto.")
        _osascript(f'tell application "{PLAYERS[player]["app"]}" to {COMMANDS[action]}')
    elif where == "linux":
        if player not in _playerctl("-l").splitlines():
            raise MusicError("Ese reproductor no está abierto.")
        linux = {"toggle": "play-pause", "play": "play", "pause": "pause", "next": "next", "previous": "previous", "louder": "volume", "quieter": "volume"}[action]
        _playerctl("-p", player, *([linux, "0.1+" if action == "louder" else "0.1-"] if linux == "volume" else [linux]))
    else:
        raise MusicError(available()["note"] or "No disponible.")


def play(player: str, query: str) -> str:
    """«Pon …»: Apple Music plays the first match in the user's library; Spotify opens its search with it.
    What it did, in words for the screen."""
    query = " ".join((query or "").split())[:120]
    if not query:
        raise MusicError("Di qué quieres escuchar.")
    if available()["adapter"] != "macos" or player not in PLAYERS:
        raise MusicError("Pedir una canción por su nombre solo funciona de momento con Música y Spotify en macOS.")
    if player == "music":
        result = _osascript(SEARCH_MUSIC, query)
        if result == "none":
            raise MusicError(f"No encuentro «{query}» en tu biblioteca de Música.")
        return f"Reproduciendo «{query}» en Música."
    _osascript(SEARCH_SPOTIFY, query)
    return f"Abierta la búsqueda de «{query}» en Spotify: elige qué poner."
