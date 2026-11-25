"""What a mail brings besides its text, for the note made from it (user's decision, 17/11/2026): its attachments,
read again from the mail server in read-only mode, and the links to documents shared in its body. A shared document
is only downloaded when the user ticks it, and only from Google Drive or Dropbox (the others need a sign-in or a web
page): public https hosts at every redirect, at most MAX_FILE bytes, never a web page."""

import json
import re
import time
import unicodedata
from urllib.parse import parse_qsl, unquote, urlencode, urlparse, urlunparse

import httpx

from . import tls

MAX_FILE = 25 * 1024 * 1024
DEADLINE = 75  # seconds for a whole download, well under the proxy's 120 s
# What a mail's file may be next to a note, in the vault or a repository: documents, images, audio and video, never a
# web page, a script or a program. The same list as FILE_TYPES in desktop/server/src/vault/write.rs.
FILE_TYPES = frozenset({"pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff", "txt", "csv", "rtf", "doc", "docx", "xls", "xlsx",
                        "ppt", "pptx", "odt", "ods", "odp", "pages", "numbers", "key", "zip", "rar", "7z", "mp3", "m4a", "wav", "mp4", "mov",
                        "eml", "msg", "ics", "xml", "xsig"})
# Every hop of a shared document's download stays with the service that shares it.
HOSTS = re.compile(r"^(drive\.usercontent\.google\.com|docs\.google\.com|drive\.google\.com|[a-z0-9-]+\.googleusercontent\.com|"
                   r"(www\.)?dropbox\.com|[a-z0-9-]+\.dropboxusercontent\.com)$")
MAX_LINKS = 20
REDIRECTS = 5
_URL = re.compile(r"https://[^\s<>\"')\]]{4,500}", re.I)
SERVICES = (
    (re.compile(r"^(drive|docs)\.google\.com$"), "Google Drive"),
    (re.compile(r"^(www\.)?dropbox\.com$"), "Dropbox"),
    (re.compile(r"^(1drv\.ms|onedrive\.live\.com|[a-z0-9-]+\.sharepoint\.com)$"), "OneDrive"),
    (re.compile(r"^(www\.)?(wetransfer\.com|we\.tl)$"), "WeTransfer"),
    (re.compile(r"^(app\.)?box\.com$"), "Box"),
    (re.compile(r"^(www\.)?icloud\.com$"), "iCloud"),
)
_DRIVE_FILE = re.compile(r"^/file/d/([A-Za-z0-9_-]{10,})")
_DOCS = re.compile(r"^/(document|spreadsheets|presentation)/d/([A-Za-z0-9_-]{10,})")
_EXPORT = {"document": "export?format=pdf", "spreadsheets": "export?format=xlsx", "presentation": "export/pdf"}
_TYPES = {"application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "application/zip": "zip", "text/csv": "csv", "text/plain": "txt",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx"}
FORBIDDEN = re.compile(r"[\\/:*?\"<>|#^\[\]\x00-\x1f]")


class SourceError(ValueError):
    pass


def safe_name(name: str, fallback: str = "documento") -> str:
    """A file name the vault and a repository accept: no path, no hidden name, no invisible characters."""
    clean = "".join(c for c in unicodedata.normalize("NFC", name) if unicodedata.category(c) != "Cf")
    clean = " ".join(FORBIDDEN.sub(" ", clean.replace("\\", "/").split("/")[-1]).split()).lstrip(". ")
    stem, dot, extension = clean.rpartition(".")
    if not dot or not extension.isalnum() or len(extension) > 10:
        stem, extension = clean, ""  # «Informe final. Revisado» has no extension: keep it whole
    while len(stem.encode()) > 200:
        stem = stem[:-1]
    stem = stem.strip() or fallback
    return f"{stem}.{extension.lower()}" if extension else stem


def savable(name: str) -> bool:
    _, dot, extension = name.rpartition(".")
    return bool(dot) and extension.lower() in FILE_TYPES


def service(url: str) -> str | None:
    host = (urlparse(url).hostname or "").lower()
    return next((name for pattern, name in SERVICES if pattern.match(host)), None)


