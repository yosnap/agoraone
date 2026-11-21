"""HTTP routes of the Orca module: whether it can be used, the exact preview of a launch and the launch itself,
which only runs a preview the same owner saw, once, within 15 minutes."""

import re
import secrets
import time
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictInt

from . import chat_inbox, github_issues, modules, orca_launch, repo_notes
from .db import DB_NAME, connect
from .settings import Settings

_OWNER = re.compile(r"[a-f0-9]{64}")
KEEP = 15 * 60
MAX_PLANS = 50


class LaunchSource(BaseModel):
    kind: str | None = None
    id: int | None = None
    url: str | None = None
    source: str | None = None
    ref: str | None = None
    revision: str | None = None
    remote: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,100}$")  # a task's or ticket's id in CRMDev
    org: str | None = Field(default=None, pattern=r"^o[1-9][0-9]{0,3}$")  # its organization of CRMDev (the first one if None)


class LaunchRequest(BaseModel):
    client: str
    project: str
    task: str
    agent: str = "claude"
    source: LaunchSource | None = None


class LaunchConfirm(BaseModel):
    id: str


class NoteOrigin(BaseModel):
    kind: Literal["mail", "chat"]
    id: StrictInt


class RepoNote(BaseModel):
    client: str
    project: str
    folder: str
    title: str
    content: str
    inboxId: StrictInt | None = None  # a mail's card, as before
    source: NoteOrigin | None = None  # a mail's or a WhatsApp conversation's card


def origin_problem(connection, body: RepoNote) -> str | None:
    """Why the card's note may not go to a repository (only what is `normal` may), or None. Exactly one origin."""
    if (body.inboxId is None) == (body.source is None):
        return "Falta de dónde sale la nota."
    kind, ident = ("mail", body.inboxId) if body.source is None else (body.source.kind, body.source.id)
    if kind == "chat":
        try:
            level = chat_inbox.level_of(connection, ident)
        except chat_inbox.ChatGone as error:
            return str(error)
        return None if level == "normal" else "Esa conversación es privada o «solo en este Mac»: su nota no va a un repositorio."
    if repo_notes.mail_level(connection, ident) != "normal":
        return "Ese correo es privado o «solo en este Mac»: su nota no va a un repositorio."
    return None


def orca_router(settings: Settings, secrets_store=None) -> APIRouter:
    router = APIRouter()
    plans: dict[str, dict] = {}

    def owner_of(request: Request) -> str | None:
        owner = request.headers.get("x-agora-owner", "")
        return owner if _OWNER.fullmatch(owner) else None

    def module_on() -> bool:
        connection = connect(settings.data_dir / DB_NAME)
        try:
            return modules.state(connection)["orca"]
        finally:
            connection.close()

    def refuse(message: str, status: int = 422):
        return JSONResponse({"error": message}, status_code=status)

    @router.get("/orca")
    async def status():
        return {"installed": orca_launch.binary() is not None, "on": await run_in_threadpool(module_on), "agents": orca_launch.AGENTS}

    @router.get("/orca/projects")
    async def ready():
        def run():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                if orca_launch.binary() is None or not modules.state(connection)["orca"]:
                    return {"projects": [], "problem": None}
                return orca_launch.ready_projects(connection)
            finally:
                connection.close()
        return await run_in_threadpool(run)

    @router.get("/orca/repo-folders")
    async def repo_folders(client: str, project: str):
        """Where a note to act on can go: the folders of the project's local copy, the suggested one and whether
        GitHub says the repository is public (the screen warns)."""
        def run():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                if not modules.state(connection)["orca"]:
                    raise repo_notes.RepoNoteError("El módulo Orca está apagado en Ajustes.")
                repo, root = repo_notes.local_root(connection, client, project)
            finally:
                connection.close()
            return {"repo": repo, "root": root, "folders": repo_notes.folders(root), "suggested": repo_notes.SUGGESTED,
                    "visibility": github_issues.visibility(repo)}
        try:
            return await run_in_threadpool(run)
        except repo_notes.RepoNoteError as error:
            return refuse(str(error))

    @router.post("/orca/repo-note", status_code=201)
    async def repo_note(body: RepoNote):
        """Creates the note, a new file, in the folder the user chose inside the local copy. No commit, no push."""
        def run():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                if not modules.state(connection)["orca"]:
                    raise repo_notes.RepoNoteError("El módulo Orca está apagado en Ajustes.")
                if problem := origin_problem(connection, body):
                    raise repo_notes.RepoNoteError(problem)
                repo, root = repo_notes.local_root(connection, body.client, body.project)
            finally:
                connection.close()
            return {"repo": repo, "root": root, "path": repo_notes.save(root, body.folder, body.title, body.content)}
        try:
            return await run_in_threadpool(run)
        except repo_notes.RepoNoteError as error:
            return refuse(str(error))
        except (OSError, UnicodeError):
            return refuse("No se pudo escribir la nota en el repositorio.")

    @router.post("/orca/preview")
    async def preview(body: LaunchRequest, request: Request):
        owner = owner_of(request)
        if not owner:
            return refuse("Sin acceso.", 403)

        def run():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                if not modules.state(connection)["orca"]:
                    raise orca_launch.OrcaError("El módulo Orca está apagado en Ajustes.")
                return orca_launch.preview(connection, body.model_dump(), secrets_store=secrets_store)
            finally:
                connection.close()

        try:
            plan = await run_in_threadpool(run)
        except orca_launch.OrcaError as error:
            return refuse(str(error))
        now = time.time()
        for key in [k for k, v in plans.items() if v["expires"] < now]:
            plans.pop(key, None)
        while len(plans) >= MAX_PLANS:
            plans.pop(next(iter(plans)))
        ident = secrets.token_urlsafe(16)
        plans[ident] = {"plan": plan, "owner": owner, "expires": now + KEEP}
        return {"id": ident, **{k: v for k, v in plan.items() if k != "orcaProject"}}

    @router.post("/orca/launch", status_code=201)
    async def launch(body: LaunchConfirm, request: Request):
        owner = owner_of(request)
        found = plans.get(body.id)
        if not owner or found is None or found["owner"] != owner or found["expires"] < time.time():
            return refuse("Esa vista previa ya no vale: vuelve a prepararla.", 409)
        plans.pop(body.id, None)  # taken before any wait: a double click launches once
        if not await run_in_threadpool(module_on):
            return refuse("El módulo Orca está apagado en Ajustes.")
        plan = found["plan"]

        def still_allowed():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                orca_launch.recheck(connection, plan, secrets_store)
            finally:
                connection.close()

        try:
            await run_in_threadpool(still_allowed)
        except orca_launch.OrcaError as error:
            return refuse(f"{error} No se ha lanzado nada.")

        def record(outcome: str):
            connection = connect(settings.data_dir / DB_NAME)
            try:
                orca_launch.log(connection, plan, outcome)
            finally:
                connection.close()

        try:
            started = await run_in_threadpool(orca_launch.launch, plan)
        except orca_launch.OrcaError as error:
            await run_in_threadpool(record, "failed")
            return refuse(str(error), 502)
        await run_in_threadpool(record, "done")
        return {**started, "repo": plan["repo"], "agentName": plan["agentName"]}

    return router
