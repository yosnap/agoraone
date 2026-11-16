"""Watson's voice: the chosen engine and voice, what speaks when VoiceStudio is closed or the voice is gone, and
that the core only ever talks to VoiceStudio's fixed address on this Mac."""

import httpx
import pytest

from agora_core import tts
from agora_core.db import DB_NAME, connect, migrate

VOICES = [{"id": "c63", "name": "Watson (AgoraOne)", "language": "Spanish"}, {"id": "d1", "name": "Demo", "language": "English"}]


def test_auto_usa_el_perfil_de_watson_o_macos():
    chosen = dict(tts.DEFAULTS)
    assert tts.resolve(chosen, VOICES)["engine"] == "voicestudio" and tts.resolve(chosen, VOICES)["voice"] == "c63"
    assert tts.resolve(chosen, None)["engine"] == "macos", "VoiceStudio cerrado"
    assert tts.resolve(chosen, VOICES[1:])["engine"] == "macos", "sin el perfil de Watson"


def test_voz_elegida_que_falta_vuelve_a_macos_y_lo_dice():
    chosen = {**tts.DEFAULTS, "engine": "voicestudio", "voice": "zz"}
    now = tts.resolve(chosen, VOICES)
    assert now["engine"] == "macos" and "ya no está" in now["problem"]
    assert "no está abierto" in tts.resolve(chosen, None)["problem"]


def test_ajustes_validados(tmp_path):
    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    assert tts.save_settings(connection, {"engine": "voicestudio", "voice": "c63", "speed": 1.2})["speed"] == 1.2
    for wrong in ({"engine": "nube"}, {"speed": 5}, {"voice": "x" * 200}):
        with pytest.raises(tts.TtsError):
            tts.save_settings(connection, wrong)
    assert tts.settings(connection)["voice"] == "c63"
    connection.close()


def test_solo_habla_con_voicestudio_en_este_mac(monkeypatch):
    asked = []

    def post(url, json, timeout):
        asked.append((url, json))
        return httpx.Response(200, headers={"content-type": "audio/wav"}, content=b"RIFF")
    monkeypatch.setattr(tts.httpx, "post", post)
    assert tts.synthesize("c63", "  Hola   Paulo. " + "x" * 600) == b"RIFF"
    url, body = asked[0]
    assert url == "http://127.0.0.1:3900/v1/audio/speech" and body["voice"] == "c63" and len(body["input"]) <= tts.MAX_TEXT
    monkeypatch.setattr(tts.httpx, "post", lambda *a, **k: httpx.Response(500, content=b"no"))
    with pytest.raises(tts.TtsError):
        tts.synthesize("c63", "Hola")


def test_rutas_de_la_voz(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from agora_core.app import SECRET_HEADER, create_app
    from agora_core.keystore import MemoryStore
    from agora_core.settings import load_settings
    from tests.test_fiscal_excel import MemorySecrets
    monkeypatch.setattr(tts, "voicestudio_voices", lambda fresh=False: VOICES)
    monkeypatch.setattr(tts, "synthesize", lambda voice, text, steps=16: b"RIFF" + voice.encode() + str(steps).encode())
    settings = load_settings({"AGORA_CORE_SECRET": "a" * 64, "AGORA_CORE_DATA": str(tmp_path / "data")})
    with TestClient(create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=MemorySecrets()), base_url=f"http://{settings.authority}") as client:
        h = {SECRET_HEADER: "a" * 64}
        view = client.get("/voice/tts", headers=h).json()
        assert view["now"] == {"engine": "voicestudio", "voice": "c63", "speed": 1.0, "macVoice": None, "problem": None, "steps": 16}
        spoken = client.post("/voice/speak", json={"text": "Hola"}, headers=h)
        assert spoken.status_code == 200 and spoken.headers["content-type"] == "audio/wav" and spoken.content == b"RIFFc6316"
        assert client.put("/voice/tts", json={"engine": "macos"}, headers=h).json()["now"]["engine"] == "macos"
        assert client.post("/voice/speak", json={"text": "Hola"}, headers=h).status_code == 503, "con macOS habla la pantalla, no el núcleo"
        assert client.put("/voice/tts", json={"speed": 9}, headers=h).status_code == 422
        assert client.put("/voice/tts", json={"engine": "auto", "quality": "fast"}, headers=h).json()["now"]["steps"] == 8
        assert client.post("/voice/speak", json={"text": "Hola"}, headers=h).content == b"RIFFc638", "pide a VoiceStudio la calidad elegida"
        assert client.put("/voice/tts", json={"quality": "max"}, headers=h).status_code == 422


