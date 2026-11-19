"""Routes for issues from a mail or a note, and for handing an issue to a session waiting in Orca."""

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import github_issues, issue_handoff, modules, orca_launch
from .db import DB_NAME, connect
from .settings import Settings


class IssueIn(BaseModel):
    client: str
    project: str
    title: str
    body: str
    source: dict


class Handoff(BaseModel):
    repo: str
    url: str
    session: str


def issues_router(settings: Settings) -> APIRouter:
    router = APIRouter()

    def refuse(message: str, status: int = 422):
        return JSONResponse({"error": message}, status_code=status)

    def orca_on() -> bool:
        connection = connect(settings.data_dir / DB_NAME)
        try:
            return modules.state(connection)["orca"]
        finally:
            connection.close()

    @router.get("/issues/target")
    async def target(client: str, project: str):
        """Which repository the issue would go to and whether GitHub says it is public (the card warns)."""
        def run():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                repo = github_issues.project_repo(connection, client, project)
            finally:
                connection.close()
            return {"repo": repo, "visibility": github_issues.visibility(repo) if repo else None}
        return await run_in_threadpool(run)

    @router.post("/issues", status_code=201)
    async def create(body: IssueIn):
        """Creates the issue as the user saw it, from a normal mail or note, with their own `gh`."""
        def run():
            connection = connect(settings.data_dir / DB_NAME)
            try:
                issue = issue_handoff.from_source(connection, body.model_dump())
            finally:
                connection.close()
            return {"repo": issue["repo"], "url": github_issues.create(issue)}
        try:
            return await run_in_threadpool(run)
        except (issue_handoff.HandoffError, github_issues.IssueError) as error:
            return refuse(str(error))

    def central_repo(repo: str) -> bool:
        """Only a repository Central keeps for a project."""
        connection = connect(settings.data_dir / DB_NAME)
        try:
            return repo.casefold() in {r.casefold() for r in github_issues.repos(connection).values()}
        finally:
            connection.close()

    @router.get("/orca/waiting")
    async def waiting(repo: str, url: str):
        """The sessions of that repository waiting for the user in Orca, and the exact line that would be typed."""
        if not await run_in_threadpool(orca_on):
            return {"sessions": [], "line": None}
        if not await run_in_threadpool(central_repo, repo):
            return refuse("Ese repositorio no es de ningún proyecto de Central.")
        try:
            line = issue_handoff.line(repo, url)
            return {"sessions": await run_in_threadpool(issue_handoff.waiting, repo), "line": line}
        except (issue_handoff.HandoffError, orca_launch.OrcaError) as error:
            return refuse(str(error))

    @router.post("/orca/handoff")
    async def handoff(body: Handoff):
        """«Escribir en la sesión»: the line typed into that waiting session, without Enter, and the session shown."""
        if not await run_in_threadpool(orca_on):
            return refuse("El módulo Orca está apagado en Ajustes.")
        if not await run_in_threadpool(central_repo, body.repo):
            return refuse("Ese repositorio no es de ningún proyecto de Central.")
        try:
            return {"line": await run_in_threadpool(issue_handoff.send, body.repo, body.url, body.session)}
        except (issue_handoff.HandoffError, orca_launch.OrcaError) as error:
            return refuse(str(error))

    return router
