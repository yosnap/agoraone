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
    monkeypatch.setattr(tts, "voicestudio_voices", lambda: VOICES)
    monkeypatch.setattr(tts, "synthesize", lambda voice, text: b"RIFF" + voice.encode())
    settings = load_settings({"AGORA_CORE_SECRET": "a" * 64, "AGORA_CORE_DATA": str(tmp_path / "data")})
    with TestClient(create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=MemorySecrets()), base_url=f"http://{settings.authority}") as client:
        h = {SECRET_HEADER: "a" * 64}
        view = client.get("/voice/tts", headers=h).json()
        assert view["now"] == {"engine": "voicestudio", "voice": "c63", "speed": 1.0, "macVoice": None, "problem": None}
        spoken = client.post("/voice/speak", json={"text": "Hola"}, headers=h)
        assert spoken.status_code == 200 and spoken.headers["content-type"] == "audio/wav" and spoken.content == b"RIFFc63"
        assert client.put("/voice/tts", json={"engine": "macos"}, headers=h).json()["now"]["engine"] == "macos"
        assert client.post("/voice/speak", json={"text": "Hola"}, headers=h).status_code == 503, "con macOS habla la pantalla, no el núcleo"
        assert client.put("/voice/tts", json={"speed": 9}, headers=h).status_code == 422
