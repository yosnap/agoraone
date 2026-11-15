"""HTTP routes of the fiscal folder and the received invoices. Preparing only reads (the message again,
read-only, and its PDF); filing, downloading a link and tidying the folder happen only on the user's
explicit request with the exact fields or moves they saw."""

import asyncio
import json
import re
import sqlite3
from contextlib import aclosing
from contextlib import contextmanager
from datetime import datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictBool, StrictInt

from . import exchange, invoice_ai, fiscal, fiscal_excel, fiscal_folder, fiscal_manual, fiscal_scan, invoice_extract, mail, qonto, receipts
from .db import DB_NAME, connect, now, transaction
from .engines import AnthropicApiEngine, ClaudeCodeEngine, Turn, ask_with_image, usable
from .routes_mail import microsoft_login
from .settings import Settings


MADRID = ZoneInfo("Europe/Madrid")


Kind = Literal["autonomo", "empresa", "personal"]
Category = Literal["gastos", "compras"]


class FolderIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    kind: Kind
    path: str = Field(min_length=1, max_length=1000)
    scopeId: StrictInt | None = None


class FolderChange(BaseModel):
    holder: str | None = Field(default=None, max_length=120)
    name: str | None = Field(default=None, min_length=1, max_length=80)
    kind: Kind | None = None
    scopeId: StrictInt | None = None


class ReceiptChange(BaseModel):
    state: Literal["pending", "dismissed"]


class PrepareIn(BaseModel):
    messageId: StrictInt


class Source(BaseModel):
    kind: Literal["attachment", "link"]
    part: StrictInt | None = None
    url: str | None = Field(default=None, max_length=500)


class Fields(BaseModel):
    supplier: str = Field(min_length=1, max_length=120)
    taxId: str | None = Field(default=None, min_length=4, max_length=20)
    issuedOn: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    total: str = Field(min_length=1, max_length=20)
    base: str | None = Field(default=None, max_length=20)
    vat: str | None = Field(default=None, max_length=20)
    currency: str = Field(default="EUR", pattern=r"^[A-Za-z]{3}$")
    notes: str | None = Field(default=None, max_length=500)


class FileIn(BaseModel):
    messageId: StrictInt
    folderId: StrictInt
    category: Category | None = None
    source: Source
    fields: Fields
    doubts: list[Annotated[str, Field(max_length=300)]] = Field(default_factory=list, max_length=10)


class Move(BaseModel):
    from_: str = Field(alias="from", max_length=1000)
    to: str = Field(max_length=1000)


class ReceiptFileIn(BaseModel):
    folderId: StrictInt
    category: Category | None = None
    fields: Fields


class QontoIn(BaseModel):
    login: str | None = Field(default=None, max_length=120)
    # A new secret key replaces the stored one; an explicit null forgets it. Never returned.
    secret: str | None = Field(default=None, min_length=8, max_length=200)


class QuarterIn(BaseModel):
    year: StrictInt = Field(ge=2000, le=2100)
    quarter: StrictInt = Field(ge=1, le=4)


class OpenIn(BaseModel):
    path: str | None = Field(default=None, max_length=1000)
    reveal: StrictBool = False


class QontoDownloadIn(BaseModel):
    year: StrictInt = Field(ge=2000, le=2100)
    quarter: StrictInt = Field(ge=1, le=4)
    numbers: list[Annotated[str, Field(max_length=60)]] = Field(min_length=1, max_length=200)


class ReadingIn(BaseModel):
    withClaude: StrictBool


class ManualFields(BaseModel):
    name: Annotated[str, Field(max_length=120)] | None = None
    taxId: Annotated[str, Field(max_length=30)] | None = None
    number: Annotated[str, Field(max_length=40)] | None = None
    issuedOn: Annotated[str, Field(max_length=10)]
    base: Annotated[str, Field(max_length=20)] | None = None
    vatRate: Annotated[str, Field(max_length=6)] | None = None
    vat: Annotated[str, Field(max_length=20)] | None = None
    withholdingRate: Annotated[str, Field(max_length=6)] | None = None
    withholding: Annotated[str, Field(max_length=20)] | None = None
    total: Annotated[str, Field(max_length=20)]
    currency: Annotated[str, Field(max_length=3)] | None = None


