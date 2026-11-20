"""Routes for what a mail brings to its note: the list of attachments and shared documents, one file for the
vault (the screen hands it to the vault's own writer) and one file saved straight into the project's repository.
Everything only for the mail the note comes from, and only what the user ticked."""

from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from . import invoice_extract, mail, modules, note_sources, repo_notes
from .db import DB_NAME, connect
from .routes_mail import microsoft_login
from .settings import Settings
from . import system_words


class SourceFile(BaseModel):
    kind: Literal["attachment", "link"]
    part: int | None = None
    url: str | None = None


class RepoFile(SourceFile):
    client: str
    project: str
    folder: str
    name: str = ""  # for an attachment, the exact name the note links to; a shared document keeps its own after «prefix - »
    prefix: str
    inboxId: int


def note_sources_router(settings: Settings, secrets) -> APIRouter:
    router = APIRouter()

    def message(connection, message_id: int):
        row = connection.execute("SELECT m.id, m.account_id, m.body, m.attachments, m.moved FROM mail_message m JOIN mail_summary s ON s.message_id = m.id "
                                 "WHERE m.id = ?", (message_id,)).fetchone()
        if row is None or row["moved"]:
            raise note_sources.SourceError("Ese correo ya no está en la Bandeja.")
        return row

    def fetch(connection, message_id: int, body: SourceFile) -> tuple[str, bytes]:
        row = message(connection, message_id)
        if body.kind == "link":
            if not body.url or body.url not in [link["url"] for link in note_sources.links(row["body"])]:
                raise note_sources.SourceError("Ese enlace no está en el correo.")
            return note_sources.download(body.url)
        listed = {a["part"]: a for a in note_sources.attachments(row["attachments"])}
        if body.part not in listed:
            raise note_sources.SourceError("Ese adjunto no está en el correo.")
        password = secrets.get(mail.secret_account(row["account_id"])) if secrets else None
        try:
            raw = mail.fetch_raw(connection, message_id, password, login=microsoft_login(connection, secrets))
            _, data = invoice_extract.attachment(raw, body.part)
        except (mail.MailError, invoice_extract.ExtractError) as error:
            raise note_sources.SourceError(str(error)) from error
        if not data or len(data) > note_sources.MAX_FILE:
            raise note_sources.SourceError("El adjunto está vacío o es demasiado grande (más de 25 MB).")
        return listed[body.part]["name"], data

    def refuse(message_text: str):
        return JSONResponse({"error": message_text}, status_code=422)

    @router.get("/mail/inbox/{message_id}/sources")
    async def sources(message_id: int):
        def run():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                row = message(connection, message_id)
                return {"attachments": note_sources.attachments(row["attachments"]), "links": note_sources.links(row["body"])}
            finally:
                connection.close()
        try:
            return await run_in_threadpool(run)
        except note_sources.SourceError as error:
            return refuse(str(error))

    @router.post("/mail/inbox/{message_id}/file")
    async def source_file(message_id: int, body: SourceFile):
        """The bytes of one attachment or ticked shared document, for the vault's own writer; nothing is kept here."""
        def run():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                return fetch(connection, message_id, body)
            finally:
                connection.close()
        try:
            name, data = await run_in_threadpool(run)
        except note_sources.SourceError as error:
            return refuse(str(error))
        return Response(data, media_type="application/octet-stream", headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})

    @router.post("/orca/repo-file", status_code=201)
    async def repo_file(body: RepoFile):
        """One attachment or ticked shared document, saved as a new file next to the note in the repository."""
        def run():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                if not modules.state(connection)["orca"]:
                    raise repo_notes.RepoNoteError("El módulo Orca está apagado en Ajustes.")
                if repo_notes.mail_level(connection, body.inboxId) != "normal":
                    raise repo_notes.RepoNoteError(f"Ese correo es privado o «solo en {system_words.HERE}»: sus archivos no van a un repositorio.")
                _, root = repo_notes.local_root(connection, body.client, body.project)
                name, data = fetch(connection, body.inboxId, body)
            finally:
                connection.close()
            final = body.name if body.kind == "attachment" and body.name else note_sources.safe_name(f"{body.prefix} - {name}")
            return {"path": repo_notes.save_file(root, body.folder, final, data)}
        try:
            return await run_in_threadpool(run)
        except (repo_notes.RepoNoteError, note_sources.SourceError) as error:
            return refuse(str(error))
        except (OSError, UnicodeError):
            return refuse("No se pudo escribir el archivo en el repositorio.")

    return router
