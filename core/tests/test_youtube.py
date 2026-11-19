"""YouTube inside AgoraOne: a search page is read as data and only valid video ids, titles, channels and lengths
are kept (no lives, no repeats, never more than ten)."""

import json

import httpx
import pytest

from agora_core import youtube


def page(videos):
    data = {"contents": {"list": [{"videoRenderer": v} for v in videos]}}
    return f"<script>var ytInitialData = {json.dumps(data)};</script>"


def video(ident, title="Canción", length="3:10"):
    return {"videoId": ident, "title": {"runs": [{"text": title}]}, "ownerText": {"runs": [{"text": "Canal"}]},
            **({"lengthText": {"simpleText": length}} if length else {})}


def test_lee_solo_videos_validos():
    found = youtube.parse(page([video("5g2hT4GmAGU", "Despechá"), video("5g2hT4GmAGU"), video("directo1234", length=None),
                                video("mal id"), video("Mq7gC2gLPLI")]))
    assert [v["id"] for v in found] == ["5g2hT4GmAGU", "Mq7gC2gLPLI"]
    assert found[0] == {"id": "5g2hT4GmAGU", "title": "Despechá", "channel": "Canal", "length": "3:10"}
    assert youtube.parse("<html>sin datos</html>") is None, "una página sin datos no es una búsqueda vacía"
    assert youtube.parse(page([])) == []
    assert len(youtube.parse(page([video(f"abcdefghi{n:02d}") for n in range(20)]))) == 10
    escaped = json.dumps({"c": [{"videoRenderer": video("5g2hT4GmAGU")}]}).replace("{", "\\x7b").replace("}", "\\x7d")
    assert youtube.parse(f"<script>var ytInitialData = '{escaped}';</script>")[0]["id"] == "5g2hT4GmAGU", "también la forma escapada"
    quoted = json.dumps({"c": [{"videoRenderer": video("5g2hT4GmAGU", "Rock \\' n roll")}]}).replace("\\", "\\x5c").replace("'", "\\x27")
    assert youtube.parse(f"<script>var ytInitialData = '{quoted}';</script>")[0]["title"] == "Rock \\' n roll", "una barra y un apóstrofo no vacían la página"


def test_una_pagina_sin_resultados_se_pide_otra_vez(monkeypatch):
    answers = iter([httpx.Response(200, text="<html>sin datos</html>"), httpx.Response(200, text=page([video("5g2hT4GmAGU")]))])
    monkeypatch.setattr(youtube.httpx, "get", lambda url, **k: next(answers))
    assert youtube.search("lofi")[0]["id"] == "5g2hT4GmAGU"
    asked = []
    monkeypatch.setattr(youtube.httpx, "get", lambda url, **k: asked.append(1) or httpx.Response(200, text=page([])))
    with pytest.raises(youtube.YouTubeError, match="No encuentro"):
        youtube.search("zzz")
    assert len(asked) == 1, "una búsqueda sin resultados no se repite"
    monkeypatch.setattr(youtube.httpx, "get", lambda url, **k: httpx.Response(200, text="<html>comprobación</html>"))
    with pytest.raises(youtube.YouTubeError, match="No he podido leer"):
        youtube.search("zzz")


def test_busqueda(monkeypatch):
    asked = []
    monkeypatch.setattr(youtube.httpx, "get", lambda url, **k: asked.append((url, k["params"])) or httpx.Response(200, text=page([video("5g2hT4GmAGU")])))
    assert youtube.search("  rosalía   despechá ")[0]["id"] == "5g2hT4GmAGU"
    assert asked == [("https://www.youtube.com/results", {"search_query": "rosalía despechá"})]
    monkeypatch.setattr(youtube.httpx, "get", lambda url, **k: httpx.Response(200, text=page([])))
    with pytest.raises(youtube.YouTubeError, match="No encuentro"):
        youtube.search("zzz")
    with pytest.raises(youtube.YouTubeError):
        youtube.search("   ")


def test_ruta_de_busqueda(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from agora_core.app import SECRET_HEADER, create_app
    from agora_core.keystore import MemoryStore
    from agora_core.settings import load_settings
    from tests.test_fiscal_excel import MemorySecrets
    settings = load_settings({"AGORA_CORE_SECRET": "a" * 64, "AGORA_CORE_DATA": str(tmp_path / "data")})
    monkeypatch.setattr(youtube.httpx, "get", lambda url, **k: httpx.Response(200, text=page([video("5g2hT4GmAGU")])))
    with TestClient(create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=MemorySecrets()), base_url=f"http://{settings.authority}") as client:
        h = {SECRET_HEADER: "a" * 64}
        assert client.get("/music/youtube/search?q=rosalía", headers=h).json()["videos"][0]["id"] == "5g2hT4GmAGU"
        monkeypatch.setattr(youtube.httpx, "get", lambda url, **k: httpx.Response(302, headers={"location": "https://consent.youtube.com/"}))
        refused = client.get("/music/youtube/search?q=x", headers=h)
        assert refused.status_code == 422 and "condiciones" in refused.json()["error"]


def test_tambien_lee_los_resultados_con_el_formato_nuevo_de_youtube():
    lockup = {"lockupViewModel": {"contentId": "fJ9rUzIMcZQ", "contentType": "LOCKUP_CONTENT_TYPE_VIDEO",
              "contentImage": {"thumbnailViewModel": {"overlays": [{"thumbnailBottomOverlayViewModel": {"badges": [{"thumbnailBadgeViewModel": {"text": "6:00"}}]}}]}},
              "metadata": {"lockupMetadataViewModel": {"title": {"content": "Queen – Bohemian Rhapsody"}, "metadata": {"contentMetadataViewModel": {"metadataRows": [
                  {"metadataParts": [{"avatarStack": {"avatarStackViewModel": {"text": {"content": "Queen Official"}}}}, {"text": {"content": "2117 M"}}]}]}}}}}}
    playlist = {"lockupViewModel": {"contentId": "PL123", "contentType": "LOCKUP_CONTENT_TYPE_PLAYLIST"}}
    page = "<script>var ytInitialData = " + json.dumps({"contents": [playlist, lockup]}) + ";</script>"
    assert youtube.parse(page) == [{"id": "fJ9rUzIMcZQ", "title": "Queen – Bohemian Rhapsody", "channel": "Queen Official", "length": "6:00"}]
