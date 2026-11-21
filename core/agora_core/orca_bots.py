"""Orca bots (user's decision, 21/11/2026; plan `261121-1526-orca-bots`): the bots the user keeps in Orca, one per kind
of job (security, junior development, review, support…), and AgoraOne's own mailbox in Orca, from which errands are
sent to them and where their answers arrive. AgoraOne never creates, sets up nor deletes a bot, never connects
services or tools to one and never creates automations: all of that is the user's, in Orca.

The mailbox is a terminal of AgoraOne's own in Orca (`orca terminal create --command "cat > /dev/null"`): Orca needs
a sending terminal and leaves the answers in its mailbox, and whatever Orca types into it falls into `cat`, never into
a shell. It is used only while `cat` still runs there (Orca's process title); otherwise nothing is sent until the user
creates it again. AgoraOne never uses another terminal's handle: that would act on its mailbox. It is created only with
a button (a visible tab in Orca); after Orca restarts, it is found again by its tab.

The CLI runs as in `orca_launch`: no shell, one value per argument, a small environment without ORCA_* variables."""

import json
import re
import sqlite3
import subprocess
import time

from . import orca_launch
from .db import transaction
from .orca_launch import OrcaError

SETTING = "orca.mailbox"
TITLE = "Buzón de AgoraOne"
SINK = "cat > /dev/null"
SINK_PROCESS = "cat"
MIN_VERSION = (1, 4, 267)
HANDLE = re.compile(r"^term_[0-9a-f-]{36}$")
VERSION = re.compile(r"(\d+)\.(\d+)\.(\d+)")
OLD = "Los bots necesitan Orca 1.4.267 o posterior: actualízalo desde la app de Orca."
GONE = "El buzón de AgoraOne en Orca ya no está: créalo otra vez en Agentes › Bots de Orca."
STARTING_SECONDS = 8.0  # how long a new mailbox's shell may take to start `cat`
NOT_SINK = "En el buzón de AgoraOne ya no corre «cat» (¿se interrumpió?): ciérralo en Orca y créalo otra vez en Agentes › Bots de Orca."


def version(runner=subprocess.run) -> tuple[int, int, int] | None:
    """Orca's version, from `orca --version` (no JSON there); None if it cannot be read."""
    orca = orca_launch.binary()
    if not orca:
        return None
    try:
        done = runner([orca, "--version"], text=True, capture_output=True, timeout=15, env=orca_launch._env(), stdin=subprocess.DEVNULL)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    found = VERSION.search(done.stdout or "")
    return tuple(int(n) for n in found.groups()) if found else None  # type: ignore[return-value]


def ready(runner=subprocess.run) -> None:
    """Raises OrcaError unless Orca is installed and new enough for bots."""
    if not orca_launch.binary():
        raise OrcaError("Orca no está instalado en este equipo.")
    found = version(runner)
    if found is None or found < MIN_VERSION:
        raise OrcaError(OLD)


def _text(value, limit: int) -> str | None:
    return " ".join(value.split())[:limit] or None if isinstance(value, str) else None


def bots(runner=subprocess.run) -> list[dict]:
    """The bots on this computer: name, id, agent, what it is for (when Orca says it) and whether it is paused."""
    ready(runner)
    listed = orca_launch._run(["bot", "list"], runner, 20).get("bots")
    found = []
    for bot in listed if isinstance(listed, list) else []:
        if not isinstance(bot, dict) or not _text(bot.get("name"), 80) or not isinstance(bot.get("id"), str):
            continue
        found.append({"id": bot["id"][:64], "name": _text(bot["name"], 80), "agent": _text(bot.get("agent"), 40),
                      "purpose": _text(bot.get("specialty") or bot.get("purpose"), 300), "paused": bool(bot.get("paused"))})
    return found


def saved(connection: sqlite3.Connection) -> dict | None:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (SETTING,)).fetchone()
    try:
        found = json.loads(row["value"]) if row else None
    except (TypeError, ValueError):
        return None
    if not isinstance(found, dict) or not HANDLE.fullmatch(str(found.get("handle") or "")):
        return None
    return {k: found.get(k) for k in ("handle", "tabId", "worktreeId", "worktreePath")}


def _keep(connection: sqlite3.Connection, mailbox: dict | None) -> None:
    with transaction(connection):
        if mailbox is None:
            connection.execute("DELETE FROM setting WHERE key = ?", (SETTING,))
        else:
            connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                               (SETTING, json.dumps(mailbox, ensure_ascii=False)))


