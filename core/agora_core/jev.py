"""Jev, TypeSafe's «System One» model, as a judge: AgoraOne sends it a state (the text as data, in named JSON
fields) and typed questions (choice, score, noul) and gets back answers with their confidence. Jev never writes
and never acts: what it answers is only ever a decision the caller may apply, suggest or ignore.

Barriers, all here and not only in the callers: only what is of normal level goes out; the module and each decision
point can be turned off; calls per hour and tokens per month are capped, counted in the database so restarting does
not reset them. The API key goes only in the Authorization header to api.typesafe.ai; it never appears in errors,
logs, answers or the database."""

import json
import re
import sqlite3
import sys
import threading
import time
import tomllib
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import httpx

from . import __version__, modules, tls
from .db import now, transaction

API = "https://api.typesafe.ai/v1"
SECRET = "typesafe-api-key"  # Keychain account of the key
TIMEOUT = httpx.Timeout(10, connect=5)
TOTAL = 25.0  # seconds of wall clock for one question, retry and waiting for a free slot included
RETRY_PAUSE = 1.5  # seconds before the single retry after a 429 or 529
PARALLEL = threading.BoundedSemaphore(4)  # at most four requests at once from the background work

MODEL_ALIASES = ("jev-latest", "jev-preview")
_PINNED = re.compile(r"jev-\d{1,3}\.\d{1,3}\.\d{1,3}")
PRICE_PER_MILLION = 0.042  # dollars per million input tokens; output is free
HOURLY_CALLS = 600
STATE_LIMIT = 60_000  # characters of serialized state: well under the 32k tokens a question may see
# Where AgoraOne may ask Jev, each with its own switch (all on; the module is the single switch for all of them).
POINTS = {
    "mail": "Clase y prisa de los correos", "chat": "Clase de las conversaciones de WhatsApp", "deadlines": "Plazos que avisan",
    "tasks": "Prioridad de las tareas", "meetings": "Reuniones: cliente, proyecto y tareas", "fiscal": "Fiscal: carpeta y tipo de documento",
    "watson": "Comprobación de Watson y propuestas",
}
SUBJECTS = ("mail", "chat", "meeting", "task", "invoice", "watson", "vault", "job")
DEFAULTS = {"model": "jev-latest", "monthlyUsd": 2.0, "threshold": 0.9}
SETTING = "jev"
USAGE = "jev.usage"


class JevError(RuntimeError):
    """`status`: 'private' (not normal level), 'off' (module or point turned off), 'auth', 'invalid', 'limit',
    'overloaded', 'unreachable', 'budget' or 'storage' (the answer could not be kept). Callers fall back to their own logic on any of them."""

    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status


@dataclass
class Answer:
    """Jev's answers, each `{"type", "value", "confidence", "probabilities"}` (and `legend` for a score) exactly as
    Jev gave them; questions whose answer did not fit their type are left out. `model` is the version that answered."""

    model: str
    answers: dict[str, dict] = field(default_factory=dict)
    input_tokens: int = 0
    output_tokens: int = 0


def _version() -> str:
    try:
        with open(Path(__file__).resolve().parents[1] / "pyproject.toml", "rb") as file:
            return str(tomllib.load(file)["project"]["version"])
    except (OSError, KeyError, tomllib.TOMLDecodeError):
        return __version__


USER_AGENT = f"AgoraOne/{_version()}"


# ---- settings and allowance --------------------------------------------------------------------------------------

def model_problem(model: object) -> str | None:
    if isinstance(model, str) and (model in MODEL_ALIASES or _PINNED.fullmatch(model)):
        return None
    return "Modelo no válido: elige jev-latest, jev-preview o una versión fijada como jev-1.14.0."


def _read(connection: sqlite3.Connection, key: str) -> dict:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (key,)).fetchone()
    try:
        found = json.loads(row["value"]) if row else {}
    except ValueError:
        found = {}
    return found if isinstance(found, dict) else {}


def _write(connection: sqlite3.Connection, key: str, value: dict) -> None:
    connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", (key, json.dumps(value)))


