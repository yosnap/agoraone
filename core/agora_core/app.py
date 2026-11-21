"""Aplicación HTTP del núcleo.

Solo el backend de AgoraOne llega aquí: cada petición trae el secreto del arranque en curso y el
propietario ya autenticado por la cookie de acceso. El navegador nunca habla directamente con el núcleo.
"""

import hmac
import re
import shutil
import sys
from pathlib import Path
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import __version__
from .backup import clean_leftovers, create_backup, ensure_daily, list_backups, prune
from .db import DB_NAME, connect, migrate
from .embed import DEFAULT_MODEL, DEFAULT_URL, Embedder, OllamaEmbedder, VectorCache
from .keystore import KeychainStore, KeyStore, recovery_pending
from .routes_addons import addons_router
from .routes_connectors import connectors_router
from .routes_assistant import KeychainSecrets, assistant_router, default_engines
from .entity_worker import ExtractHealth, entity_worker
from .engines import AnthropicApiEngine, ClaudeCodeEngine
from .routes_index import EmbedHealth, embed_worker, index_router
from .routes_mail import mail_router, mail_worker
from .routes_mail_send import mail_send_router
from .routes_chat import chat_router
from .routes_chat_send import chat_send_router
from .routes_jev import jev_router
from . import jev_shadow
from .chat_sync import chat_worker
from .chat_summarizer import chat_summary_worker
from .mail_summarizer import Budget, SummaryHealth, summary_worker
from .routes_inbox import inbox_router
from .routes_fiscal import fiscal_router
from . import calendar_store, calls, tts
from .routes_alerts import alerts_router
from .routes_jobs import jobs_router
from .routes_orca import orca_router
from .routes_orca_bots import orca_bots_router
from .routes_note_sources import note_sources_router
from .routes_issues import issues_router
from .routes_voice import voice_router
from .routes_agents import agents_router
from .routes_meetings import meetings_router
from .routes_music import music_router
from .routes_apps import apps_router
from .routes_doctor import doctor_router
from . import crmdev_sync, modules
from .meetings import Recorder
from .meeting_notes import Worker
from .routes_calendar import calendar_router
from .routes_central import CentralHealth, central_router, central_worker
from .routes_central_views import central_views_router
from .routes_central_write import central_write_router
from .routes_central_window import central_window_router
from .routes_crmdev import crmdev_router
from .routes_crmdev_window import crmdev_window_router
from .routes_central_batch import central_batch_router
from .routes_crmdev_batch import crmdev_batch_router
from .routes_crmdev_orgs import crmdev_orgs_router
from .routes_crmdev_write import crmdev_write_router
from .routes_fabrica_window import fabrica_window_router
from .routes_quotes import quotes_router
from .central_quotes import clean_documents
from .routes_clients import clients_router
from .routes_summary import summary_router
from .settings import DEFAULT_DATA, Settings

SECRET_HEADER = "x-agora-core-secret"
OWNER_HEADER = "x-agora-owner"
_OWNER = re.compile(r"[a-f0-9]{64}")
DAILY_CHECK_SECONDS = 3600


def _daily_backups(settings: Settings, store: KeyStore, stop: threading.Event) -> None:
    while not stop.is_set():
        try:
            ensure_daily(settings.data_dir, store)
        except Exception as error:  # a failed backup must not stop the core; it is retried next hour
            print(f"AgoraOne núcleo: no se pudo hacer la copia diaria ({error}).", file=sys.stderr)
        stop.wait(DAILY_CHECK_SECONDS)


_DEFAULT = object()