def direct(url: str) -> str | None:
    """The download address of a shared document that can be fetched without a sign-in, or None."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host == "drive.google.com" and (found := _DRIVE_FILE.match(parsed.path)):
        return f"https://drive.usercontent.google.com/download?id={found[1]}&export=download&confirm=t"
    if host == "docs.google.com" and (found := _DOCS.match(parsed.path)):
        return f"https://docs.google.com/{found[1]}/d/{found[2]}/{_EXPORT[found[1]]}"
    if host in ("dropbox.com", "www.dropbox.com") and parsed.path.startswith(("/s/", "/scl/fi/")):
        query = [(k, v) for k, v in parse_qsl(parsed.query) if k != "dl"] + [("dl", "1")]
        return urlunparse(parsed._replace(query=urlencode(query)))
    return None


def links(body: str | None) -> list[dict]:
    """Links to shared documents in the mail's text, each with its service and whether it can be downloaded."""
    found: list[dict] = []
    for match in _URL.finditer(body or ""):
        url = match[0].rstrip(".,;:")
        name = service(url)
        if name and url not in (f["url"] for f in found):
            found.append({"url": url, "service": name, "downloadable": direct(url) is not None})
        if len(found) >= MAX_LINKS:
            break
    return found


def attachments(stored: str | None) -> list[dict]:
    try:
        items = json.loads(stored or "[]")
    except ValueError:
        return []
    found = []
    for a in items:
        if isinstance(a, dict) and isinstance(a.get("part"), int):
            name = safe_name(str(a.get("name") or "adjunto"), "adjunto")
            found.append({"part": a["part"], "name": name, "type": str(a.get("type") or ""), "bytes": int(a.get("bytes") or 0),
                          "savable": savable(name) and int(a.get("bytes") or 0) <= MAX_FILE})
    return found


def _public(host: str) -> bool:
    from .invoice_extract import _public as public

    return public(host)


def _filename(disposition: str | None) -> str | None:
    if not disposition:
        return None
    if found := re.search(r"filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)", disposition):
        return unquote(found[1].strip().strip('"'))
    if found := re.search(r'filename\s*=\s*"?([^";]+)"?', disposition):
        return found[1].strip()
    return None


def download(url: str, client: httpx.Client | None = None, deadline: float = DEADLINE) -> tuple[str, bytes]:
    """(file name, bytes) of a shared document the user ticked. Raises SourceError saying why not."""
    target = direct(url)
    if target is None:
        raise SourceError("Ese enlace no se puede descargar sin entrar en su web: ábrelo en el navegador.")
    started = time.monotonic()
    http = client or httpx.Client(verify=tls.client_context(), timeout=15, follow_redirects=False, trust_env=False)
    try:
        for _ in range(REDIRECTS + 1):
            if time.monotonic() - started > deadline:
                raise SourceError("El documento tarda demasiado en llegar.")
            parsed = urlparse(target)
            if (parsed.scheme != "https" or parsed.port not in (None, 443) or not HOSTS.match((parsed.hostname or "").lower())
                    or not _public(parsed.hostname)):
                raise SourceError("Ese enlace lleva a una dirección que no es https pública del servicio que lo comparte.")
            with http.stream("GET", target) as response:
                if response.status_code in (301, 302, 303, 307, 308) and response.headers.get("location"):
                    target = str(httpx.URL(target).join(response.headers["location"]))
                    continue
                if response.status_code != 200:
                    raise SourceError("El servicio no entregó el archivo: puede que el enlace no sea público.")
                kind = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
                if kind.startswith("text/html"):
                    raise SourceError("El enlace lleva a una página, no a un archivo: puede que pida entrar o que no sea público.")
                if int(response.headers.get("content-length") or 0) > MAX_FILE:
                    raise SourceError("El archivo es demasiado grande (más de 25 MB).")
                chunks, size = [], 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    chunks.append(chunk)
                    if size > MAX_FILE or time.monotonic() - started > deadline:
                        raise SourceError("El archivo es demasiado grande o tarda demasiado.")
                name = safe_name(_filename(response.headers.get("content-disposition")) or f"documento.{_TYPES.get(kind, 'bin')}")
                if not savable(name):
                    raise SourceError(f"«{name}» es de un tipo que no se guarda junto a la nota.")
                return name, b"".join(chunks)
        raise SourceError("El enlace redirige demasiadas veces.")
    except (httpx.HTTPError, httpx.InvalidURL) as error:
        raise SourceError("No se pudo descargar el documento: ábrelo en el navegador.") from error
    finally:
        if client is None:
            http.close()