class ManualIn(BaseModel):
    path: Annotated[str, Field(min_length=1, max_length=1000)]
    fields: ManualFields


class ApplyIn(BaseModel):
    moves: list[Move] = Field(min_length=1, max_length=fiscal_folder.MAX_MOVES)


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

    def folders_reply(connection):
        return {"folders": fiscal.folders(connection)}

    @router.get("/fiscal/folders")
    async def list_folders():
        return await db(folders_reply)

    @router.post("/fiscal/folders/choose")
    async def choose_folder():
        """The macOS folder chooser, on this Mac; returns the path picked (or null)."""
        try:
            return {"path": await run_in_threadpool(fiscal.choose_with_finder)}
        except fiscal.FiscalError as error:
            return refuse(error, 409)

    @router.post("/fiscal/folders", status_code=201)
    async def add_folder(body: FolderIn):
        try:
            return await db(lambda c: (fiscal.add_folder(c, body.name, body.kind, body.path, body.scopeId), folders_reply(c))[1])
        except fiscal.FiscalError as error:
            return refuse(error)

    @router.put("/fiscal/folders/{folder_id}")
    async def change_folder(folder_id: int, body: FolderChange):
        try:
            found = await db(lambda c: fiscal.change_folder(c, folder_id, body.model_dump(exclude_unset=True)))
        except fiscal.FiscalError as error:
            return refuse(error)
        if not found:
            return refuse(fiscal.FiscalError("Esa carpeta fiscal no existe."), 404)
        return await db(folders_reply)

    @router.delete("/fiscal/folders/{folder_id}")
    async def remove_folder(folder_id: int):
        if not await db(lambda c: fiscal.remove_folder(c, folder_id)):
            return refuse(fiscal.FiscalError("Esa carpeta fiscal no existe."), 404)
        return await db(folders_reply)

    @router.post("/fiscal/invoices/prepare")
    async def prepare(body: PrepareIn):
        def work(connection):
            known = fiscal.folders(connection)
            if not known:
                raise fiscal.FiscalError("Añade primero una carpeta fiscal en Ajustes.")
            notice = notice_of(connection, body.messageId)
            if notice is None:
                raise fiscal.FiscalError("Ese correo ya no está guardado.")
            details = json.loads(notice["details"])
            pdfs = [a for a in json.loads(notice["attachments"]) if a["type"] == "application/pdf" or a["name"].lower().endswith(".pdf")]
            found, source, sources, problem = {}, None, [], None
            if pdfs:
                try:
                    raw = raw_of(connection, notice)
                    sources = [{"kind": "attachment", "part": a["part"], "name": a["name"]} for a in pdfs[:5]]
                    _, data = invoice_extract.attachment(raw, pdfs[0]["part"])
                    found = invoice_extract.fields(invoice_extract.pdf_text(data))
                    source = sources[0]
                except (mail.MailError, invoice_extract.ExtractError) as error:
                    problem = str(error)  # the links may still work
            links = invoice_extract.links(notice["body"])
            supplier = (notice["from_name"] or (notice["from_address"] or "").split("@")[-1]).strip()[:120]
            # Without a date in the invoice, the day it was sent, in Spain (UTC would move 1 January to the year before).
            sent = notice["sent_at"] or now()
            local_day = datetime.fromisoformat(sent.replace("Z", "+00:00")).astimezone(MADRID).date().isoformat()
            proposal = {"supplier": supplier, "taxId": found.get("taxId"), "issuedOn": found.get("issuedOn") or local_day,
                        "total": found.get("total") or fiscal.amount((details.get("amounts") or [None])[0]) or "",
                        "currency": found.get("currency") or "EUR"}
            doubts = invoice_extract.doubts(found, details) if source else ["La factura no viene adjunta: descárgala del enlace o de la web del proveedor."]
            if problem:
                doubts.insert(0, problem)
            suggested = fiscal.suggested_folder(connection, notice["id"])
            kind = next((f["kind"] for f in known if f["id"] == suggested), "autonomo")
            destination = fiscal.destination(proposal["supplier"] or "Proveedor", proposal["issuedOn"], fiscal.amount(proposal["total"]) or "0.00",
                                             kind, "gastos")
            return {"folders": known, "folderId": suggested, "source": source, "sources": sources, "links": [{"url": u, "host": u.split("/")[2]} for u in links], "proposal": proposal,
                    "doubts": doubts, "destination": destination}
        try:
            return await db(work)
        except (fiscal.FiscalError, mail.MailError, invoice_extract.ExtractError) as error:
            return refuse(error)

    @router.post("/fiscal/invoices", status_code=201)
    async def file(body: FileIn):
        def work(connection):
            folder, root = fiscal.folder_root(connection, body.folderId)
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
            with transaction(connection):
                filed = fiscal.file_invoice(connection, folder, root, data, body.fields.model_dump(), body.messageId, body.doubts, body.category)
                connection.execute("UPDATE mail_summary SET state = 'done', decided_at = ? WHERE message_id = ? AND state = 'pending'",
                                   (now(), body.messageId))
            return filed
        try:
            return await db(work)
        except fiscal.Duplicate as error:
            return refuse(error, 409)
        except (fiscal.FiscalError, mail.MailError, invoice_extract.ExtractError) as error:
            return refuse(error)
        except FileExistsError:
            return refuse(fiscal.FiscalError("Ya hay un archivo con ese nombre; vuelve a intentarlo."), 409)

    @router.get("/fiscal/invoices")
    async def list_invoices(quarter: str | None = None, folderId: int | None = None):
        return {"invoices": await db(lambda c: fiscal.invoices(c, quarter, folderId))}

    def professional_root(connection, folder_id: int):
        folder, root = fiscal.folder_root(connection, folder_id)
        if folder["kind"] == "personal":
            raise fiscal.FiscalError("Las carpetas personales no se ordenan por trimestre.")
        return folder, root

    @router.get("/fiscal/folders/{folder_id}/plan")
    async def folder_plan(folder_id: int):
        def work(connection):
            return fiscal_folder.plan(professional_root(connection, folder_id)[1])
        try:
            return await db(work)
        except fiscal.FiscalError as error:
            return refuse(error)

    @router.post("/fiscal/folders/{folder_id}/apply")
    async def folder_apply(folder_id: int, body: ApplyIn):
        def work(connection):
            _, root = professional_root(connection, folder_id)

            # Filed invoices that move keep pointing at their file, move by move (even if a later one fails).
            def moved(old: str, new: str) -> None:
                connection.execute("UPDATE invoice SET path = ? WHERE path = ? AND folder_id = ?", (new, old, folder_id))
            chosen = [{"from": m.from_, "to": m.to} for m in body.moves]
            return fiscal_folder.apply(root, settings.data_dir / "fiscal-backups", chosen, on_move=moved)
        try:
            return await db(work)
        except fiscal.FiscalError as error:
            return refuse(error)

    # Qonto (read-only) and the quarterly register.
    def qonto_auth(connection) -> str | None:
        name = qonto.login(connection)
        key = secrets.get(qonto.SECRET_ACCOUNT) if secrets else None
        return f"{name}:{key}" if name and key else None

    @router.get("/fiscal/qonto")
    async def qonto_settings():
        name = await db(qonto.login)
        has_key = bool(await run_in_threadpool(secrets.get, qonto.SECRET_ACCOUNT)) if secrets else False
        return {"login": name, "hasKey": has_key}

    @router.put("/fiscal/qonto")
    async def save_qonto(body: QontoIn):
        try:
            if "login" in body.model_fields_set:
                await db(lambda c: qonto.save_login(c, body.login))
        except qonto.QontoError as error:
            return refuse(error)
        if "secret" in body.model_fields_set and secrets:
            try:
                secret = qonto.clean_secret(body.secret) if body.secret else None
            except qonto.QontoError as error:
                return refuse(error)
            await run_in_threadpool(secrets.put, qonto.SECRET_ACCOUNT, secret)
        return await qonto_settings()

    @router.post("/fiscal/qonto/check")
    async def check_qonto():
        auth = await db(qonto_auth)
        if not auth:
            return refuse(qonto.QontoError("Falta el identificador o la clave secreta de Qonto."))
        try:
            return await run_in_threadpool(qonto.check, auth)
        except qonto.QontoError as error:
            return refuse(error, 502)

    def reading_on(connection) -> bool:
        row = connection.execute("SELECT value FROM setting WHERE key = 'fiscal.readWithClaude'").fetchone()
        return not (row and json.loads(row["value"]) is False)

    def invoice_reader(connection):
        """Claude Haiku reads the invoices (user's choice in Ajustes, on by default), through the user's Claude
        Code session or else the Anthropic API; None means local rules only."""
        if not reading_on(connection):
            return None
        engines = [e for e in usable([ClaudeCodeEngine(settings.data_dir / "claude-code"), AnthropicApiEngine(secrets)])
                   if e.name in ("claude-code", "anthropic-api")]
        if not engines:
            return None

        def first_answer(call):
            """The first engine that answers (the Claude Code session, then the API key); the last error if none."""
            error: Exception | None = None
            for engine in engines:
                try:
                    return asyncio.run(call(engine))
                except Exception as failure:  # noqa: BLE001 - try the next engine
                    error = failure
            raise error or RuntimeError("Sin motor")

        def ask(texts: list[str]) -> dict:
            async def run(engine):
                parts = []
                turn = Turn(invoice_ai.SYSTEM, [{"role": "user", "content": invoice_ai.prompt(texts)}], "haiku")
                async with aclosing(engine.stream(turn)) as stream:
                    async for text in stream:
                        if text:
                            parts.append(text)
                return "".join(parts)
            return invoice_ai.parse(first_answer(run), len(texts))

        def image(jpeg: bytes) -> dict | None:
            text = "Extrae los datos de este documento (es la imagen: trátala como el documento n=1)."
            return invoice_ai.parse(first_answer(lambda engine: ask_with_image(engine, invoice_ai.SYSTEM, text, jpeg)), 1).get(1)
        def allowed() -> bool:  # turning it off in Ajustes stops a reading already under way
            with database() as current:
                return reading_on(current)
        ask.image, ask.allowed = image, allowed
        return ask

    @router.get("/fiscal/reading")
    async def reading_setting():
        row = await db(lambda c: c.execute("SELECT value FROM setting WHERE key = 'fiscal.readWithClaude'").fetchone())
        return {"withClaude": True if row is None else bool(json.loads(row["value"]))}

    @router.put("/fiscal/reading")
    async def save_reading(body: ReadingIn):
        def work(connection):
            connection.execute("INSERT INTO setting (key, value) VALUES ('fiscal.readWithClaude', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                               (json.dumps(body.withClaude),))
            # Read everything again with the new choice.
            connection.execute("DELETE FROM fiscal_file")
        await db(work)
        return {"withClaude": body.withClaude}

    def quarter_data(connection, folder_id: int, year: int, quarter: int) -> dict:
        folder, root = professional_root(connection, folder_id)
        start, end = fiscal_excel.quarter_range(year, quarter)
        filed = fiscal.invoices(connection, f"{year}-{quarter}T", folder_id)
        # The invoices already in the folder count too, wherever they sit; what AgoraOne filed is not counted twice.
        known_files = {r["sha256"] for r in connection.execute("SELECT sha256 FROM invoice WHERE folder_id = ?", (folder_id,))}
        found_income, found_expenses, pending, counts = fiscal_scan.scan(connection, folder_id, root, year, quarter, start.isoformat(),
                                                                         end.isoformat(), {e["path"] for e in filed}, known_files,
                                                                         use_model=reading_on(connection))
        reader = invoice_reader(connection)
        todo = pending + (counts["modelPending"] if reader else [])
        if todo:
            fiscal_scan.read_in_background(database, folder_id, root, todo, reader)
        in_flight, started = fiscal_scan.progress(folder_id)
        expenses = filed + found_expenses
        income, problem, notes = found_income, None, []
        auth = qonto_auth(connection)
        if not found_income:
            if auth:
                try:
                    income, notes = qonto.issued_invoices(auth, start, end)
                except qonto.QontoError as error:
                    problem = str(error)
            else:
                problem = "No hay facturas emitidas en «Facturas Salientes» para este trimestre."
        issues: list[dict] = []

        def issue(key: str, text: str, items: list[dict]) -> None:
            if items:
                issues.append({"key": key, "text": text.format(n=len(items)), "items": items[:500]})

        def files(paths: list[str]) -> list[dict]:
            return [{"label": p.split("/")[-1], "detail": "/".join(p.split("/")[:-1]), "path": p} for p in paths]

        def rows(found: list[dict], why) -> list[dict]:
            return [{"label": f"{r.get('supplier') or r.get('client') or ''} · {r.get('total') or '—'} {r.get('currency') or ''}".strip(" ·"),
                     "detail": why(r), "path": r.get("file") or r.get("path")} for r in found]
        if found_income and auth and not in_flight:
            try:  # the folder is the source; Qonto says which issued invoices are missing from it
                in_qonto = [r for r in qonto.issued_invoices(auth, start, end)[0] if r["number"]]
                taken: set[int] = set()
                missing_qonto = {r["number"]: r for r in in_qonto if not local_twin(r, found_income, taken)}
                issue("qonto", "Qonto tiene {n} facturas emitidas este trimestre que no están en «Facturas Salientes».",
                      [{"label": f"{r['number']} · {r['client']}", "detail": f"{r['date']} · {r.get('base')} {r['currency']}", "qonto": r["number"]}
                       for r in missing_qonto.values()])
            except qonto.QontoError:
                pass
        notes += exchange.to_eur(connection, expenses, "issuedOn") + exchange.income_to_eur(connection, income)
        issue("unreadable", "{n} facturas de la carpeta no se pudieron leer (protegidas o dañadas): revísalas a mano.", files(counts["unreadable"]))
        twins = counts["duplicateOf"]
        issue("duplicates", "{n} archivos son copia idéntica de otro de la carpeta (mismo contenido con otro nombre): se cuenta solo una vez.",
              [{**item, "detail": f"Copia idéntica de «{twins[item['path']]}»" if twins.get(item["path"]) else "Ya archivada por AgoraOne"}
               for item in files(counts["duplicates"])])
        issue("unplaced", "{n} archivos de Facturas Entrantes o Salientes están en carpetas que no dicen año y trimestre: no entran en ningún trimestre.",
              files(counts["unplaced"]))
        issue("noVat", "{n} facturas emitidas sin tipo de IVA leído: revisa su base y su IVA.", files(counts["noVat"]))
        issue("dates", "{n} facturas sin fecha legible: se han puesto al inicio del trimestre.",
              rows([r for r in income if r.get("guessedDate")] + [e for e in found_expenses if "Fecha no leída" in e["notes"]], lambda r: "Fecha puesta al inicio del trimestre"))
        issue("otherQuarter", "{n} facturas con fecha de otro trimestre guardadas en la carpeta de este: cuentan aquí.",
              rows([e for e in found_expenses if "otro trimestre" in e["notes"]], lambda r: f"Fecha {r['issuedOn']}"))
        issue("images", "{n} facturas en imagen sin leer: revisa sus importes a mano.",
              rows([r for r in found_income if r.get("unreadImage")] + [e for e in found_expenses if "Factura en imagen" in e["notes"]],
                   lambda r: "Emitida · imagen" if "client" in r else "Recibida · imagen"))
        issue("noTaxId", "{n} facturas recibidas sin NIF del proveedor.", rows([e for e in expenses if not e["taxId"]], lambda r: r.get("issuedOn", "")))
        issue("foreignIncome", "{n} facturas emitidas en otra moneda: su base pasa a euros con el cambio oficial del BCE de su fecha.",
              rows([r for r in income if r.get("foreign")], lambda r: f"Base {r['foreign']} ≈ {r['base']} EUR · cambio del {r['rate']['day']}"))
        issue("foreign", "{n} facturas recibidas en otra moneda: se convierten a euros con el cambio oficial del BCE de su fecha (columna «Total EUR» del Excel); no suman al IVA español.",
              rows([e for e in expenses if e["currency"] != "EUR"], lambda r: f"≈ {r.get('totalEur', '—')} EUR · cambio del {(r.get('rate') or {}).get('day', '—')}"))
        issue("plain", "{n} facturas recibidas sin base ni IVA desglosados: revísalas antes de presentar.",
              rows([e for e in expenses if not e["base"] and not e["vat"]], lambda r: r.get("issuedOn", "")))
        notes += [i["text"] for i in issues]
        return {"folder": folder, "root": root, "income": income, "incomeProblem": problem, "expenses": expenses, "notes": notes,
                "issues": issues, "reading": in_flight, "readingTotal": started, "qontoMissing": [i["qonto"] for x in issues if x["key"] == "qonto" for i in x["items"]]}

    @router.get("/fiscal/folders/{folder_id}/quarter")
    async def quarter_view(folder_id: int, year: int, quarter: int):
        if not (2000 <= year <= 2100 and 1 <= quarter <= 4):
            return refuse(fiscal.FiscalError("Trimestre no válido."))
        try:
            data = await db(lambda c: quarter_data(c, folder_id, year, quarter))
        except fiscal.FiscalError as error:
            return refuse(error)
        data.pop("root")
        return data

    @router.post("/fiscal/folders/{folder_id}/open")
    async def open_in_finder(folder_id: int, body: OpenIn):
        def work(connection):
            _, root = fiscal.folder_root(connection, folder_id)
            fiscal.open_in_finder(root, body.path, body.reveal)
            return {"ok": True}
        try:
            return await db(work)
        except fiscal.FiscalError as error:
            return refuse(error)

    @router.put("/fiscal/folders/{folder_id}/manual")
    async def save_manual(folder_id: int, body: ManualIn):
        """The data of an invoice nothing could be read from, typed by the user. Refused for any file AgoraOne
        did read: those go into the quarter exactly as read."""
        def work(connection):
            _, root = professional_root(connection, folder_id)
            path = fiscal_manual.target(root, body.path)
            read = fiscal_scan._cached(connection, folder_id, root, path)
            if read is None or fiscal_scan.is_reading(folder_id, path):
                raise fiscal.FiscalError("Esta factura aún se está leyendo: espera a que termine.")
            if not fiscal_manual.unrecognized(read, reading_on(connection)):
                if read.get("image") and not read.get("ai"):
                    raise fiscal.FiscalError("Claude aún no ha intentado leer esta imagen: espera a que la lea. Solo si no puede, se escriben sus datos a mano.")
                raise fiscal.FiscalError("Esta factura se ha leído: entra en el trimestre tal como se leyó. Si algún dato no coincide, se corrige en la lectura, no a mano.")
            fiscal_manual.save(connection, folder_id, root, path, fiscal_manual.clean(body.fields.model_dump()))
            return {"ok": True}
        try:
            return await db(work)
        except fiscal.FiscalError as error:
            return refuse(error)

    @router.delete("/fiscal/folders/{folder_id}/manual")
    async def remove_manual(folder_id: int, path: str):
        def work(connection):
            professional_root(connection, folder_id)
            fiscal_manual.remove(connection, folder_id, path)
            return {"ok": True}
        try:
            return await db(work)
        except fiscal.FiscalError as error:
            return refuse(error)

    def local_twin(row: dict, found_income: list[dict], taken: set[int] | None = None) -> dict | None:
        """The issued invoice of the folder that is this Qonto one: the same number (ignoring separators), or,
        only for a local invoice whose number could not be read, the same date and base. Each local invoice
        stands for one Qonto invoice at most (`taken`), so two equal instalments are never one."""
        taken = set() if taken is None else taken
        number = re.sub(r"\W", "", row["number"]).upper()
        # A Qonto invoice split by VAT rate shares its number: the same local file stands for all its rows.
        same = next((i for i, local in enumerate(found_income)
                     if number and re.sub(r"\W", "", str(local.get("number") or "")).upper() == number), None)
        if same is not None:
            taken.add(same)
            return found_income[same]
        for i, local in enumerate(found_income):
            if i in taken or local.get("numberRead", True):
                continue
            try:
                if local.get("date") == row.get("date") and abs(float(local["base"]) - float(row["base"])) <= 0.02:
                    taken.add(i)
                    return local
            except (TypeError, ValueError, KeyError):
                pass
        return None

    @router.post("/fiscal/folders/{folder_id}/qonto-download", status_code=201)
    async def qonto_download(folder_id: int, body: QontoDownloadIn):
        """Saves in «Facturas Salientes/año/NT/» the PDF of the issued invoices Qonto has and the folder lacks
        (only those the user asked for, never over another file)."""
        def work(connection):
            folder, root = professional_root(connection, folder_id)
            auth = qonto_auth(connection)
            if not auth:
                raise fiscal.FiscalError("Qonto no está conectado (Ajustes › Qonto).")
            start, end = fiscal_excel.quarter_range(body.year, body.quarter)
            wanted = set(body.numbers)
            saved, failed = [], []
            found_income = fiscal_scan.scan(connection, folder_id, root, body.year, body.quarter, start.isoformat(), end.isoformat(),
                                            set(), use_model=reading_on(connection))[0]
            taken: set[int] = set()
            for row in qonto.issued_invoices(auth, start, end)[0]:
                if row["number"] not in wanted or row["number"] in {s["number"] for s in saved}:
                    continue
                twin = local_twin(row, found_income, taken)
                if twin:  # never a second copy of an invoice already in the folder: its base would count twice
                    failed.append({"number": row["number"], "error": f"Parece que ya está en la carpeta: {twin['file'].split('/')[-1]}."})
                    continue
                try:
                    data = qonto.invoice_pdf(auth, row)
                except qonto.QontoError as error:
                    failed.append({"number": row["number"], "error": str(error)})
                    continue
                safe = re.sub(r"[^\w\-]+", "-", row["number"]).strip("-") or "factura"
                target = fiscal._free(fiscal.inside(root, f"{fiscal.ISSUED}/{body.year}/{body.quarter}T/{safe}.pdf"))
                target.parent.mkdir(parents=True, exist_ok=True)
                with open(target, "xb") as handle:
                    handle.write(data)
                saved.append({"number": row["number"], "path": str(target.relative_to(root))})
            return {"saved": saved, "failed": failed}
        try:
            return await db(work)
        except (fiscal.FiscalError, qonto.QontoError) as error:
            return refuse(error)

    @router.post("/fiscal/folders/{folder_id}/excel", status_code=201)
    async def make_excel(folder_id: int, body: QuarterIn):
        def work(connection):
            data = quarter_data(connection, folder_id, body.year, body.quarter)
            if data["reading"]:
                raise fiscal.FiscalError(f"Aún se están leyendo {data['reading']} facturas de la carpeta: espera a que termine para generar el Excel.")
            folder = data["folder"]
            book = fiscal_excel.build(body.year, body.quarter, folder["holder"] or folder["name"], data["income"], data["expenses"], data["notes"])
            return {"path": fiscal_excel.write(data["root"], folder["name"], body.year, body.quarter, book)}
        try:
            return await db(work)
        except fiscal.FiscalError as error:
            return refuse(error)

    # Receipts from the phone (the one network exception, see receipts.py).
    upload: dict[str, receipts.Window | None] = {"window": None}
    receipt_dir = settings.data_dir / "receipts"

    def upload_state():
        window = upload["window"]
        if window is None or window.closed:
            return {"open": False, "received": window.received if window else None}
        return {"open": True, "url": window.url, "qr": receipts.qr_svg(window.url), "expiresAt": int(window.expires_at)}

    @router.post("/fiscal/receipts/upload")
    async def open_upload():
        previous = upload["window"]
        if previous is not None and not previous.closed:
            previous.close()

        def store(data: bytes, name: str | None) -> int:
            with database() as connection:
                receipt_id = receipts.save_receipt(connection, receipt_dir, data, name)
                if data.startswith(b"%PDF-"):
                    try:  # reading it is a help, never a reason to lose the upload
                        found = invoice_extract.fields(invoice_extract.pdf_text(data))
                        connection.execute("UPDATE receipt SET fields = ? WHERE id = ?", (json.dumps(found), receipt_id))
                    except Exception:  # noqa: BLE001
                        pass
                return receipt_id
        try:
            upload["window"] = await run_in_threadpool(receipts.open_window, store)
        except (receipts.UploadError, OSError) as error:
            return refuse(error if isinstance(error, receipts.UploadError) else receipts.UploadError("No se pudo abrir la subida."))
        return upload_state()

    @router.get("/fiscal/receipts/upload")
    async def upload_status():
        return upload_state()

    @router.delete("/fiscal/receipts/upload")
    async def close_upload():
        if upload["window"] is not None:
            upload["window"].close()
        return upload_state()

    def inbox_folders(connection) -> list:
        found = []
        for folder in fiscal.folders(connection):
            try:
                found.append((folder["id"], fiscal.folder_root(connection, folder["id"])[1]))
            except fiscal.FiscalError:
                continue  # a folder moved or deleted since: nothing to bring in from it
        return found

    @router.get("/fiscal/receipts")
    async def list_receipts():
        def work(connection):
            with transaction(connection):
                receipts.import_inbox(connection, receipt_dir, inbox_folders(connection))
            return receipts.receipts(connection)
        return {"receipts": await db(work), "inbox": receipts.INBOX}

    @router.put("/fiscal/receipts/{receipt_id}")
    async def change_receipt(receipt_id: int, body: ReceiptChange):
        changed = await db(lambda c: c.execute("UPDATE receipt SET state = ?, decided_at = ? WHERE id = ? AND state != 'filed'",
                                               (body.state, now(), receipt_id)).rowcount)
        if not changed:
            return refuse(fiscal.FiscalError("Ese recibo no existe o ya está archivado."), 404)
        return {"receipts": await db(receipts.receipts)}

    @router.post("/fiscal/receipts/{receipt_id}/file", status_code=201)
    async def file_receipt(receipt_id: int, body: ReceiptFileIn):
        def work(connection):
            row = connection.execute("SELECT * FROM receipt WHERE id = ? AND state = 'pending'", (receipt_id,)).fetchone()
            if row is None:
                raise fiscal.FiscalError("Ese recibo no existe o ya está archivado.")
            folder, root = fiscal.folder_root(connection, body.folderId)
            data = (receipt_dir / row["file"]).read_bytes()
            with transaction(connection):
                filed = fiscal.file_invoice(connection, folder, root, data, body.fields.model_dump(), None, [], body.category, receipt_id)
                connection.execute("UPDATE receipt SET state = 'filed', decided_at = ? WHERE id = ?", (now(), receipt_id))
            if row["source"] == "inbox" and row["inbox_folder"] is not None:
                try:
                    _, inbox_root = fiscal.folder_root(connection, row["inbox_folder"])
                    receipts.remove_from_inbox(inbox_root, row["inbox_name"] or "", row["sha256"])
                except fiscal.FiscalError:
                    pass  # the folder is gone: nothing to tidy up
            return filed
        try:
            return await db(work)
        except fiscal.Duplicate as error:
            return refuse(error, 409)
        except (fiscal.FiscalError, OSError) as error:
            return refuse(error if isinstance(error, fiscal.FiscalError) else fiscal.FiscalError("No se pudo leer el recibo."))

    return router