def create_app(
    settings: Settings, store: KeyStore | None = None, scheduler: bool = True, embedder: Embedder | None | object = _DEFAULT,
    secrets=None, engines=default_engines, calendar=None, contacts=None, call_reader=None, drafter=None,
) -> FastAPI:
    """`scheduler` starts the background work (daily backups, embeddings); tests turn it off. `embedder`
    defaults to the local ollama; None disables search by meaning."""
    store = store or KeychainStore()
    if embedder is _DEFAULT:
        embedder = OllamaEmbedder(DEFAULT_URL, DEFAULT_MODEL)
    cache = VectorCache()
    embed_health = EmbedHealth()
    extract_health = ExtractHealth()
    summary_health = SummaryHealth()
    chat_summary_health = SummaryHealth()
    # Mail and WhatsApp spend the same hourly allowance of Claude calls.
    summary_budget = Budget()
    central_health = CentralHealth()
    crmdev_health = crmdev_sync.CrmdevHealth()
    secrets = secrets or KeychainSecrets()
    # Jev in shadow after each summary round, in threads of their own (its answers are kept, never applied).
    open_db = lambda: connect(settings.data_dir / DB_NAME)  # noqa: E731
    mail_shadow, chat_shadow = jev_shadow.Shadow(jev_shadow.MAIL, open_db, secrets), jev_shadow.Shadow(jev_shadow.CHAT, open_db, secrets)
    expected = settings.secret.encode()
    recorder = Recorder(settings.data_dir, lambda: connect(settings.data_dir / DB_NAME))
    # Summaries of normal meetings (Claude, like the rest of the core); the others use a local model.
    meeting_engines = lambda: [ClaudeCodeEngine(settings.data_dir / "claude-code"), AnthropicApiEngine(secrets)]  # noqa: E731
    meeting_worker = Worker(recorder.folder, lambda: connect(settings.data_dir / DB_NAME), meeting_engines)
    recorder.on_recorded = meeting_worker.after_recording

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Each use opens its own connection (sqlite3 connections are not shared between threads here).
        clean_leftovers(settings.data_dir)
        clean_documents(settings.data_dir)  # quotes' PDF and Word opened more than a day ago
        database = connect(settings.data_dir / DB_NAME)
        try:
            migrate(database, backup_first=lambda: create_backup(settings.data_dir, store, "premigration"))
            recorder.recover(database)
            modules.apply(database)
            meeting_worker.recover(database)
        finally:
            database.close()
        stop = threading.Event()
        if scheduler:
            threading.Thread(target=_daily_backups, args=(settings, store, stop), daemon=True).start()
            if embedder is not None:
                threading.Thread(target=embed_worker, args=(settings, embedder, stop, embed_health), daemon=True).start()
            # Entities of normal notes, read by Claude Haiku (user's decision, 13/11/2026).
            extract_engines = lambda: [ClaudeCodeEngine(settings.data_dir / "claude-code"), AnthropicApiEngine(secrets)]  # noqa: E731
            threading.Thread(target=entity_worker, args=(settings, extract_engines, stop, extract_health), daemon=True).start()
            # New mail of the connected accounts, read-only (user's decision, 14/11/2026).
            # Mail and its summaries only while «Correo» is on; Central only while «Central» is.
            database_now = lambda: connect(settings.data_dir / DB_NAME)  # noqa: E731
            threading.Thread(target=modules.gated, args=("correo", database_now, lambda own: mail_worker(settings, secrets, own), stop), daemon=True).start()
            # Kinds and summaries of new mail: rules first, then Claude Haiku for what may leave this Mac.
            threading.Thread(target=modules.gated, args=("correo", database_now, lambda own: summary_worker(settings, extract_engines, own, summary_health, budget=summary_budget, shadow=mail_shadow), stop), daemon=True).start()
            # WhatsApp through Zernio, read-only, polled every five minutes while «WhatsApp» is on (user's decision, 18/11/2026).
            threading.Thread(target=modules.gated, args=("whatsapp", database_now, lambda own: chat_worker(settings, secrets, own), stop), daemon=True).start()
            # Kinds and summaries of WhatsApp conversations, like mail: rules first, Claude Haiku only for what may leave this Mac.
            threading.Thread(target=modules.gated, args=("whatsapp", database_now, lambda own: chat_summary_worker(settings, extract_engines, own, chat_summary_health, summary_budget, chat_shadow), stop), daemon=True).start()
            # Clients and servers from Central, read-only, every half hour (user's decisions, 14/11 and 18/11/2026).
            threading.Thread(target=modules.gated, args=("central", database_now, lambda own: central_worker(settings, own, central_health, secrets), stop), daemon=True).start()
            # CRMDev's clients for the directory, read-only, every half hour while «CRMDev» is on (user's decision, 19/11/2026).
            threading.Thread(target=modules.gated, args=("crmdev", database_now, lambda own: crmdev_sync.crmdev_worker(settings, own, crmdev_health, secrets), stop), daemon=True).start()
            # Watson's voice: VoiceStudio opened in the background if it is closed (user's request, 16/11/2026).
            threading.Thread(target=tts.open_at_start, args=(database_now,), daemon=True).start()
        try:
            yield
        finally:
            stop.set()
            recorder.stop_all()

    app = FastAPI(title="AgoraOne núcleo", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.middleware("http")
    async def only_agoraone(request: Request, call_next):
        if request.headers.get("host") != settings.authority:
            return JSONResponse({"error": "Host no permitido."}, status_code=403)
        given = request.headers.get(SECRET_HEADER, "").encode()
        if not hmac.compare_digest(given, expected):
            return JSONResponse({"error": "Petición no autorizada."}, status_code=401)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/health")
    async def health():
        return {"status": "ok", "version": __version__}

    @app.get("/whoami")
    async def whoami(request: Request):
        owner = request.headers.get(OWNER_HEADER, "")
        if not _OWNER.fullmatch(owner):
            return JSONResponse({"error": "Falta el propietario."}, status_code=400)
        return {"owner": owner}

    @app.get("/brain-mcp")
    async def brain_mcp_setup():
        """What the user types to connect the brain's MCP server to a Hermes profile (AgoraOne never writes
        Hermes' configuration). Paths of this Mac, shown only to the owner on screen."""
        core_dir = Path(__file__).resolve().parents[1]
        args = ["run", "--directory", str(core_dir), "--frozen", "--quiet", "python", "-m", "agora_core.brain_mcp"]
        env = {} if settings.data_dir == DEFAULT_DATA else {"AGORA_CORE_DATA": str(settings.data_dir)}
        return {"name": "agoraone-cerebro", "command": shutil.which("uv"), "args": args, "env": env}

    def described():
        found = []
        for b in list_backups(settings.data_dir):
            try:
                size = b.path.stat().st_size
            except FileNotFoundError:  # pruned meanwhile
                continue
            found.append({"name": b.name, "kind": b.kind, "created": b.created.strftime("%Y-%m-%dT%H:%M:%SZ"), "bytes": size})
        return {"backups": found, "recoveryKeyPending": recovery_pending(store, settings.data_dir)}

    @app.get("/backups")
    async def backups():
        return await run_in_threadpool(described)

    @app.post("/backups", status_code=201)
    async def backup_now():
        def make():
            made = create_backup(settings.data_dir, store, "manual")
            prune(settings.data_dir)
            return made

        try:
            made = await run_in_threadpool(make)
        except Exception as error:  # disk full, locked Keychain, missing key...: a clear 503, never a 500
            return JSONResponse({"error": f"No se pudo hacer la copia: {error}"}, status_code=503)
        return {"name": made.name, "kind": made.kind}

    app.include_router(index_router(settings, embedder, cache, embed_health, extract_health))
    app.include_router(addons_router(settings))
    app.include_router(connectors_router(settings, secrets))
    app.include_router(summary_router(settings, time.time()))
    app.include_router(assistant_router(settings, embedder, cache, secrets, engines))
    app.include_router(mail_router(settings, secrets))
    app.include_router(mail_send_router(settings, secrets, drafter))
    app.include_router(chat_router(settings, secrets, chat_summary_health))
    app.include_router(chat_send_router(settings, secrets, drafter))
    app.include_router(jev_router(settings, secrets))
    app.include_router(inbox_router(settings, summary_health, secrets))
    app.include_router(fiscal_router(settings, secrets))
    app.include_router(central_router(settings, central_health, secrets))
    app.include_router(central_views_router(settings, secrets))
    app.include_router(central_write_router(settings, secrets))
    app.include_router(central_window_router(settings))
    app.include_router(crmdev_router(settings, secrets, crmdev_health))
    app.include_router(crmdev_window_router(settings))
    app.include_router(crmdev_write_router(settings, secrets))
    app.include_router(crmdev_batch_router(settings, secrets))
    app.include_router(crmdev_orgs_router(settings, secrets))
    app.include_router(central_batch_router(settings, secrets))
    app.include_router(fabrica_window_router(settings))
    app.include_router(quotes_router(settings, secrets))
    app.include_router(clients_router(settings, secrets, crmdev_health))
    if calendar is not None:
        calendar_store.use(calendar)
    app.include_router(calendar_router(settings))
    if contacts is not None:
        calls.use_contacts(contacts)
    app.include_router(alerts_router(settings, **({'call_reader': call_reader} if call_reader else {})))
    app.include_router(jobs_router(settings))
    app.include_router(voice_router(settings))
    app.include_router(meetings_router(settings, recorder, meeting_worker))
    app.include_router(music_router(settings))
    app.include_router(apps_router(settings))
    app.include_router(doctor_router(settings, secrets))
    app.include_router(agents_router(settings))
    app.include_router(orca_router(settings, secrets))
    app.include_router(orca_bots_router(settings, secrets))
    app.include_router(note_sources_router(settings, secrets))
    app.include_router(issues_router(settings))
    return app
