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
    assert youtube.parse("<html>sin datos</html>") == []
    assert len(youtube.parse(page([video(f"abcdefghi{n:02d}") for n in range(20)]))) == 10
    escaped = json.dumps({"c": [{"videoRenderer": video("5g2hT4GmAGU")}]}).replace("{", "\\x7b").replace("}", "\\x7d")
    assert youtube.parse(f"<script>var ytInitialData = '{escaped}';</script>")[0]["id"] == "5g2hT4GmAGU", "también la forma escapada"


def test_una_pagina_sin_resultados_se_pide_otra_vez(monkeypatch):
    answers = iter([httpx.Response(200, text="<html>sin datos</html>"), httpx.Response(200, text=page([video("5g2hT4GmAGU")]))])
    monkeypatch.setattr(youtube.httpx, "get", lambda url, **k: next(answers))
    assert youtube.search("lofi")[0]["id"] == "5g2hT4GmAGU"


def test_busqueda(monkeypatch):
    asked = []
    monkeypatch.setattr(youtube.httpx, "get", lambda url, **k: asked.append((url, k["params"])) or httpx.Response(200, text=page([video("5g2hT4GmAGU")])))
    assert youtube.search("  rosalía   despechá ")[0]["id"] == "5g2hT4GmAGU"
    assert asked == [("https://www.youtube.com/results", {"search_query": "rosalía despechá"})]
    monkeypatch.setattr(youtube.httpx, "get", lambda url, **k: httpx.Response(200, text="nada"))
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