def settings(connection: sqlite3.Connection) -> dict:
    """The model, the monthly cap in dollars, the confidence from which a decision is applied and each point's switch."""
    saved = _read(connection, SETTING)
    model = saved.get("model") if model_problem(saved.get("model")) is None else DEFAULTS["model"]
    monthly = saved.get("monthlyUsd")
    threshold = saved.get("threshold")
    points = saved.get("points") if isinstance(saved.get("points"), dict) else {}
    return {
        "model": model,
        "monthlyUsd": float(monthly) if isinstance(monthly, (int, float)) and 0 < monthly <= 100 else DEFAULTS["monthlyUsd"],
        "threshold": float(threshold) if isinstance(threshold, (int, float)) and 0.5 <= threshold <= 1 else DEFAULTS["threshold"],
        "points": {name: points.get(name, True) is not False for name in POINTS},
    }


def save_settings(connection: sqlite3.Connection, changes: dict) -> dict:
    """Applies the changes already checked by the route; unknown points are ignored."""
    with transaction(connection):
        current = settings(connection)
        for name in ("model", "monthlyUsd", "threshold"):
            if changes.get(name) is not None:
                current[name] = changes[name]
        current["points"].update({name: bool(value) for name, value in (changes.get("points") or {}).items() if name in POINTS})
        _write(connection, SETTING, current)
    return settings(connection)


def _clock() -> datetime:
    return datetime.now().astimezone()


def usage(connection: sqlite3.Connection) -> dict:
    """This month's use (local month): calls, tokens and what they cost, and this hour's calls."""
    stamp = _clock()
    month, hour = stamp.strftime("%Y-%m"), stamp.strftime("%Y-%m-%dT%H")
    saved = _read(connection, USAGE)
    counted = lambda name: saved.get(name) if isinstance(saved.get(name), int) and saved.get(name) >= 0 else 0  # noqa: E731
    same_month = saved.get("month") == month
    found = {"month": month, "calls": counted("calls") if same_month else 0, "inputTokens": counted("inputTokens") if same_month else 0,
             "outputTokens": counted("outputTokens") if same_month else 0, "hour": hour, "hourCalls": counted("hourCalls") if saved.get("hour") == hour else 0}
    found["spentUsd"] = round(found["inputTokens"] * PRICE_PER_MILLION / 1_000_000, 4)
    return found


def cap_tokens(monthly_usd: float) -> int:
    return int(monthly_usd / PRICE_PER_MILLION * 1_000_000)


def _reserve(connection: sqlite3.Connection, monthly_usd: float) -> None:
    """Counts one call, or refuses it when this hour's calls or this month's tokens are used up."""
    with transaction(connection):
        found = usage(connection)
        if found["hourCalls"] >= HOURLY_CALLS:
            raise JevError("budget", "Se ha llegado al límite de llamadas a Jev de esta hora: sigue la lógica de siempre.")
        if found["inputTokens"] >= cap_tokens(monthly_usd):
            raise JevError("budget", "Se ha llegado al tope mensual de Jev: sigue la lógica de siempre hasta el mes que viene o hasta subir el tope.")
        found["calls"] += 1
        found["hourCalls"] += 1
        _write(connection, USAGE, {k: v for k, v in found.items() if k != "spentUsd"})


def _spend(connection: sqlite3.Connection, input_tokens: int, output_tokens: int) -> None:
    with transaction(connection):
        found = usage(connection)
        found["inputTokens"] += input_tokens
        found["outputTokens"] += output_tokens
        _write(connection, USAGE, {k: v for k, v in found.items() if k != "spentUsd"})


# ---- questions, state and answers --------------------------------------------------------------------------------

