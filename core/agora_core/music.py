"""The music the computer is playing, behind one interface with an adapter per system:
- macOS: Apple Music and Spotify through AppleScript (`osascript`), the permission «Automatización» asked by
  macOS the first time;
- Linux: any MPRIS player (Spotify, Rhythmbox, the browser…) through `playerctl`;
- Windows: not yet.
Reading what plays never opens a player: only those already running are asked. Commands come from a closed
list, and what to play («pon …») is passed as an argument, never written into a script."""

import shutil
import subprocess
import time
import sys
from pathlib import Path

from . import music_cover

PLAYERS = {"music": {"name": "Apple Music", "process": "Music", "app": "Music", "bundle": "com.apple.Music"},
           "spotify": {"name": "Spotify", "process": "Spotify", "app": "Spotify", "bundle": "com.spotify.client"}}
ACTIONS = {"toggle", "play", "pause", "next", "previous", "louder", "quieter"}
TIMEOUT = 8


class MusicError(RuntimeError):
    """`reason` says why when it matters to the screen: «missing» (the song or the player is not there) or «silent»
    (the player did not answer in time), so «pon …» may try YouTube; any other failure (a permission) is told as it is."""

    def __init__(self, message: str, reason: str | None = None):
        super().__init__(message)
        self.reason = reason


def _which(script: str) -> str:
    """The script's first meaningful line, for the log: never its arguments (what the user asked to play)."""
    return next((line.strip() for line in script.splitlines() if line.strip() and not line.strip().startswith("on run")), "")[:80]


def _osascript(script: str, *args: str, timeout: float = TIMEOUT) -> str:
    started = time.perf_counter()  # not monotonic(): the «pon …» budget is measured with that one
    try:
        done = subprocess.run(["/usr/bin/osascript", "-e", script, *args], capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"AgoraOne núcleo: música sin respuesta en {time.perf_counter() - started:.1f} s ({type(error).__name__}): {_which(script)}", file=sys.stderr)
        raise MusicError("El reproductor no responde.", "silent") from error
    if done.returncode != 0:
        print(f"AgoraOne núcleo: música falló ({done.stderr.strip()[-160:]}): {_which(script)}", file=sys.stderr)
        if "-1743" in done.stderr or "not allowed" in done.stderr.lower():
            raise MusicError("macOS no deja a AgoraOne controlar la música: dale permiso en Ajustes del Sistema › Privacidad y seguridad › Automatización.")
        raise MusicError("El reproductor no pudo hacerlo.")
    return done.stdout.strip()