def test_pide_los_pasos_de_la_calidad_y_no_otros(monkeypatch):
    asked = []
    monkeypatch.setattr(tts.httpx, "post", lambda url, json, timeout: asked.append(json) or httpx.Response(200, headers={"content-type": "audio/wav"}, content=b"RIFF"))
    tts.synthesize("c63", "Hola")
    tts.synthesize("c63", "Hola", steps=8)
    tts.synthesize("c63", "Hola", steps=64)
    assert [body["num_step"] for body in asked] == [16, 8, 16], "nunca el perfil «max» de VoiceStudio"


def _db(tmp_path, **changes):
    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    if changes:
        tts.save_settings(connection, changes)
    connection.close()
    return lambda: connect(tmp_path / DB_NAME)


def test_abre_voicestudio_al_arrancar_solo_si_esta_cerrado_y_se_quiere(tmp_path, monkeypatch):
    opened, warmed = [], []
    monkeypatch.setattr(tts, "warm", lambda chosen: warmed.append(chosen["engine"]))
    monkeypatch.setattr(tts, "installed_app", lambda: tts.APPS[0])
    monkeypatch.setattr(tts.time, "sleep", lambda s: None)
    state = {"open": False}
    monkeypatch.setattr(tts, "_read_voices", lambda: VOICES if state["open"] else None)

    def opener(command, **kwargs):
        opened.append(command)
        state["open"] = True
    assert tts.open_at_start(_db(tmp_path / "a", engine="macos"), opener=opener) == "off"
    assert tts.open_at_start(_db(tmp_path / "b", openAtStart=False), opener=opener) == "off"
    assert opened == []
    assert tts.open_at_start(_db(tmp_path / "c"), opener=opener) == "ready"
    assert opened == [["/usr/bin/open", "-g", "-j", str(tts.APPS[0])]], "en segundo plano, sin quitar el foco"
    assert tts.open_at_start(_db(tmp_path / "c"), opener=opener) == "ready" and len(opened) == 1, "ya abierto: no se vuelve a abrir"
    assert warmed == ["auto", "auto"]


def test_si_no_esta_instalado_o_no_arranca_se_dice(tmp_path, monkeypatch):
    monkeypatch.setattr(tts, "_read_voices", lambda: None)
    monkeypatch.setattr(tts, "installed_app", lambda: None)
    assert tts.open_at_start(_db(tmp_path / "a"), opener=lambda *a, **k: None) == "missing"
    monkeypatch.setattr(tts, "installed_app", lambda: tts.APPS[0])
    monkeypatch.setattr(tts.time, "sleep", lambda s: None)
    assert tts.open_at_start(_db(tmp_path / "b"), wait=0, opener=lambda *a, **k: None) == "failed"
    assert tts._launch["state"] == "failed"
    assert "no respondió" in tts.resolve(dict(tts.DEFAULTS), None)["problem"], "se dice en Ajustes"
    tts._launch["state"] = None


def test_no_se_queda_abriendo_si_el_puerto_contesta_otra_cosa(tmp_path, monkeypatch):
    monkeypatch.setattr(tts, "installed_app", lambda: tts.APPS[0])
    monkeypatch.setattr(tts.time, "sleep", lambda s: None)
    monkeypatch.setattr(tts.httpx, "get", lambda url, timeout: httpx.Response(200, json=None, request=httpx.Request("GET", url)))
    assert tts.open_at_start(_db(tmp_path), wait=0, opener=lambda *a, **k: None) == "failed"
    assert tts._launch["state"] == "failed"
    tts._launch["state"] = None


def test_calentar_solo_si_hace_rato_que_no_habla(monkeypatch):
    said = []
    monkeypatch.setattr(tts, "voicestudio_voices", lambda fresh=False: VOICES)
    monkeypatch.setattr(tts, "_spoke", {"at": -1e9, "failed": -1e9})
    monkeypatch.setattr(tts.httpx, "post", lambda url, json, timeout: said.append((json["input"], json["num_step"])) or httpx.Response(200, headers={"content-type": "audio/wav"}, content=b"RIFF"))
    assert tts.warm(dict(tts.DEFAULTS)) is True and said == [("Hola.", 8)]
    assert tts.warm(dict(tts.DEFAULTS)) is False and len(said) == 1, "acaba de hablar: ya está cargada"
    tts._spoke["at"] -= tts.WARM_FOR + 1
    assert tts.warm(dict(tts.DEFAULTS)) is True and len(said) == 2
    assert tts.warm({**tts.DEFAULTS, "engine": "macos"}) is False
    tts._spoke["at"] -= tts.WARM_FOR + 1
    monkeypatch.setattr(tts.httpx, "post", lambda *a, **k: said.append("fallo") or httpx.Response(500, content=b"no"))
    assert tts.warm(dict(tts.DEFAULTS)) is False and tts.warm(dict(tts.DEFAULTS)) is False
    assert said.count("fallo") == 1, "si VoiceStudio falla, no se reintenta en cada pregunta"