def check_questions(questions: object) -> dict:
    """The questions in Jev's shape, or JevError('invalid'): a choice needs two options described by text or null,
    a score two ordered levels, a noul at most `true` and `false` criteria. Ids are short and plain."""
    if not isinstance(questions, dict) or not 1 <= len(questions) <= 32:
        raise JevError("invalid", "Las preguntas a Jev deben ser entre 1 y 32.")
    for ident, question in questions.items():
        if not isinstance(ident, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,39}", ident):
            raise JevError("invalid", "Cada pregunta a Jev necesita un identificador corto en minúsculas.")
        if not isinstance(question, dict) or question.get("type") not in ("choice", "score", "noul"):
            raise JevError("invalid", f"La pregunta «{ident}» debe ser choice, score o noul.")
        if not isinstance(question.get("instructions"), str) or not question["instructions"].strip():
            raise JevError("invalid", f"La pregunta «{ident}» no tiene instrucciones.")
        criteria = question.get("criteria")
        kind = question["type"]
        if kind == "choice" and not (isinstance(criteria, dict) and 2 <= len(criteria) <= 255
                                     and all(isinstance(k, str) and k and (v is None or isinstance(v, str)) for k, v in criteria.items())):
            raise JevError("invalid", f"La pregunta «{ident}» necesita entre 2 y 255 opciones descritas con texto o null.")
        if kind == "score" and not (isinstance(criteria, list) and 2 <= len(criteria) <= 10 and all(isinstance(level, str) and level for level in criteria)):
            raise JevError("invalid", f"La pregunta «{ident}» necesita entre 2 y 10 niveles ordenados.")
        if kind == "noul" and criteria is not None and not (isinstance(criteria, dict) and set(criteria) <= {"true", "false"}
                                                            and all(isinstance(v, str) for v in criteria.values())):
            raise JevError("invalid", f"La pregunta «{ident}» solo admite los criterios true y false.")
    return questions


