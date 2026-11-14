"""Receipts from the phone: the one exception to «listen only on this Mac» (user's decision, 14/11/2026).

«Subir desde el móvil» opens, for 10 minutes, a tiny web server on the home network at a random port with a
one-time random link shown as a QR code. It serves a single upload page and accepts one file (a photo or
a PDF, recognised by its bytes, at most 15 MB); then, or when the time is up, it closes. Nothing else of
AgoraOne is reachable through it. The receipt waits in AgoraOne's data until the user files it."""

import hashlib
import hmac
import html
import io
import ipaddress
import json
import secrets
import socket
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .db import now
from .fiscal import MAX_FILE, SUFFIXES, media_type

OPEN_SECONDS = 600
PAGE = """<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Subir recibo · AgoraOne</title><style>body{{font:16px system-ui;margin:24px;color:#173d3c;background:#f4f2ea}}
button,input{{font:inherit}}button{{margin-top:16px;padding:12px 18px;border-radius:10px;border:0;background:#244e42;color:#fff}}</style></head>
<body><h1>Subir un recibo</h1>{body}</body></html>"""
FORM = """<p>Haz una foto del recibo o elige un PDF. Este enlace sirve para una sola subida.</p>
<form method="post" enctype="multipart/form-data"><input type="file" name="recibo" accept="image/*,application/pdf" capture="environment" required>
<br><button>Enviar al Mac</button></form>"""


class UploadError(RuntimeError):
    pass


def lan_address() -> str:
    """This Mac's address on the home network (a private one); no packet is sent to find it."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))  # documentation address: only picks the outgoing interface
        address = probe.getsockname()[0]
    except OSError as error:
        raise UploadError("Este Mac no está conectado a ninguna red.") from error
    finally:
        probe.close()
    if not ipaddress.ip_address(address).is_private:
        raise UploadError("La red no es una red local privada: no se abre la subida.")
    return address


@dataclass
class Window:
    token: str
    url: str
    expires_at: float
    server: ThreadingHTTPServer | None = None
    received: int | None = None  # the receipt id once uploaded
    closed: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)

    def close(self) -> None:
        with self.lock:
            if self.closed:
                return
            self.closed = True
        if self.server is not None:
            threading.Thread(target=self.server.shutdown, daemon=True).start()


def _multipart_file(content_type: str, body: bytes) -> tuple[str | None, bytes] | None:
    """The single file of a multipart/form-data body, with the standard library's email parser."""
    from email.parser import BytesParser
    from email.policy import HTTP

    message = BytesParser(policy=HTTP).parsebytes(b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body)
    for part in message.iter_parts() if message.is_multipart() else []:
        if part.get_param("name", header="content-disposition") == "recibo":
            return part.get_filename(), part.get_payload(decode=True) or b""
    return None


def save_receipt(connection: sqlite3.Connection, folder: Path, data: bytes, name: str | None) -> int:
    kind = media_type(data)
    if kind is None or len(data) > MAX_FILE:
        raise UploadError("Solo se aceptan fotos (JPEG, PNG, HEIC) o PDF de hasta 15 MB.")
    digest = hashlib.sha256(data).hexdigest()
    known = connection.execute("SELECT id FROM receipt WHERE sha256 = ?", (digest,)).fetchone()
    if known:
        return known["id"]
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    file = f"{digest[:24]}{SUFFIXES[kind]}"
    (folder / file).write_bytes(data)
    (folder / file).chmod(0o600)
    return connection.execute(
        "INSERT INTO receipt (file, original_name, media_type, bytes, sha256, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)",
        (file, (name or "")[:200] or None, kind, len(data), digest, now())).lastrowid


def open_window(store, address: str | None = None, seconds: int = OPEN_SECONDS) -> Window:
    """Opens the upload server; `store(data, name)` keeps the file and returns the receipt id."""
    host = address or lan_address()
    token = secrets.token_urlsafe(24)
    window = Window(token, "", time.time() + seconds)

    class Handler(BaseHTTPRequestHandler):
        server_version = "AgoraOne"
        sys_version = ""

        def log_message(self, *args):  # nothing about the phone or the link in the logs
            pass

        def _send(self, status: int, body: str) -> None:
            data = PAGE.format(body=body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
            self.end_headers()
            self.wfile.write(data)

        def _valid(self) -> bool:
            ok = (hmac.compare_digest(self.path, f"/{token}") and not window.closed and time.time() < window.expires_at and window.received is None)
            if not ok:
                self._send(404, "<p>Este enlace ya no sirve. Pide otro QR en AgoraOne.</p>")
            return ok

        def do_GET(self):
            if self._valid():
                self._send(200, FORM)

        def do_POST(self):
            if not self._valid():
                return
            length = int(self.headers.get("Content-Length") or 0)
            if not 0 < length <= MAX_FILE + 64 * 1024:
                self._send(413, "<p>El archivo es demasiado grande (máximo 15 MB).</p>")
                return
            body = self.rfile.read(length)
            found = _multipart_file(self.headers.get("Content-Type", ""), body)
            if found is None:
                self._send(400, "<p>No llegó ningún archivo. Vuelve atrás e inténtalo de nuevo.</p>")
                return
            try:
                with window.lock:
                    if window.received is not None:
                        raise UploadError("Este enlace ya se ha usado.")
                    window.received = store(found[1], found[0])
            except UploadError as error:
                self._send(415, f"<p>{html.escape(str(error))}</p>")
                return
            self._send(200, "<p>Recibido. Ya está en tu Mac, en la Bandeja de AgoraOne. Puedes cerrar esta página.</p>")
            window.close()

    server = ThreadingHTTPServer((host, 0), Handler)
    server.timeout = 30
    window.server = server
    window.url = f"http://{host}:{server.server_address[1]}/{token}"
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.5}, daemon=True).start()
    timer = threading.Timer(seconds, window.close)
    timer.daemon = True
    timer.start()
    return window


def qr_svg(url: str) -> str:
    import segno

    out = io.BytesIO()
    segno.make(url, error="m").save(out, kind="svg", scale=6, border=2, dark="#173d3c", light="#ffffff", xmldecl=False)
    return out.getvalue().decode()


def receipts(connection: sqlite3.Connection, state: str = "pending") -> list[dict]:
    return [{"id": r["id"], "name": r["original_name"], "mediaType": r["media_type"], "bytes": r["bytes"],
             "fields": json.loads(r["fields"]), "uploadedAt": r["uploaded_at"]}
            for r in connection.execute("SELECT * FROM receipt WHERE state = ? ORDER BY uploaded_at DESC", (state,))]
