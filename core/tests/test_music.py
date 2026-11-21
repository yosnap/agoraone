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


def test_solo_lo_que_falta_se_puede_buscar_en_youtube(mac, monkeypatch):
    monkeypatch.setattr(music, "_running", lambda process: True)
    monkeypatch.setattr(music, "_osascript", lambda script, *a, **k: "none")
    monkeypatch.setattr(music, "catalog_song", lambda query, **k: None)  # nothing in the catalogue either
    with pytest.raises(music.MusicError) as missing:
        music.play("music", "jazz")
    assert missing.value.reason == "missing"
    # In the catalogue: its album opens in Music, Music's own «Play» is pressed and it skips to the song.
    monkeypatch.setattr(music, "catalog_song", lambda query, **k: {"name": "So What", "artist": "Miles Davis", "url": "music://music.apple.com/es/album/1?i=2"})
    asked = []
    answers = {music.SEARCH_MUSIC: "none", music.OPEN_IN_MUSIC: "opened", music.MUSIC_VOLUME: "70", music.PLAY_PAGE: "ok"}
    monkeypatch.setattr(music, "_osascript", lambda script, *a, **k: asked.append((script, a)) or answers[script])
    assert "Pongo «So What» de Miles Davis" in music.play("music", "jazz")
    assert (music.OPEN_IN_MUSIC, ("music://music.apple.com/es/album/1?i=2",)) in asked
    assert asked[-1][0] == music.PLAY_PAGE and asked[-1][1][0] == "So What"
    # Without «Accesibilidad» the page stays open in Music and the user is told how; YouTube does not take over.
    def no_access(script, *a, **k):
        if script == music.PLAY_PAGE:
            raise music.MusicError("El reproductor no pudo hacerlo.")
        return answers[script]
    monkeypatch.setattr(music, "_osascript", no_access)
    assert "Accesibilidad" in music.play("music", "jazz")
    # The song is not in the album Music plays: said, and YouTube may play it.
    monkeypatch.setattr(music, "_osascript", lambda script, *a, **k: "none" if script == music.PLAY_PAGE else answers[script])
    with pytest.raises(music.MusicError) as unplayed:
        music.play("music", "jazz")
    assert unplayed.value.reason == "missing"
    def denied(script, *a, **k):
        raise music.MusicError("macOS no deja a AgoraOne controlar la música")
    monkeypatch.setattr(music, "_osascript", denied)
    with pytest.raises(music.MusicError) as refused:
        music.play("music", "jazz")
    assert refused.value.reason is None, "un permiso que falta se dice, no se tapa con YouTube"


def test_spotify_en_la_papelera_no_cuenta(monkeypatch, tmp_path):
    import subprocess
    monkeypatch.setattr(music, "_running", lambda process: False)
    monkeypatch.setattr(music.Path, "home", lambda: tmp_path)
    monkeypatch.setattr(music.Path, "is_dir", lambda self: False)
    found = "/Users/x/.Trash/Spotify.app\n/Volumes/Copia/Applications/Spotify.app\n"
    monkeypatch.setattr(music.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 0, found, ""))
    assert not music._installed("spotify")
    monkeypatch.setattr(music.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 0, found + "/Users/x/Apps/Spotify.app\n", ""))
    assert music._installed("spotify")


def test_cancion_del_catalogo_de_apple_music():
    import httpx
    from agora_core import music
    answer = httpx.Response(200, json={"results": [{"trackName": "Corazón Partío", "artistName": "Alejandro Sanz", "collectionId": 193410821, "trackId": 193410897}]})
    song = music.catalog_song("alejandro sanz", fetch=lambda url, **k: answer)
    assert song == {"name": "Corazón Partío", "artist": "Alejandro Sanz", "url": "music://music.apple.com/es/album/193410821?i=193410897"}
    assert music.catalog_song("x", fetch=lambda url, **k: httpx.Response(200, json={"results": []})) is None
    def roto(url, **k):
        raise httpx.ConnectError("sin red")
    assert music.catalog_song("x", fetch=roto) is None
    raro = httpx.Response(200, json={"results": [{"trackName": "x", "collectionId": "1;do shell script", "trackId": 2}]})
    assert music.catalog_song("x", fetch=lambda url, **k: raro) is None  # only numeric ids reach the address


def _osascript_falso(monkeypatch, answer):
    """`subprocess.run` stand-in for osascript: `answer(script, args)` returns stdout or raises; every call is kept."""
    import subprocess
    calls = []
    def run(command, **kwargs):
        script, args = command[2], tuple(command[3:])
        calls.append((script, args, kwargs.get("timeout")))
        return subprocess.CompletedProcess(command, 0, answer(script, args), "")
    monkeypatch.setattr(music.subprocess, "run", run)
    return calls


def _cuelga(script, args):
    import subprocess
    raise subprocess.TimeoutExpired("osascript", 1)


def test_musica_que_no_responde_se_pausa_para_no_sonar_con_youtube(monkeypatch):
    monkeypatch.setattr(music.sys, "platform", "darwin")
    monkeypatch.setattr(music, "_installed", lambda player: True)
    calls = _osascript_falso(monkeypatch, lambda script, args: _cuelga(script, args) if script == music.SEARCH_MUSIC else "")
    with pytest.raises(music.MusicError) as silent:
        music.play("music", "so what")
    assert silent.value.reason == "silent"
    assert [script for script, _, _ in calls] == [music.SEARCH_MUSIC, 'tell application "Music" to pause']
    assert all(timeout <= music.TIMEOUT for _, _, timeout in calls)