def _show(handle: str, runner) -> dict | None:
    try:
        terminal = orca_launch._run(["terminal", "show", f"--terminal={handle}"], runner, 15).get("terminal")
    except OrcaError:
        return None  # a stale handle (Orca restarted) or a closed terminal
    return terminal if isinstance(terminal, dict) else None


def _by_tab(tab: str | None, runner) -> dict | None:
    """After a restart the handle changes: the terminal of the same tab, if it is still there."""
    if not tab:
        return None
    listed = orca_launch._run(["terminal", "list"], runner, 20).get("terminals")
    return next((t for t in listed if isinstance(t, dict) and t.get("tabId") == tab and HANDLE.fullmatch(str(t.get("handle") or ""))), None) \
        if isinstance(listed, list) else None


def status(connection: sqlite3.Connection, runner=subprocess.run) -> dict:
    """Whether the mailbox can be used now: `ready`, `missing` (never created or gone) or `broken` (no longer `cat`)."""
    mine = saved(connection)
    if mine is None:
        return {"state": "missing", "title": TITLE}
    terminal = _show(mine["handle"], runner) or _by_tab(mine.get("tabId"), runner)
    if terminal is None:
        return {"state": "missing", "title": TITLE, "problem": GONE}
    if terminal.get("handle") != mine["handle"]:
        mine = {**mine, "handle": terminal["handle"]}
        _keep(connection, mine)
    if terminal.get("title") != SINK_PROCESS or terminal.get("connected") is False:
        return {"state": "broken", "title": TITLE, "problem": NOT_SINK, "where": mine.get("worktreePath")}
    return {"state": "ready", "title": TITLE, "where": mine.get("worktreePath")}


def handle(connection: sqlite3.Connection, runner=subprocess.run) -> str:
    """The mailbox's handle, only when it is ready; OrcaError with what to do otherwise."""
    found = status(connection, runner)
    if found["state"] != "ready":
        raise OrcaError(found.get("problem") or GONE)
    return saved(connection)["handle"]  # type: ignore[index]


def _home(runner) -> dict:
    """Where the mailbox goes: an existing workspace of Orca (the terminal needs one), AgoraOne's repository if Orca has
    it, otherwise the first one listed. Nothing in it is read nor changed: the terminal only runs `cat`."""
    listed = orca_launch._run(["worktree", "list"], runner, 20).get("worktrees")
    places = [w for w in listed if isinstance(w, dict) and isinstance(w.get("id"), str) and isinstance(w.get("path"), str)] \
        if isinstance(listed, list) else []
    if not places:
        raise OrcaError("Orca no tiene ningún proyecto abierto donde poner el buzón: añade uno en Orca.")
    return next((w for w in places if w["path"].rstrip("/").lower().endswith("/agoraone")), places[0])


def create(connection: sqlite3.Connection, runner=subprocess.run, sleep=time.sleep) -> dict:
    """«Crear el buzón de AgoraOne» (a button): a new visible tab in Orca running `cat`. Only while there is none: a
    broken one is closed by the user in Orca first, so two mailboxes never exist. Waits for its shell to start `cat`."""
    ready(runner)
    current = status(connection, runner)
    if current["state"] == "ready":
        raise OrcaError("El buzón de AgoraOne ya está en Orca.")
    if current["state"] == "broken":
        raise OrcaError(NOT_SINK)
    place = _home(runner)
    terminal = orca_launch._run(["terminal", "create", f"--worktree=id:{place['id']}", f"--title={TITLE}", f"--command={SINK}"],
                                runner, 30).get("terminal")
    if not isinstance(terminal, dict) or not HANDLE.fullmatch(str(terminal.get("handle") or "")):
        raise OrcaError("Orca no devolvió el buzón: mira en Orca si se abrió una pestaña «Buzón de AgoraOne».")
    _keep(connection, {"handle": terminal["handle"], "tabId": terminal.get("tabId"), "worktreeId": place["id"], "worktreePath": place["path"]})
    waited = 0.0
    while True:
        found = status(connection, runner)
        if found["state"] != "broken" or waited >= STARTING_SECONDS:
            return found
        sleep(0.5)
        waited += 0.5


# ---- Errands to a bot (two steps: the exact text, then «Enviar a <bot>») ----