def trim(state: object, limit: int = STATE_LIMIT) -> object:
    """The state, with its longest texts shortened until it serializes under `limit` characters; JevError when it
    is not plain JSON or cannot be brought under the limit by shortening texts."""
    try:
        size = len(json.dumps(state, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError) as error:
        raise JevError("invalid", "El estado para Jev no es JSON (o lleva NaN o infinito).") from error
    if size <= limit:
        return state
    state = json.loads(json.dumps(state, allow_nan=False))  # a copy: the caller's data is never shortened in place

    def strings(node, path=()):
        if isinstance(node, str):
            yield path, node
        elif isinstance(node, dict):
            for key, value in node.items():
                yield from strings(value, (*path, key))
        elif isinstance(node, list):
            for index, value in enumerate(node):
                yield from strings(value, (*path, index))

    def put(path, value):
        nonlocal state
        if not path:
            state = value
            return
        node = state
        for step in path[:-1]:
            node = node[step]
        node[path[-1]] = value

    for _ in range(200):
        size = len(json.dumps(state, ensure_ascii=False, allow_nan=False))
        if size <= limit:
            return state
        path, text = max(strings(state), key=lambda found: len(found[1]), default=((), ""))
        if len(text) <= 1:
            break
        put(path, text[: max(0, len(text) - (size - limit) - 1, len(text) // 2)] + "…")
    raise JevError("invalid", "El estado para Jev es demasiado grande.")


def _probabilities(found: object, allowed: set[str] | None) -> dict[str, float] | None:
    if not isinstance(found, dict) or not found:
        return None
    clean = {}
    for name, value in found.items():
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 <= value <= 1 or (allowed is not None and name not in allowed):
            return None
        clean[str(name)] = float(value)
    return clean


def _unit(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1 else None


def _answer(question: dict, found: object) -> dict | None:
    """One answer checked against its question, or None when it does not fit."""
    if not isinstance(found, dict):
        return None
    kind = question["type"]
    if kind == "noul":
        value = _unit(found.get("noul"))
        return None if value is None else {"type": "noul", "value": value, "confidence": None, "probabilities": None}
    confidence = _unit(found.get("confidence"))
    if confidence is None:
        return None
    if kind == "choice":
        options = set(question["criteria"])
        probabilities = _probabilities(found.get("probabilities"), options)
        if not isinstance(found.get("choice"), str) or found["choice"] not in options or probabilities is None:
            return None
        return {"type": "choice", "value": found["choice"], "confidence": confidence, "probabilities": probabilities}
    score = found.get("score")
    levels = len(question["criteria"])
    if not isinstance(score, (int, float)) or isinstance(score, bool) or not 0 <= score <= levels - 1:
        return None
    probabilities = _probabilities(found.get("probabilities"), None)
    if probabilities is None:
        return None
    legend = found.get("legend")
    legend = ({str(k)[:20]: v[:100] for k, v in legend.items() if isinstance(v, str)}
              if isinstance(legend, dict) and len(legend) <= levels else None)
    return {"type": "score", "value": float(score), "confidence": confidence, "probabilities": probabilities, "legend": legend}


def _parse(data: object, questions: dict) -> Answer:
    """Jev's answer checked; anything odd in it ends as JevError('invalid'), never as another exception."""
    try:
        return _checked(data, questions)
    except JevError:
        raise
    except (TypeError, ValueError, AttributeError, KeyError) as error:
        raise JevError("invalid", "Jev devolvió una respuesta que no se entiende.") from error


def _checked(data: object, questions: dict) -> Answer:
    if not isinstance(data, dict) or not isinstance(data.get("answers"), dict):
        raise JevError("invalid", "Jev devolvió una respuesta que no se entiende.")
    model = data.get("model")
    used = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    tokens = lambda name: used.get(name) if isinstance(used.get(name), int) and used.get(name) >= 0 else 0  # noqa: E731
    answers = {}
    for ident, question in questions.items():
        checked = _answer(question, data["answers"].get(ident))
        if checked is not None:
            answers[ident] = checked
    return Answer(model=model[:60] if isinstance(model, str) and model else "desconocido", answers=answers,
                  input_tokens=tokens("input_tokens"), output_tokens=tokens("output_tokens"))


# ---- HTTP --------------------------------------------------------------------------------------------------------

def _said(answer: httpx.Response, key: str) -> str:
    """TypeSafe's short reason for an error: only the field and the message, never the values it echoes (they can
    be the text of a mail), and never the key."""
    try:
        data = answer.json()
    except ValueError:
        return ""
    parts: list[str] = []
    detail = data.get("detail") if isinstance(data, dict) else None
    if isinstance(detail, list):
        for item in detail[:3]:
            if isinstance(item, dict):
                where = ".".join(str(step) for step in item.get("loc") or [] if isinstance(step, (str, int)))
                parts.append(f"{where}: {item.get('msg')}" if where else str(item.get("msg") or ""))
    elif isinstance(data, dict):
        reason = data.get("error") or data.get("message") or detail or ""
        if isinstance(reason, dict):
            reason = reason.get("message") or reason.get("type") or ""
        parts.append(str(reason))
    text = " ".join(" ".join(parts).split())[:200]
    return text.replace(key, "***") if key else text


def _request(method: str, path: str, key: str, body: dict | None, client: httpx.Client | None, before_retry=None) -> dict | list:
    """One request with a single retry after 429 or 529 (`before_retry` runs first: it counts the retry against the
    allowance and may refuse it), all within TOTAL seconds; JevError with its state on anything else."""
    if not key:
        raise JevError("auth", "Falta la clave de API de TypeSafe.")
    late = "Jev no respondió a tiempo: sigue la lógica de siempre."
    deadline = time.monotonic() + TOTAL
    own = client is None
    client = client or httpx.Client(verify=tls.client_context())
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json", "User-Agent": USER_AGENT}
    try:
        for attempt in (1, 2):
            left = deadline - time.monotonic()
            if left <= 0 or not PARALLEL.acquire(timeout=left):
                raise JevError("unreachable", late)
            try:
                left = max(0.1, deadline - time.monotonic())
                timeout = httpx.Timeout(min(TIMEOUT.read, left), connect=min(TIMEOUT.connect, left))
                answer = client.request(method, f"{API}{path}", json=body, headers=headers, timeout=timeout, follow_redirects=False)
            except httpx.TimeoutException as error:
                raise JevError("unreachable", late) from error
            except httpx.HTTPError as error:
                raise JevError("unreachable", "No se pudo conectar con Jev: sigue la lógica de siempre.") from error
            finally:
                PARALLEL.release()
            if answer.status_code in (429, 529) and attempt == 1 and deadline - time.monotonic() > RETRY_PAUSE + 1:
                if before_retry:
                    before_retry()
                time.sleep(RETRY_PAUSE)
                continue
            break
    finally:
        if own:
            client.close()
    status = answer.status_code
    if status in (401, 403):
        raise JevError("auth", "TypeSafe no acepta la clave de API: créala otra vez en console.typesafe.ai y guárdala aquí.")
    if status == 429:
        raise JevError("limit", "TypeSafe pide esperar (demasiadas peticiones): sigue la lógica de siempre.")
    if status == 529 or status >= 500:
        raise JevError("overloaded", f"Jev está sobrecargado o no responde bien ({status}): sigue la lógica de siempre.")
    if not 200 <= status < 300:
        said = _said(answer, key)
        raise JevError("invalid", f"TypeSafe rechazó la petición ({status}{': ' + said if said else ''}).")
    try:
        data = answer.json()
    except ValueError as error:
        raise JevError("invalid", "Jev devolvió una respuesta que no se entiende.") from error
    if not isinstance(data, (dict, list)):
        raise JevError("invalid", "Jev devolvió una respuesta que no se entiende.")
    return data


def models(key: str, client: httpx.Client | None = None) -> list[str]:
    """The aliases of the account (`GET /v1/models`), used by «Probar»: it costs no tokens."""
    data = _request("GET", "/models", key, None, client)
    found = data.get("models", data.get("data", [])) if isinstance(data, dict) else data
    names = []
    for item in found if isinstance(found, list) else []:
        name = item if isinstance(item, str) else (item.get("name") or item.get("id")) if isinstance(item, dict) else None
        if isinstance(name, str) and name:
            names.append(name[:60])
    return names


def ask(connection: sqlite3.Connection, key: str, state: object, questions: dict, *, level: str, point: str,
        max_chars: int = STATE_LIMIT, client: httpx.Client | None = None) -> Answer:
    """Asks Jev `questions` about `state`. Refused before anything leaves this Mac when the level is not normal,
    when the module or the point is off, or when the allowance is used up. `state` holds the text as data in named
    fields; the questions never carry text from mail, chats or notes.

    Each thread must pass its own connection: the allowance is counted with `BEGIN IMMEDIATE` transactions and
    sqlite3 connections are not shared between threads here."""
    if level != "normal":
        raise JevError("private", "Solo lo de nivel normal puede ir a Jev.")
    if point not in POINTS:
        raise JevError("invalid", "Ese punto de decisión no existe.")
    if not modules.state(connection).get("jev", True):
        raise JevError("off", "El módulo Jev está apagado.")
    current = settings(connection)
    if not current["points"][point]:
        raise JevError("off", "Jev está apagado para este punto de decisión.")
    if not key:
        raise JevError("auth", "Falta la clave de API de TypeSafe.")
    checked = check_questions(questions)
    body = {"model": current["model"], "state": trim(state, max_chars), "questions": checked}
    _reserve(connection, current["monthlyUsd"])
    found = _parse(_request("POST", "/systemone", key, body, client, lambda: _reserve(connection, current["monthlyUsd"])), checked)
    try:
        _spend(connection, found.input_tokens, found.output_tokens)
    except sqlite3.Error as error:
        # The answer is paid for: it is kept and only this month's count stays a little short.
        print(f"AgoraOne núcleo: no se pudo anotar el gasto de Jev ({type(error).__name__}).", file=sys.stderr)
    return found


def record(connection: sqlite3.Connection, subject: str, subject_id: str | int, purpose: str, found: Answer, applied: bool) -> int:
    """Keeps what Jev answered (never the state that was sent) and whether it decided (`applied`) or only shadowed."""
    if subject not in SUBJECTS:
        raise JevError("invalid", f"Sujeto desconocido para Jev: {subject}")
    try:
        cursor = connection.execute(
            "INSERT INTO jev_decision (subject, subject_id, purpose, answers, model, input_tokens, output_tokens, applied, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (subject, str(subject_id)[:200], str(purpose)[:60], json.dumps(found.answers, allow_nan=False), found.model, found.input_tokens, found.output_tokens, int(applied), now()))
    except (TypeError, ValueError, sqlite3.Error) as error:
        raise JevError("storage", "No se pudo guardar la decisión de Jev.") from error
    return int(cursor.lastrowid)
