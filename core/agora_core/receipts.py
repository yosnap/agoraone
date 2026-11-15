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

INBOX = "Recibos por revisar"

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


def _default_interface() -> str:
    import subprocess

    try:
        out = subprocess.run(["/sbin/route", "-n", "get", "default"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return next((line.split(":", 1)[1].strip() for line in out.splitlines() if line.strip().startswith("interface:")), "")


def lan_address() -> str:
    """This Mac's address on the home network (a private one); no packet is sent to find it. With a VPN as
    the way out, the address would be the VPN's, so the upload is not opened."""
    if _default_interface().startswith(("utun", "ipsec", "ppp", "tun")):
        raise UploadError("Hay una VPN activa: desconéctala para subir desde el móvil por la wifi de casa.")
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
    busy: bool = False  # an upload is being read: one at a time
    closed: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)

    def close(self) -> None:
        with self.lock:
            if self.closed:
                return
            self.closed = True
        if self.server is not None:
            server = self.server

            def stop():
                server.shutdown()
                server.server_close()  # the port stops listening at once
            threading.Thread(target=stop, daemon=True).start()


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
    known = connection.execute("SELECT id, state FROM receipt WHERE sha256 = ?", (digest,)).fetchone()
    if known:
        if known["state"] == "filed":
            raise UploadError("Ese recibo ya está archivado.")
        connection.execute("UPDATE receipt SET state = 'pending', decided_at = NULL WHERE id = ?", (known["id"],))
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
        timeout = 15  # per read on the socket: a slow or silent client is dropped

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
            self.send_header("Connection", "close")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        def _valid(self) -> bool:
            path = self.path.encode("latin-1", "replace")
            ok = (hmac.compare_digest(path, f"/{token}".encode()) and not window.closed and time.time() < window.expires_at
                  and window.received is None)
            if not ok:
                self._send(404, "<p>Este enlace ya no sirve. Pide otro QR en AgoraOne.</p>")
            return ok

        def do_GET(self):
            if self._valid():
                self._send(200, FORM)

        def _body(self, length: int) -> bytes | None:
            """The whole body, within a total time limit (each read also has the socket's own limit)."""
            started, chunks, size = time.monotonic(), [], 0
            while size < length:
                chunk = self.rfile.read(min(64 * 1024, length - size))
                if not chunk or time.monotonic() - started > 120:
                    return None
                chunks.append(chunk)
                size += len(chunk)
            return b"".join(chunks)

        def do_POST(self):
            if not self._valid():
                return
            content_type = self.headers.get("Content-Type", "")
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if not content_type.startswith("multipart/form-data") or "boundary=" not in content_type:
                self._send(400, "<p>Envía el recibo desde el formulario.</p>")
                return
            if not 0 < length <= MAX_FILE + 64 * 1024:
                self._send(413, "<p>El archivo es demasiado grande (máximo 15 MB).</p>")
                return
            with window.lock:  # one upload at a time, reserved before reading anything
                if window.busy or window.received is not None:
                    self._send(409, "<p>Ya se está subiendo un recibo con este enlace.</p>")
                    return
                window.busy = True
            try:
                body = self._body(length)
                boundary = content_type.split("boundary=", 1)[1].split(";")[0].strip().strip('"').encode()
                if body is None or body.count(b"--" + boundary) > 4:
                    self._send(400, "<p>No llegó el archivo completo. Vuelve atrás e inténtalo de nuevo.</p>")
                    return
                found = _multipart_file(content_type, body)
                if found is None:
                    self._send(400, "<p>No llegó ningún archivo. Vuelve atrás e inténtalo de nuevo.</p>")
                    return
                try:
                    received = store(found[1], found[0])
                except UploadError as error:
                    self._send(415, f"<p>{html.escape(str(error))}</p>")
                    return
                except Exception:  # noqa: BLE001 - the phone gets a plain answer and the link stays usable
                    self._send(500, "<p>No se pudo guardar en el Mac. Inténtalo otra vez.</p>")
                    return
                with window.lock:
                    window.received = received
            finally:
                with window.lock:
                    window.busy = False
            self._send(200, "<p>Recibido. Ya está en tu Mac, en la Bandeja de AgoraOne. Puedes cerrar esta página.</p>")
            window.close()

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        slots = threading.BoundedSemaphore(4)  # at most four connections at once: nobody can exhaust the core

        def process_request(self, request, client_address):
            if not self.slots.acquire(blocking=False):
                self.shutdown_request(request)
                return
            super().process_request(request, client_address)

        def process_request_thread(self, request, client_address):
            try:
                super().process_request_thread(request, client_address)
            finally:
                self.slots.release()

        def handle_error(self, request, client_address):  # nothing about the phone in the logs
            pass

    server = Server((host, 0), Handler)
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
             "fields": json.loads(r["fields"]), "uploadedAt": r["uploaded_at"], "source": r["source"], "inboxFolder": r["inbox_folder"]}
            for r in connection.execute("SELECT * FROM receipt WHERE state = ? ORDER BY uploaded_at DESC", (state,))]


def import_inbox(connection: sqlite3.Connection, folder: Path, folders: list[tuple[int, Path]]) -> int:
    """Brings the files waiting in each fiscal folder's «Recibos por revisar» in as pending receipts: a copy
    in AgoraOne's data (the original stays until it is filed), only photos and PDFs of bounded size, never a
    link or a hidden file. A receipt already known keeps its state: one dismissed does not come back."""
    added = 0
    for folder_id, root in folders:
        inbox = root / INBOX
        try:
            if inbox.is_symlink() or not inbox.is_dir() or root not in inbox.resolve().parents:
                continue
            entries = sorted(inbox.iterdir())
        except OSError:
            continue
        for path in entries[:200]:
            try:
                if path.is_symlink() or not path.is_file() or path.name.startswith(".") or path.stat().st_size > MAX_FILE:
                    continue
                data = path.read_bytes()
            except OSError:
                continue
            kind = media_type(data)
            if kind is None:
                continue
            digest = hashlib.sha256(data).hexdigest()
            if connection.execute("SELECT 1 FROM receipt WHERE sha256 = ?", (digest,)).fetchone():
                continue
            folder.mkdir(parents=True, exist_ok=True, mode=0o700)
            file = f"{digest[:24]}{SUFFIXES[kind]}"
            (folder / file).write_bytes(data)
            (folder / file).chmod(0o600)
            connection.execute(
                "INSERT INTO receipt (file, original_name, media_type, bytes, sha256, uploaded_at, source, inbox_folder, inbox_name) "
                "VALUES (?, ?, ?, ?, ?, ?, 'inbox', ?, ?)",
                (file, path.name[:200], kind, len(data), digest, now(), folder_id, path.name[:255]))
            added += 1
    return added


def remove_from_inbox(root: Path, name: str, digest: str) -> bool:
    """Once filed, the original leaves «Recibos por revisar» (a copy stays in AgoraOne's data and the filed
    one in its quarter). Only the very same file: a changed or replaced one is left where it is."""
    path = root / INBOX / name
    try:
        if path.is_symlink() or not path.is_file() or path.parent.resolve() != (root / INBOX).resolve():
            return False
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            return False
        path.unlink()
        return True
    except OSError:
        return False