def test_el_catalogo_cabe_en_el_tiempo_de_watson(monkeypatch):
    # La biblioteca tarda casi todo lo que hay: no se abre el catálogo y se pasa a YouTube enseguida.
    monkeypatch.setattr(music.sys, "platform", "darwin")
    monkeypatch.setattr(music, "_installed", lambda player: True)
    clock = iter([0.0, 16.0])
    monkeypatch.setattr(music.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(music, "catalog_song", lambda *a, **k: pytest.fail("no queda tiempo para el catálogo"))
    _osascript_falso(monkeypatch, lambda script, args: "none")
    with pytest.raises(music.MusicError) as slow:
        music.play("music", "so what")
    assert slow.value.reason == "silent"


def test_el_catalogo_y_la_reproduccion_caben_en_el_tiempo_de_watson(monkeypatch):
    monkeypatch.setattr(music.sys, "platform", "darwin")
    monkeypatch.setattr(music, "_installed", lambda player: True)
    now = [0.0]
    monkeypatch.setattr(music.time, "monotonic", lambda: now[0])
    asked = {}
    def song(query, timeout):
        asked["catalog"] = timeout
        now[0] = 3.0
        return {"name": "So What", "artist": "Miles Davis", "url": "music://music.apple.com/es/album/1?i=2"}
    monkeypatch.setattr(music, "catalog_song", song)
    answers = {music.SEARCH_MUSIC: "none", music.OPEN_IN_MUSIC: "opened", music.MUSIC_VOLUME: "50", music.PLAY_PAGE: "ok"}
    calls = _osascript_falso(monkeypatch, lambda script, args: answers[script])
    assert "So What" in music.play("music", "so what")
    assert asked["catalog"] <= 4
    assert [script for script, _, _ in calls] == [music.SEARCH_MUSIC, music.OPEN_IN_MUSIC, music.MUSIC_VOLUME, music.PLAY_PAGE]
    play = calls[-1]
    assert int(play[1][1]) + 3 <= music.BUDGET - 3 + 3 and play[2] == int(play[1][1]) + 3, "AppleScript para a tiempo y se corta 3 s después"


def test_si_la_reproduccion_se_cuelga_python_pausa_y_devuelve_el_volumen(monkeypatch):
    monkeypatch.setattr(music.sys, "platform", "darwin")
    monkeypatch.setattr(music, "_installed", lambda player: True)
    monkeypatch.setattr(music, "catalog_song", lambda query, timeout: {"name": "So What", "artist": "", "url": "music://music.apple.com/es/album/1?i=2"})
    answers = {music.SEARCH_MUSIC: "none", music.OPEN_IN_MUSIC: "opened", music.MUSIC_VOLUME: "65"}
    calls = _osascript_falso(monkeypatch, lambda script, args: _cuelga(script, args) if script == music.PLAY_PAGE else answers.get(script, ""))
    with pytest.raises(music.MusicError) as cut:
        music.play("music", "so what")
    assert cut.value.reason == "silent"
    assert [script for script, _, _ in calls][-2:] == ['tell application "Music" to pause', 'tell application "Music" to set sound volume to 65']


def test_el_album_se_pone_entero_y_sin_buscar_en_la_biblioteca(monkeypatch):
    monkeypatch.setattr(music.sys, "platform", "darwin")
    monkeypatch.setattr(music, "_installed", lambda player: True)
    monkeypatch.setattr(music, "catalog_song", lambda *a, **k: pytest.fail("un álbum no se busca como canción"))
    monkeypatch.setattr(music, "catalog_album", lambda query, timeout: {"name": "Sueños Líquidos", "artist": "Maná", "url": "music://music.apple.com/es/album/9"} if query == "Sueños líquidos" else None)
    calls = _osascript_falso(monkeypatch, lambda script, args: {music.MUSIC_VOLUME: "50", music.PLAY_PAGE: "ok"}.get(script, "opened"))
    assert music.play("music", "el álbum Sueños líquidos") == "Pongo el álbum «Sueños Líquidos» de Maná en Música, de Apple Music."
    assert music.SEARCH_MUSIC not in [script for script, _, _ in calls]
    assert calls[-1][0] == music.PLAY_PAGE and calls[-1][1][0] == "", "sin canción: desde la primera pista"


def test_play_pulsa_el_menu_por_su_atajo_y_no_por_su_nombre():
    script = music.PLAY_PAGE
    assert '"AXMenuItemCmdChar" of i) is " "' in script and '"AXMenuItemCmdModifiers" of i) is 8' in script
    assert "Reproducir" not in script and "Controles" not in script
    assert script.index("to stop") < script.index("press_play()"), "detenido, «Reproducir» pone la página y no reanuda la cola"
    assert "set sound volume to v" in script[script.index("on error errMsg"):]


def test_el_catalogo_prefiere_al_artista_y_evita_versiones():
    import httpx
    results = [{"trackName": "En el Muelle de San Blás", "artistName": "Guitar Dreamers", "collectionName": "Guitar Dreamers Play Maná (Instrumental)", "collectionId": 1, "trackId": 2},
               {"trackName": "En el Muelle de San Blás", "artistName": "Karaoke Hits", "collectionName": "Éxitos", "collectionId": 3, "trackId": 4},
               {"trackName": "En el Muelle de San Blás", "artistName": "Maná", "collectionName": "Sueños Líquidos", "collectionId": 5, "trackId": 6}]
    fetch = lambda url, **k: httpx.Response(200, json={"results": results})  # noqa: E731
    assert music.catalog_song("En el muelle de San Blas Maná", fetch=fetch)["url"].endswith("/5?i=6")
    assert music.catalog_song("En el muelle de San Blas", fetch=fetch)["artist"] == "Maná", "sin artista, tampoco una versión"
    assert music.catalog_song("muelle de san blas karaoke", fetch=fetch)["artist"] == "Guitar Dreamers", "si se pide una versión, vale"
