"""HTTP routes of the fiscal folder and the received invoices. Preparing only reads (the message again,
read-only, and its PDF); filing, downloading a link and tidying the folder happen only on the user's
explicit request with the exact fields or moves they saw."""

import json
import sqlite3
from contextlib import contextmanager
from typing import Literal

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictInt

from . import fiscal, fiscal_folder, invoice_extract, mail
from .db import DB_NAME, connect, now
from .routes_mail import microsoft_login
from .settings import Settings


class FolderIn(BaseModel):
    folder: str | None = Field(default=None, max_length=1000)


class PrepareIn(BaseModel):
    messageId: StrictInt


class Source(BaseModel):
    kind: Literal["attachment", "link"]
    part: StrictInt | None = None
    url: str | None = Field(default=None, max_length=500)


class Fields(BaseModel):
    supplier: str = Field(min_length=1, max_length=120)
    taxId: str | None = Field(default=None, max_length=20)
    issuedOn: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    total: str = Field(min_length=1, max_length=20)
    base: str | None = Field(default=None, max_length=20)
    vat: str | None = Field(default=None, max_length=20)
    currency: str = Field(default="EUR", pattern=r"^[A-Za-z]{3}$")
    notes: str | None = Field(default=None, max_length=500)


class FileIn(BaseModel):
    messageId: StrictInt
    source: Source
    fields: Fields
    doubts: list[str] = Field(default_factory=list, max_length=10)


class ApplyIn(BaseModel):
    moves: list[str] = Field(min_length=1, max_length=fiscal_folder.MAX_MOVES)


