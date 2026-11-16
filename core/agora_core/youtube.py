"""YouTube inside AgoraOne (1.7): finds videos for «pon … en YouTube» so the screen plays them in its own small
player, controlled only from AgoraOne. Only the words asked for go to YouTube (its public search page, no account,
no key); the page is read as data and only video ids, titles, channels and lengths are kept. Nothing is downloaded."""

import json
import re

import httpx

SEARCH = "https://www.youtube.com/results"
AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
MAX_RESULTS = 10


class YouTubeError(RuntimeError):
    pass


def _videos(node):
    if isinstance(node, dict):
        if "videoRenderer" in node:
            yield node["videoRenderer"]
        for value in node.values():
            yield from _videos(value)
    elif isinstance(node, list):
        for value in node:
            yield from _videos(value)


def _text(field) -> str:
    if not isinstance(field, dict):
        return ""
    if "simpleText" in field:
        return str(field["simpleText"])
    return "".join(str(run.get("text", "")) for run in field.get("runs", []) if isinstance(run, dict))


def parse(page: str) -> list[dict]:
    """The videos of a search page (no lives, no shorts without length), in YouTube's order."""
    match = re.search(r"var ytInitialData = (\{.*?\});</script>", page, re.S)
    if not match:
        return []
    try:
        data = json.loads(match.group(1))
    except json.JSONDecodeError:
        return []
    found, seen = [], set()
    for video in _videos(data):
        ident = str(video.get("videoId") or "")
        length = _text(video.get("lengthText"))
        if not VIDEO_ID.fullmatch(ident) or ident in seen or not length:
            continue
        seen.add(ident)
        found.append({"id": ident, "title": _text(video.get("title"))[:200] or "Vídeo sin título",
                      "channel": _text(video.get("ownerText"))[:120] or None, "length": length[:12]})
        if len(found) >= MAX_RESULTS:
            break
    return found


def search(query: str) -> list[dict]:
    query = " ".join((query or "").split())[:120]
    if not query:
        raise YouTubeError("Di qué quieres escuchar en YouTube.")
    try:
        # No redirects: only youtube.com's own results page is read (a consent page elsewhere is not followed).
        answer = httpx.get(SEARCH, params={"search_query": query}, timeout=15, follow_redirects=False,
                           headers={"User-Agent": AGENT, "Accept-Language": "es-ES,es;q=0.9"})
    except httpx.HTTPError as error:
        raise YouTubeError("YouTube no responde. ¿Hay conexión a internet?") from error
    if 300 <= answer.status_code < 400:
        raise YouTubeError("YouTube pide aceptar sus condiciones antes de buscar: ábrelo una vez en el navegador.")
    if answer.status_code != 200:
        raise YouTubeError("YouTube no deja buscar ahora.")
    found = parse(answer.text)
    if not found:
        raise YouTubeError(f"No encuentro «{query}» en YouTube.")
    return found