KINDS = {"handoff": "Encargar", "question": "Preguntar"}
UNSURE = "Orca no confirmó el envío: mira en Orca, en los chats del bot, antes de repetirlo."


class UnsureSend(OrcaError):
    """The send may have reached the bot: never «nothing was sent»."""
SUBJECT_CHARS = 120
MESSAGE_ID = re.compile(r"^msg_[A-Za-z0-9_-]{4,72}$")


def _subject(project: str, task: str) -> str:
    first = next((line.strip() for line in task.splitlines() if line.strip()), "Encargo")
    return f"{project}: {first}"[:SUBJECT_CHARS]


def preview(connection: sqlite3.Connection, args: dict, runner=subprocess.run, secrets_store=None) -> dict:
    """The exact errand for a bot: the project's checks, source and fenced text are those of a launch in Orca
    (`orca_launch.preview`: Central's repository already in Orca, nothing private nor «solo en este Mac»), plus the bot,
    the kind and the repository it must work in. Nothing is sent here."""
    kind = args.get("kind")
    if kind not in KINDS:
        raise OrcaError("Elige «Encargar» o «Preguntar».")
    ready(runner)
    bot = next((b for b in bots(runner) if b["id"] == args.get("bot")), None)
    if bot is None:
        raise OrcaError("Ese bot ya no está en Orca.")
    if bot["paused"]:
        raise OrcaError(f"«{bot['name']}» está en pausa en Orca.")
    handle(connection, runner)  # refused without a ready mailbox, before anything else
    launch = orca_launch.preview(connection, {**args, "agent": "claude"}, runner, secrets_store)
    body = "\n".join([launch["prompt"], "",
                      f"Repositorio de GitHub: {launch['repo']} (en Orca, el proyecto «{launch['orcaName']}»). Si hay que tocar código, "
                      "hazlo en un espacio de trabajo nuevo de ese repositorio y nunca en otro; sigue los flujos y las normas del propio repositorio.",
                      "Responde en español de España."])
    return {"bot": {"id": bot["id"], "name": bot["name"], "agent": bot["agent"]}, "kind": kind, "kindLabel": KINDS[kind],
            "client": launch["client"], "project": launch["project"], "repo": launch["repo"], "orcaName": launch["orcaName"],
            "source": launch["source"], "subject": _subject(launch["project"], str(args.get("task") or "")), "body": body}


def send(connection: sqlite3.Connection, plan: dict, runner=subprocess.run, secrets_store=None) -> dict:
    """«Enviar a <bot>»: checks again what may have changed since the preview and sends it once, from the mailbox, to a
    new chat of the bot (never its Home chat). Keeps what identifies it, never its text."""
    from .db import now, transaction

    source = plan.get("source") or {}
    orca_launch.recheck(connection, {**plan, "source": source}, secrets_store)
    mailbox = handle(connection, runner)
    if not any(b["id"] == plan["bot"]["id"] and not b["paused"] for b in bots(runner)):
        raise OrcaError("Ese bot ya no está en Orca o está en pausa.")
    try:
        sent = orca_launch._run(["orchestration", "send", f"--from={mailbox}", f"--to=bot:{plan['bot']['id']}", "--chat=new",
                                 f"--type={plan['kind']}", f"--subject={plan['subject']}", f"--body={plan['body']}"], runner, 30)
    except OrcaError as error:
        raise UnsureSend(UNSURE) from error
    message_id = sent.get("messageId")
    if not isinstance(message_id, str) or not MESSAGE_ID.fullmatch(message_id):
        raise UnsureSend(UNSURE)
    with transaction(connection):
        connection.execute("INSERT INTO orca_bot_request (message_id, bot_id, bot_name, kind, subject, client, project, repo, source_kind, created_at) "
                           "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                           (message_id, plan["bot"]["id"], plan["bot"]["name"], plan["kind"], plan["subject"], plan["client"], plan["project"],
                            plan["repo"], source.get("kind") or "project", now()))
        connection.execute("INSERT INTO action_log (occurred_at, actor, action, outcome, detail) VALUES (?, 'user', 'orca.bot', 'done', ?)",
                           (now(), json.dumps({"bot": plan["bot"]["name"], "tipo": plan["kind"], "proyecto": plan["project"],
                                               "origen": source.get("kind") or "project"}, ensure_ascii=False)))
    return {"messageId": message_id, "bot": plan["bot"]["name"], "kind": plan["kind"]}