def fiscal_router(settings: Settings, secrets) -> APIRouter:
    router = APIRouter()

    @contextmanager
    def database():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            yield connection
        finally:
            connection.close()

    async def db(work):
        def task():
            with database() as connection:
                return work(connection)
        return await run_in_threadpool(task)

    def refuse(error: Exception, status: int = 422):
        return JSONResponse({"error": str(error)}, status_code=status)

    def notice_of(connection: sqlite3.Connection, message_id: int):
        return connection.execute(
            """SELECT m.id, m.account_id, m.from_name, m.from_address, m.subject, m.body, m.sent_at, m.attachments,
                      COALESCE(s.details, '{}') AS details FROM mail_message m LEFT JOIN mail_summary s ON s.message_id = m.id WHERE m.id = ?""",
            (message_id,),
        ).fetchone()

    def raw_of(connection: sqlite3.Connection, notice) -> bytes:
        password = secrets.get(mail.secret_account(notice["account_id"])) if secrets else None
        return mail.fetch_raw(connection, notice["id"], password, login=microsoft_login(connection, secrets))

    @router.get("/fiscal/folder")
    async def get_folder():
        found = await db(fiscal.folder)
        return {"folder": str(found) if found else None}

    @router.put("/fiscal/folder")
    async def put_folder(body: FolderIn):
        try:
            chosen = await db(lambda c: fiscal.save_folder(c, body.folder))
        except fiscal.FiscalError as error:
            return refuse(error)
        return {"folder": str(chosen) if chosen else None}

    @router.post("/fiscal/invoices/prepare")
    async def prepare(body: PrepareIn):
        def work(connection):
            root = fiscal.folder(connection)
            if root is None:
                raise fiscal.FiscalError("Elige primero la carpeta fiscal en Ajustes.")
            notice = notice_of(connection, body.messageId)
            if notice is None:
                raise fiscal.FiscalError("Ese correo ya no está guardado.")
            details = json.loads(notice["details"])
            pdfs = [a for a in json.loads(notice["attachments"]) if a["type"] == "application/pdf" or a["name"].lower().endswith(".pdf")]
            found, source, name = {}, None, None
            if pdfs:
                raw = raw_of(connection, notice)
                name, data = invoice_extract.attachment(raw, pdfs[0]["part"])
                found = invoice_extract.fields(invoice_extract.pdf_text(data))
                source = {"kind": "attachment", "part": pdfs[0]["part"], "name": name}
            links = invoice_extract.links(notice["body"])
            supplier = (notice["from_name"] or (notice["from_address"] or "").split("@")[-1]).strip()[:120]
            proposal = {"supplier": supplier, "taxId": found.get("taxId"), "issuedOn": found.get("issuedOn") or (notice["sent_at"] or now())[:10],
                        "total": found.get("total") or fiscal.amount((details.get("amounts") or [None])[0]) or "",
                        "currency": found.get("currency") or "EUR"}
            doubts = invoice_extract.doubts(found, details) if source else ["La factura no viene adjunta: descárgala del enlace o de la web del proveedor."]
            destination = fiscal.destination(proposal["supplier"] or "Proveedor", proposal["issuedOn"], fiscal.amount(proposal["total"]) or "0.00")
            return {"source": source, "links": [{"url": u, "host": u.split("/")[2]} for u in links], "proposal": proposal,
                    "doubts": doubts, "destination": destination}
        try:
            return await db(work)
        except (fiscal.FiscalError, mail.MailError, invoice_extract.ExtractError) as error:
            return refuse(error)

    @router.post("/fiscal/invoices", status_code=201)
    async def file(body: FileIn):
        def work(connection):
            root = fiscal.folder(connection)
            if root is None:
                raise fiscal.FiscalError("Elige primero la carpeta fiscal en Ajustes.")
            notice = notice_of(connection, body.messageId)
            if notice is None:
                raise fiscal.FiscalError("Ese correo ya no está guardado.")
            if body.source.kind == "attachment":
                if body.source.part is None:
                    raise fiscal.FiscalError("Falta el adjunto.")
                _, data = invoice_extract.attachment(raw_of(connection, notice), body.source.part)
            else:
                # Only a link that is in this very message can be downloaded.
                if not body.source.url or body.source.url not in invoice_extract.links(notice["body"]):
                    raise fiscal.FiscalError("Ese enlace no está en el correo.")
                data = invoice_extract.download(body.source.url)
            filed = fiscal.file_invoice(connection, root, data, body.fields.model_dump(), body.messageId, body.doubts)
            connection.execute("UPDATE mail_summary SET state = 'done', decided_at = ? WHERE message_id = ? AND state = 'pending'",
                               (now(), body.messageId))
            return filed
        try:
            return await db(work)
        except (fiscal.FiscalError, mail.MailError, invoice_extract.ExtractError) as error:
            return refuse(error)
        except FileExistsError:
            return refuse(fiscal.FiscalError("Ya hay un archivo con ese nombre; vuelve a intentarlo."), 409)

    @router.get("/fiscal/invoices")
    async def list_invoices(quarter: str | None = None):
        return {"invoices": await db(lambda c: fiscal.invoices(c, quarter))}

    @router.get("/fiscal/folder/plan")
    async def folder_plan():
        def work(connection):
            root = fiscal.folder(connection)
            if root is None:
                raise fiscal.FiscalError("Elige primero la carpeta fiscal en Ajustes.")
            return fiscal_folder.plan(root)
        try:
            return await db(work)
        except fiscal.FiscalError as error:
            return refuse(error)

    @router.post("/fiscal/folder/apply")
    async def folder_apply(body: ApplyIn):
        def work(connection):
            root = fiscal.folder(connection)
            if root is None:
                raise fiscal.FiscalError("Elige primero la carpeta fiscal en Ajustes.")
            result = fiscal_folder.apply(root, settings.data_dir / "fiscal-backups", body.moves)
            # Filed invoices that moved keep pointing at their file.
            for move in result["moved"]:
                connection.execute("UPDATE invoice SET path = ? WHERE path = ?", (move["to"], move["from"]))
            return result
        try:
            return await db(work)
        except fiscal.FiscalError as error:
            return refuse(error)

    return router