def _running(process: str) -> bool:
    try:
        return subprocess.run(["/usr/bin/pgrep", "-x", process], capture_output=True, timeout=3, check=False).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _installed(player: str) -> bool:
    """Whether the player is on this Mac (asking AppleScript for a missing app would open «Where is…?»): the
    Applications folders first, then Spotlight, never counting a copy in the Bin or on another volume. When Spotlight
    cannot answer, the player is not blocked."""
    if player == "music" or _running(PLAYERS[player]["process"]):
        return True  # Music is part of macOS
    app = f"{PLAYERS[player]['app']}.app"
    if any(folder.joinpath(app).is_dir() for folder in (Path("/Applications"), Path.home() / "Applications")):
        return True
    try:
        found = subprocess.run(["/usr/bin/mdfind", f"kMDItemCFBundleIdentifier == '{PLAYERS[player]['bundle']}'"],
                               capture_output=True, text=True, timeout=3, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return True
    if found.returncode != 0:
        return True
    return any(line and "/.Trash/" not in line and not line.startswith("/Volumes/") for line in found.stdout.splitlines())


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
    set found to (search library playlist 1 for (item 1 of argv))  -- by position: its name depends on the language («Biblioteca»)
    if found is {} then return "none"
    play item 1 of found
    return "ok"
  end tell
end run'''
# A song of the Apple Music catalogue opens in Music, its window brought to the front. Since macOS 27 Music shows the
# song marked in its album but no longer queues it for AppleScript («play» resumes whatever played last), so the user
# double-clicks it there: one gesture, never another song by mistake (user's decision, 20/11/2026).
OPEN_IN_MUSIC = '''on run argv
  tell application "Music"
    reopen
    activate
    open location (item 1 of argv)
  end tell
  return "opened"
end run'''
# The whole «pon …» in Music (library, then catalogue) answers within this many seconds: Watson waits for it.
BUDGET = 20.0
CATALOG = "https://itunes.apple.com/search"


def catalog_song(query: str, fetch=None, timeout: float = 5) -> dict | None:
    """The first song of the public Apple Music catalogue for these words (only the words go to Apple): its name,
    artist and the album address that opens it in Music. None when there is nothing or no answer."""
    import httpx

    try:
        answer = (fetch or httpx.get)(CATALOG, params={"term": query, "entity": "song", "country": "es", "limit": 5}, timeout=timeout)
        results = answer.json().get("results", []) if answer.status_code == 200 else []
    except Exception:  # noqa: BLE001 - an outside service: no answer is «not found»
        return None
    for item in results:
        if isinstance(item, dict) and item.get("trackName") and isinstance(item.get("collectionId"), int) and isinstance(item.get("trackId"), int):
            return {"name": str(item["trackName"])[:200], "artist": str(item.get("artistName") or "")[:120],
                    "url": f"music://music.apple.com/es/album/{item['collectionId']}?i={item['trackId']}"}
    return None


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
        raise MusicError("El reproductor no responde.", "silent") from error
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


def _player_open(player: str) -> str:
    where = available()["adapter"]
    if where == "macos" and (player not in PLAYERS or not _running(PLAYERS[player]["process"])):
        raise MusicError("Ese reproductor no está abierto.")
    if where == "linux" and player not in _playerctl("-l").splitlines():
        raise MusicError("Ese reproductor no está abierto.")
    if not where:
        raise MusicError(available()["note"] or "No disponible.")
    return where


def set_level(player: str, what: str, value: float) -> None:
    """The volume (0-100) or the point of the song (seconds) the user drags to, in Apple Music, Spotify or MPRIS."""
    if what not in ("volume", "seek") or not isinstance(value, (int, float)) or value != value or value < 0:
        raise MusicError("Valor no admitido.")
    where = _player_open(player)
    if where == "macos":
        command = f"set sound volume to {round(min(value, 100))}" if what == "volume" else f"set player position to {min(value, 86400):.1f}"
        _osascript(f'tell application "{PLAYERS[player]["app"]}" to {command}')
    elif what == "volume":
        _playerctl("-p", player, "volume", f"{min(value, 100) / 100:.2f}")
    else:
        _playerctl("-p", player, "position", f"{min(value, 86400):.1f}")


ARTWORK_MUSIC = '''on run argv
  tell application "Music"
    if player state is stopped then return "none"
    if (count of artworks of current track) is 0 then return "none"
    set a to artwork 1 of current track
    set d to raw data of a
    set f to format of a as text
  end tell
  set fh to open for access (POSIX file (item 1 of argv)) with write permission
  set eof fh to 0
  write d to fh
  close access fh
  return f
end run'''
ARTWORK_SPOTIFY = 'tell application "Spotify" to if player state is not stopped then return artwork url of current track'
_covers: dict[str, tuple[bytes, str] | None] = {}


def cover(player: str, key: str) -> tuple[bytes, str] | None:
    """The cover of what Apple Music or Spotify plays now (`key` names the track, so each one is read once):
    Apple Music's own artwork, or the image Spotify gives for the track (only from its image server)."""
    if available()["adapter"] != "macos" or player not in PLAYERS or not _running(PLAYERS[player]["process"]):
        return None
    cached = f"{player}|{key}"
    if cached in _covers:
        return _covers[cached]
    found = None
    if player == "music":
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "cover"
            kind = _osascript(ARTWORK_MUSIC, str(target))
            if kind != "none" and target.is_file() and target.stat().st_size < 8_000_000:
                found = music_cover._image(target.read_bytes())
    else:
        import httpx
        url = _osascript(ARTWORK_SPOTIFY)
        if url.startswith("https://i.scdn.co/image/"):
            try:
                answer = httpx.get(url, timeout=8, follow_redirects=False)
            except httpx.HTTPError:
                return None  # a passing failure: not remembered, the next look tries again
            if answer.status_code == 200:
                found = music_cover._image(answer.content)  # only a real JPEG or PNG, whatever the server says
    if len(_covers) > 40:
        _covers.clear()
    _covers[cached] = found
    return found


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
    if not _installed(player):
        raise MusicError(f"{PLAYERS[player]['name']} no está instalado en este Mac. Prueba con YouTube.", "missing")
    if player == "music":
        return _play_music(query)
    _osascript(SEARCH_SPOTIFY, query)
    return f"Abierta la búsqueda de «{query}» en Spotify: elige qué poner."


def _pause_music() -> None:
    """Best effort: Music handles Apple events one after another, so this pause lands after a «play» still on its
    way and Music does not start on its own once YouTube has taken over."""
    try:
        _osascript('tell application "Music" to pause', timeout=2)
    except MusicError:
        pass


def _music_or_pause(script: str, *args: str, timeout: float) -> str:
    """A Music script; if Music does not answer in time, it is paused so the order still on its way does not make
    it play on top of YouTube."""
    try:
        return _osascript(script, *args, timeout=timeout)
    except MusicError as error:
        if error.reason == "silent":
            _pause_music()
        raise


def _play_music(query: str) -> str:
    """Apple Music: a song of the user's library plays; otherwise the first song of the public catalogue opens in
    Music for the user to press ▶, all within `BUDGET` seconds. When Music does not answer, it is paused so it does
    not play on top of YouTube."""
    start = time.monotonic()
    left = lambda: BUDGET - (time.monotonic() - start)  # noqa: E731 - a short clock read in several places
    result = _music_or_pause(SEARCH_MUSIC, query, timeout=min(TIMEOUT, BUDGET))
    if result != "none":
        return f"Reproduciendo «{query}» en Música."
    if left() < 5:  # the library search alone took most of the time: Music is too slow today
        raise MusicError(f"Música tarda demasiado en poner «{query}». Prueba con YouTube.", "silent")
    song = catalog_song(query, timeout=min(4.0, left() - 4))
    if not song:
        raise MusicError(f"No encuentro «{query}» en Apple Music. Prueba con YouTube.", "missing")
    _music_or_pause(OPEN_IN_MUSIC, song["url"], timeout=3)
    by = f" de {song['artist']}" if song["artist"] else ""
    return (f"Abro «{song['name']}»{by} en Música: está marcada en su álbum, haz doble clic en ella para escucharla "
            "(Apple Music ya no deja ponerla sola desde fuera).")
