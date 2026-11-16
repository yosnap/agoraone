"""Issues of GitHub from a meeting (user's decision, 16/11/2026): Watson proposes one for the repository of a
Central project (the meeting's, or one it names) and it is created only when the user presses «Crear la
issue». It goes through the user's own GitHub CLI (`gh`, signed in with their account): AgoraOne keeps no
GitHub key. The body travels on stdin and every value as an argument, never through a shell."""

import os
import re
import shutil
import sqlite3
import subprocess

TITLE_CHARS = 200
BODY_CHARS = 20000
REPO = re.compile(r"[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}")
ISSUE_URL = re.compile(r"https://github\.com/[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}/issues/\d+")


class IssueError(ValueError):
    pass


def _projects(connection: sqlite3.Connection) -> list[dict]:
    from .central import snapshot

    return [{**p, "client": c["name"]} for c in ((snapshot(connection) or {}).get("clients") or []) for p in (c.get("projects") or []) if p.get("name")]


def project_repo(connection: sqlite3.Connection, client: str | None, project: str | None) -> str | None:
    """The GitHub repository («owner/name») Central keeps for a client's project, or None."""
    found = next((p for p in _projects(connection) if p["client"] == client and p["name"] == project), None)
    return found.get("repo") if found else None


def propose(connection: sqlite3.Connection, owner: str, args: dict, seen: set[int]) -> dict:
    """Checks an issue Watson wants to open: a title, a body and a Central project with a GitHub repository,
    taken from the meeting (one Watson already found) or named. Raises IssueError saying what is missing."""
    title = " ".join(str(args.get("titulo") or "").split())[:TITLE_CHARS]
    body = str(args.get("cuerpo") or "").strip()[:BODY_CHARS]
    if not title or not body:
        raise IssueError("La issue necesita título y cuerpo.")
    meeting_title, client, project = None, None, None
    if args.get("reunion") is not None:
        meeting_id = int(args["reunion"])
        if meeting_id not in seen:
            raise IssueError("Busca antes la reunión con consultar_reuniones.")
        row = connection.execute("SELECT title, client, project FROM meeting WHERE id = ? AND owner = ? AND confidentiality = 'normal'",
                                 (meeting_id, owner)).fetchone()
        if row is None:
            raise IssueError("Esa reunión ya no está disponible.")
        meeting_title, client, project = row["title"], row["client"], row["project"]
    named = " ".join(str(args.get("proyecto") or "").split())
    if named:
        wanted_client = " ".join(str(args.get("cliente") or "").split()).casefold()
        matches = [p for p in _projects(connection) if p["name"].casefold() == named.casefold() and (not wanted_client or p["client"].casefold() == wanted_client)]
        if not matches:
            raise IssueError(f"«{named}» no es un proyecto de Central: usa consultar_clientes para el nombre exacto.")
        if len(matches) > 1:
            raise IssueError(f"Hay varios proyectos «{named}»: di también el cliente.")
        client, project = matches[0]["client"], matches[0]["name"]
    if not project:
        raise IssueError("La reunión no tiene proyecto: pide al usuario que lo elija en Reuniones, o di el proyecto de Central.")
    repo = project_repo(connection, client, project)
    if not repo:
        raise IssueError(f"El proyecto «{project}» no tiene repositorio de GitHub en Central.")
    return {"repo": repo, "client": client, "project": project, "title": title, "body": body, "meeting": meeting_title}


def _gh() -> str | None:
    return shutil.which("gh") or next((p for p in ("/opt/homebrew/bin/gh", "/usr/local/bin/gh") if os.path.exists(p)), None)


def create(issue: dict, runner=subprocess.run) -> str:
    """Creates the issue with the user's `gh` and returns its address."""
    if not REPO.fullmatch(issue["repo"]):
        raise IssueError("Repositorio no válido.")
    gh = _gh()
    if not gh:
        raise IssueError("Para crear issues hace falta GitHub CLI (gh) con tu cuenta: instálalo y ejecuta «gh auth login».")
    env = {k: os.environ[k] for k in ("PATH", "HOME", "LANG", "USER") if k in os.environ}
    try:
        done = runner([gh, "issue", "create", "--repo", issue["repo"], "--title", issue["title"], "--body-file", "-"],
                      input=issue["body"], text=True, capture_output=True, timeout=60, env=env)
    except (OSError, subprocess.SubprocessError) as error:
        raise IssueError("GitHub CLI no respondió.") from error
    url = ISSUE_URL.search(done.stdout or "")
    if done.returncode != 0 or not url:
        said = " ".join((done.stderr or "").split())[:300]
        raise IssueError(f"GitHub no creó la issue{': ' + said if said else ''}.")
    return url[0]
