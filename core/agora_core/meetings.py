"""Recording a meeting in two tracks: your microphone, sent by the interface in short pieces while it shows
that it is recording, and what the computer plays, recorded here by the system's adapter (`system_audio`).
Nothing records in the background unnoticed: when the interface stops sending the microphone (closed,
crashed, asleep) the recording stops by itself, and a meeting left «recording» by a core that died is
marked interrupted on the next start. The audio lives in AgoraOne's data, never in the vault, until deleted."""

import json
import shutil
import sqlite3
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

from . import system_audio
from .db import now, transaction

MIC_TYPES = {"audio/webm": "webm", "audio/mp4": "mp4", "audio/ogg": "ogg"}
LEVELS = {"normal", "local_only", "private"}
PIECE_BYTES = 1024 * 1024
MAX_MIC_BYTES = 300 * 1024 * 1024  # about 20 hours at the 32 kbps the interface records
MAX_HOURS = 4
SILENT_AFTER = 45.0  # seconds without a piece of microphone before the recording stops by itself
WATCH_EVERY = 5.0


class MeetingError(RuntimeError):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


class Recorder:
    """The meetings being recorded now, in this process (at most one at a time)."""

    def __init__(self, data_dir: Path, connect):
        self.root = data_dir / "meetings"
        self.connect = connect
        self.lock = threading.Lock()
        self.live: dict[int, dict] = {}
        self.watch: threading.Thread | None = None
        self.on_recorded = None  # called with (meeting id) when a recording ends, e.g. to transcribe it at once

    def folder(self, meeting_id: int) -> Path:
        return self.root / str(int(meeting_id))

    # --- reading -------------------------------------------------------------------------------------------
    def view(self, row: sqlite3.Row) -> dict:
        item = {k: row[k] for k in ("id", "title", "confidentiality", "status", "started_at", "ended_at", "mic_bytes", "system_source", "system_bytes", "note",
                                    "work", "work_error", "summary_by")}
        item["has_transcript"] = bool(row["transcript"])
        item["saved_note"] = json.loads(row["saved_note"]) if row["saved_note"] else None
        ended = row["ended_at"] or now()
        item["seconds"] = max(0, int((_parse(ended) - _parse(row["started_at"])).total_seconds()))
        return item

    def list(self, connection: sqlite3.Connection, owner: str) -> list[dict]:
        rows = connection.execute("SELECT * FROM meeting WHERE owner = ? ORDER BY started_at DESC, id DESC LIMIT 200", (owner,)).fetchall()
        return [self.view(r) for r in rows]

    def owned(self, connection: sqlite3.Connection, owner: str, meeting_id: int) -> sqlite3.Row:
        row = connection.execute("SELECT * FROM meeting WHERE id = ? AND owner = ?", (meeting_id, owner)).fetchone()
        if not row:
            raise MeetingError("Esa reunión no existe.", 404)
        return row

    def recover(self, connection: sqlite3.Connection) -> None:
        """Meetings a previous core left recording: whatever reached the disk stays, marked interrupted."""
        with self.lock:
            live = set(self.live)
        rows = connection.execute("SELECT id FROM meeting WHERE status = 'recording'").fetchall()
        with transaction(connection):
            for row in rows:
                if row["id"] not in live:
                    connection.execute("UPDATE meeting SET status = 'interrupted', ended_at = COALESCE(ended_at, ?), note = COALESCE(note, ?) WHERE id = ?",
                                       (now(), "AgoraOne se cerró mientras grababa; se conserva lo grabado hasta entonces.", row["id"]))

    # --- recording -----------------------------------------------------------------------------------------
    def start(self, connection: sqlite3.Connection, owner: str, title: str, confidentiality: str, mic_type: str, system: bool) -> dict:
        title = " ".join((title or "").split())[:200] or f"Reunión del {datetime.now().strftime('%d/%m/%Y %H:%M')}"
        if confidentiality not in LEVELS:
            raise MeetingError("Nivel de confidencialidad no válido.")
        kind = MIC_TYPES.get((mic_type or "").split(";")[0].strip().lower())
        if not kind:
            raise MeetingError("Ese formato de audio no se puede grabar.")
        with self.lock:
            if self.live:
                raise MeetingError("Ya hay una reunión grabándose.", 409)
            with transaction(connection):
                meeting_id = connection.execute("INSERT INTO meeting (owner, title, confidentiality, status, started_at, mic_type) VALUES (?, ?, ?, 'recording', ?, ?)",
                                                (owner, title, confidentiality, now(), kind)).lastrowid
            folder = self.folder(meeting_id)
            folder.mkdir(parents=True, mode=0o700)
            (folder / f"microfono.{kind}").touch(mode=0o600)
            capture, note = None, None
            if system:
                try:
                    capture = system_audio.start(folder / "sistema")
                except system_audio.SystemAudioError as error:
                    note = str(error)
            else:
                note = "Solo se graba tu micrófono (elegido así al empezar)."
            with transaction(connection):
                connection.execute("UPDATE meeting SET system_source = ?, system_file = ?, note = ? WHERE id = ?",
                                   (capture.source if capture else None, capture.path.name if capture else None, note, meeting_id))
            self.live[meeting_id] = {"capture": capture, "owner": owner, "seen": time.monotonic(), "began": time.monotonic()}
            self._watch()
        return self.view(self.owned(connection, owner, meeting_id))

    def piece(self, connection: sqlite3.Connection, owner: str, meeting_id: int, audio: bytes) -> dict:
        """One piece of the microphone, in order; it is also the sign that the interface is still recording."""
        if len(audio) > PIECE_BYTES:
            raise MeetingError("Ese trozo de audio es demasiado grande.", 413)
        row = self.owned(connection, owner, meeting_id)
        with self.lock:
            session = self.live.get(meeting_id)
            if not session or row["status"] != "recording":
                raise MeetingError("Esta reunión ya no se está grabando.", 409)
            if row["mic_bytes"] + len(audio) > MAX_MIC_BYTES:
                raise MeetingError("La grabación del micrófono es demasiado larga.", 413)
            with open(self.folder(meeting_id) / f"microfono.{row['mic_type']}", "ab") as file:
                file.write(audio)
            session["seen"] = time.monotonic()
            with transaction(connection):
                connection.execute("UPDATE meeting SET mic_bytes = mic_bytes + ? WHERE id = ?", (len(audio), meeting_id))
        return {"bytes": row["mic_bytes"] + len(audio)}

    def stop(self, connection: sqlite3.Connection, owner: str, meeting_id: int, note: str | None = None) -> dict:
        row = self.owned(connection, owner, meeting_id)
        with self.lock:
            session = self.live.pop(meeting_id, None)
        if session is None:
            if row["status"] == "recording":
                self.recover(connection)
            return self.view(self.owned(connection, owner, meeting_id))
        system_bytes = system_audio.stop(session["capture"]) if session["capture"] else 0
        with transaction(connection):
            connection.execute("UPDATE meeting SET status = 'recorded', ended_at = ?, system_bytes = ?, note = COALESCE(?, note) WHERE id = ?",
                               (now(), system_bytes, note, meeting_id))
        if self.on_recorded:
            try:
                self.on_recorded(connection, meeting_id)
            except Exception:  # noqa: BLE001 - the recording is safe; processing can be started by hand
                pass
        return self.view(self.owned(connection, owner, meeting_id))

    def stop_all(self) -> None:
        with self.lock:
            ids = [(i, s["owner"]) for i, s in self.live.items()]
        for meeting_id, owner in ids:
            connection = self.connect()
            try:
                self.stop(connection, owner, meeting_id, "Se detuvo al cerrarse AgoraOne.")
            finally:
                connection.close()

    def _watch(self) -> None:
        if self.watch and self.watch.is_alive():
            return
        self.watch = threading.Thread(target=self._watching, daemon=True)
        self.watch.start()

    def _watching(self) -> None:
        while True:
            time.sleep(WATCH_EVERY)
            with self.lock:
                if not self.live:
                    return
                due = [(i, s["owner"], "La grabación se detuvo sola: la pantalla de AgoraOne dejó de enviar el micrófono." if time.monotonic() - s["seen"] > SILENT_AFTER
                        else f"La grabación se detuvo al llegar a {MAX_HOURS} horas.") for i, s in self.live.items()
                       if time.monotonic() - s["seen"] > SILENT_AFTER or time.monotonic() - s["began"] > MAX_HOURS * 3600]
            for meeting_id, owner, note in due:
                connection = self.connect()
                try:
                    self.stop(connection, owner, meeting_id, note)
                finally:
                    connection.close()

    # --- deleting ------------------------------------------------------------------------------------------
    def delete(self, connection: sqlite3.Connection, owner: str, meeting_id: int) -> None:
        if self.owned(connection, owner, meeting_id)["work"] in ("transcribing", "summarizing"):
            raise MeetingError("Se está transcribiendo; bórrala cuando termine.", 409)
        with self.lock:
            if meeting_id in self.live:
                raise MeetingError("Para borrarla, para antes la grabación.", 409)
        folder = self.folder(meeting_id)
        if folder.resolve().parent != self.root.resolve():
            raise MeetingError("Esa reunión no existe.", 404)
        shutil.rmtree(folder, ignore_errors=True)
        with transaction(connection):
            connection.execute("DELETE FROM meeting WHERE id = ? AND owner = ?", (meeting_id, owner))


def _parse(stamp: str) -> datetime:
    return datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
