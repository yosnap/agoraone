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
