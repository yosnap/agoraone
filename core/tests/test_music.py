"""Music: what plays read only from players already open, commands from a closed list, and «pon …» passed as
an argument to AppleScript, never written into the script. AppleScript and pgrep are stand-ins here."""

import pytest

from agora_core import music


@pytest.fixture
def mac(monkeypatch):
    calls = []
    monkeypatch.setattr(music.sys, "platform", "darwin")
    monkeypatch.setattr(music, "_running", lambda process: process == "Spotify")
    def osascript(script, *args):
        calls.append((script, args))
        if "player state" in script:
            return "playing\tSo What\tMiles Davis\tKind of Blue\t562000\t221.5\t60"
        if "spotify:search" in script:
            return "opened"
        return ""
    monkeypatch.setattr(music, "_osascript", osascript)
    return calls


def test_lo_que_suena_sin_abrir_nada(mac):
    state = music.status()
    assert [p["player"] for p in state["players"]] == ["spotify"], "Música no está abierta: no se le pregunta"
    assert state["players"][0] | {} == {"player": "spotify", "name": "Spotify", "state": "playing", "title": "So What", "artist": "Miles Davis",
                                        "album": "Kind of Blue", "duration": 562.0, "position": 221.5, "volume": 60.0}
    assert all('"Music"' not in script for script, _ in mac)


def test_ordenes_cerradas_y_pon_como_argumento(mac):
    music.control("spotify", "next")
    assert mac[-1][0] == 'tell application "Spotify" to next track'
    with pytest.raises(music.MusicError):
        music.control("spotify", "do shell script")
    with pytest.raises(music.MusicError, match="no está abierto"):
        music.control("music", "toggle")
    said = music.play("spotify", 'jazz" & do shell script "rm -rf ~')
    script, args = mac[-1]
    assert "rm -rf" not in script and args == ('jazz" & do shell script "rm -rf ~',), "el texto va como argumento"
    assert "Spotify" in said


def test_la_biblioteca_de_musica_no_depende_del_idioma():
    # En un Mac en español la lista se llama «Biblioteca»: buscar «Library» por nombre fallaba siempre.
    from agora_core import music
    assert "library playlist 1" in music.SEARCH_MUSIC and '"Library"' not in music.SEARCH_MUSIC


def test_spotify_sin_instalar_no_se_le_pregunta(mac, monkeypatch):
    # Preguntar por AppleScript a una app que no está abriría el «¿Dónde está Spotify?» de macOS.
    monkeypatch.setattr(music, "_installed", lambda player: player == "music")
    before = len(mac)
    with pytest.raises(music.MusicError, match="no está instalado"):
        music.play("spotify", "jazz")
    assert len(mac) == before
