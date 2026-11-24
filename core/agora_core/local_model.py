"""A language model running on this machine (LM Studio, Ollama or any server with the OpenAI chat API),
for what may not leave it: summaries of meetings marked «solo en este Mac» or private. Only loopback
addresses are accepted, and requests never go through a proxy."""

import ipaddress
import json
import urllib.error
import urllib.parse
import urllib.request

from . import tls

MAX_REPLY = 2 * 1024 * 1024
KNOWN = [{"name": "LM Studio", "url": "http://127.0.0.1:1234/v1"}, {"name": "Ollama", "url": "http://127.0.0.1:11434/v1"}]
_DIRECT = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=tls.client_context()),
)


class LocalModelError(RuntimeError):
    pass


def loopback(url: str | None) -> str | None:
    """The URL without a trailing slash if it points to this machine (http or https), else None."""
    if not url or len(url) > 300:
        return None
    try:
        parts = urllib.parse.urlsplit(url.strip())
        host = parts.hostname or ""
        if parts.scheme not in ("http", "https") or parts.username or parts.password or parts.query or parts.fragment:
            return None
        if host != "localhost" and not ipaddress.ip_address(host).is_loopback:
            return None
        parts.port  # noqa: B018 - raises on a bad port
    except ValueError:
        return None
    return url.strip().rstrip("/")


def _call(url: str, path: str, body: dict | None, timeout: float) -> dict:
    base = loopback(url)
    if not base:
        raise LocalModelError("El modelo local tiene que estar en este equipo (127.0.0.1 o localhost).")
    request = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"}, method="POST" if body is not None else "GET")
    try:
        with _DIRECT.open(request, timeout=timeout) as response:
            data = response.read(MAX_REPLY + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise LocalModelError("No responde el modelo local: ¿está abierto LM Studio u Ollama con su servidor?") from error
    if len(data) > MAX_REPLY:
        raise LocalModelError("El modelo local devolvió demasiado texto.")
    try:
        return json.loads(data)
    except ValueError as error:
        raise LocalModelError("El modelo local devolvió algo que no se entiende.") from error


def remote(name: str) -> bool:
    """Ollama's «cloud» models run on Ollama's servers, not here: never for what may not leave this machine."""
    lowered = name.lower()
    return lowered.endswith((":cloud", "-cloud")) or ":cloud" in lowered


def embedding(name: str) -> bool:
    """Models that only turn text into vectors (the brain's search) and cannot write a summary."""
    return "embed" in name.lower()


def models(url: str) -> list[str]:
    """The chat models that run on this machine: neither cloud models nor embedding ones."""
    data = _call(url, "/models", None, 5)
    names = {str(m.get("id")) for m in data.get("data") or [] if isinstance(m, dict) and m.get("id")}
    return sorted(n for n in names if not remote(n) and not embedding(n))[:200]


def detect() -> str | None:
    """The first known local server that answers now (LM Studio, then Ollama), for Settings to start from."""
    for known in KNOWN:
        try:
            _call(known["url"], "/models", None, 1)
            return known["url"]
        except LocalModelError:
            continue
    return None


def ask(url: str, model: str, system: str, text: str, timeout: float = 900) -> str:
    if remote(model):
        raise LocalModelError("Ese modelo se ejecuta en la nube de Ollama, no en este equipo.")
    data = _call(url, "/chat/completions", {"model": model, "temperature": 0.2, "stream": False,
                                            "messages": [{"role": "system", "content": system}, {"role": "user", "content": text}]}, timeout)
    try:
        return str(data["choices"][0]["message"]["content"] or "")
    except (KeyError, IndexError, TypeError) as error:
        raise LocalModelError("El modelo local devolvió algo que no se entiende.") from error


def release(url: str, model: str) -> None:
    """Ollama keeps a model in memory for minutes after answering; a meeting summary is a one-off, so it is
    let go at once (several GB of memory back). Other servers manage their own memory."""
    base = loopback(url)
    if not base or not base.endswith("/v1"):
        return
    request = urllib.request.Request(base[:-3] + "/api/generate", data=json.dumps({"model": model, "keep_alive": 0}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
    try:
        with _DIRECT.open(request, timeout=5) as response:
            response.read(MAX_REPLY)
    except (urllib.error.URLError, TimeoutError, OSError):
        pass  # not Ollama, or already gone: nothing to free
