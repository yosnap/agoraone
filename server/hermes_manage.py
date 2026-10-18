"""Manage a profile's scheduled tasks and its kanban cards with Hermes' own functions (one request per run).

Input (stdin, JSON): {"profile": <dir name>, "kind": "job" | "card", "action": ..., ...fields}. Output: one JSON
line {"ok": true, ...} or {"ok": false, "error": <message for the user>}.

Scheduled tasks go through the same ``cronjob`` tool the profile's bot uses (its validation, locks and
storage), pointed at that profile's own store. Kanban cards go through Hermes' kanban database API on the
shared default board, and only cards assigned to this profile can be changed. Nothing here starts an agent:
«run now» only marks the task (``trigger_job``) for the gateway's next tick, and a new card is picked up by
Hermes' dispatcher. Every task action runs scoped to the profile's home, as Hermes' own cron ticker does.
"""
import contextlib
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

EXPECTED_COMMIT = "28aceb3451"
TEXT = 4000  # longest prompt, card body or comment accepted


class UserError(Exception):
    pass


def text(request, key, limit, required=False):
    value = request.get(key)
    if value is None or value == "":
        if required:
            raise UserError("Falta un dato obligatorio.")
        return None
    if not isinstance(value, str) or len(value) > limit or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
        raise UserError("Hay un dato demasiado largo o con caracteres no válidos.")
    return value.strip()


def spanish(message):
    """Hermes answers in English; the user reads Spanish. Known causes are explained, the rest stays generic."""
    text = str(message or "").lower()
    if "schedule" in text or "cron expression" in text or "croniter" in text:
        return "Hermes no reconoce ese horario. Prueba, por ejemplo, «every 2h», «0 9 * * *» o «30m»."
    if "terminal" in text or "cannot run" in text:
        return "Esa tarea ya terminó y no se puede volver a ejecutar; crea una nueva."
    if "not found" in text or "no job" in text:
        return "Esa tarea programada no existe en este perfil."
    if "prompt" in text and ("scan" in text or "blocked" in text or "unsafe" in text):
        return "Hermes rechazó las instrucciones de la tarea por motivos de seguridad."
    return "Hermes rechazó la operación."


def tool_result(raw):
    data = json.loads(raw) if isinstance(raw, str) else raw
    if isinstance(data, dict) and (data.get("success") is False or data.get("error")):
        raise UserError(spanish(data.get("error") or data.get("message")))
    return data


def revision(prompt):
    return hashlib.sha256((prompt or "").encode("utf-8")).hexdigest()[:24]


@contextlib.contextmanager
def profile_scope(home):
    """The profile's home and cron store, like Hermes' ``_profile_cron_scope``."""
    from cron.jobs import use_cron_store
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    token = set_hermes_home_override(str(home))
    try:
        with use_cron_store(home):
            yield
    finally:
        reset_hermes_home_override(token)


def job(request, home):
    from cron.jobs import list_jobs, trigger_job
    from tools.cronjob_tools import cronjob
    action = request.get("action")
    with profile_scope(home):
        known = {item.get("id"): item for item in list_jobs(include_disabled=True)}
        if action == "create":
            # The result stays in Hermes (deliver «local»): AgoraOne has no chat to send it to.
            data = tool_result(cronjob(action="create", name=text(request, "name", 100, True),
                                       schedule=text(request, "schedule", 120, True), prompt=text(request, "prompt", TEXT, True),
                                       deliver="local"))
            return {"job": (data.get("job") or {}).get("id") or data.get("job_id")}
        job_id = text(request, "jobId", 80, True)
        if job_id not in known:  # only this profile's own tasks, by exact id
            raise UserError("Esa tarea programada no existe en este perfil.")
        current = known[job_id]
        if action == "detail":
            schedule = current.get("schedule_display") or ""
            return {"job": {"id": job_id, "name": current.get("name") or "", "prompt": current.get("prompt") or "",
                            "revision": revision(current.get("prompt")),
                            # A one-time schedule is shown as «once …», which Hermes cannot read back: not offered for editing.
                            "schedule": "" if schedule.startswith("once") else schedule, "once": schedule.startswith("once")}}
        if action == "update":
            # The instructions the user edited must still be the stored ones (hidden lines are restored from them).
            if request.get("prompt") is not None and request.get("revision") != revision(current.get("prompt")):
                raise UserError("Las instrucciones de la tarea cambiaron mientras las editabas. Vuelve a abrirla para ver la versión actual.")
            tool_result(cronjob(action="update", job_id=job_id, name=text(request, "name", 100),
                                schedule=text(request, "schedule", 120), prompt=text(request, "prompt", TEXT)))
        elif action == "run":
            # Only marks it: the gateway runs it on its next tick, with the profile's own configuration.
            try:
                if not trigger_job(job_id):
                    raise UserError("Esa tarea programada no existe en este perfil.")
            except ValueError:
                raise UserError("Esa tarea ya terminó y no se puede volver a ejecutar; crea una nueva.")
        elif action in ("pause", "resume", "remove"):
            tool_result(cronjob(action=action, job_id=job_id, reason="Pausada desde AgoraOne" if action == "pause" else None))
        else:
            raise UserError("Acción no válida.")
        return {"job": job_id}


def card(request, profile):
    from hermes_cli import kanban_db as kb
    from hermes_cli.kanban_db_connect import connect
    action = request.get("action")
    conn = connect(board="default")
    try:
        if action == "create":
            task_id = kb.create_task(conn, title=text(request, "title", 200, True), body=text(request, "body", TEXT),
                                     assignee=profile, created_by="agoraone")
            return {"card": task_id}
        task_id = text(request, "cardId", 80, True)
        task = kb.get_task(conn, task_id)
        if task is None or getattr(task, "assignee", None) != profile:  # only cards of this profile
            raise UserError("Esa tarjeta no existe o no está asignada a este perfil.")
        if action == "complete":
            try:
                done = kb.complete_task(conn, task_id, summary="Completada desde AgoraOne")
            except Exception as error:
                if type(error).__name__ == "LiveClaimError":
                    raise UserError("Un agente está trabajando ahora en esa tarjeta; espera a que termine para completarla.")
                raise
        elif action == "block":
            done = kb.block_task(conn, task_id, reason=text(request, "reason", 500) or "Bloqueada desde AgoraOne")
        elif action == "unblock":
            done = kb.unblock_task(conn, task_id)
        elif action == "archive":
            done = kb.archive_task(conn, task_id)
        elif action == "comment":
            kb.add_comment(conn, task_id, "AgoraOne", text(request, "body", TEXT, True))
            done = True
        else:
            raise UserError("Acción no válida.")
        if not done:
            raise UserError("La tarjeta no admite ese cambio en su estado actual.")
        return {"card": task_id}
    finally:
        conn.close()


def main(request):
    installation = Path(os.environ["AGORA_HERMES_PATH"]).resolve()
    revision = subprocess.check_output(["/usr/bin/git", "-C", str(installation), "rev-parse", "HEAD"], text=True).strip()
    if not revision.startswith(EXPECTED_COMMIT):
        raise UserError("La versión de Hermes instalada no está verificada para AgoraOne.")
    sys.path.insert(0, str(installation))
    profile = request.get("profile")
    if not isinstance(profile, str) or not re.fullmatch(r"(?!\.)[A-Za-z0-9_.-]{1,64}", profile):
        raise UserError("Perfil no válido.")
    from hermes_cli.profiles import get_profile_dir
    home = Path(get_profile_dir(profile))
    if request.get("kind") == "job":
        return job(request, home)
    if request.get("kind") == "card":
        return card(request, profile)
    raise UserError("Operación no válida.")


if __name__ == "__main__":
    out = sys.stdout
    with contextlib.redirect_stdout(sys.stderr):
        try:
            result = {"ok": True, **main(json.loads(sys.stdin.read()))}
        except UserError as error:
            result = {"ok": False, "error": str(error)}
        except Exception:
            import traceback
            traceback.print_exc()  # stderr only: the server discards it, never shown to the user
            result = {"ok": False, "error": "Hermes no pudo completar la operación."}
    print(json.dumps(result, ensure_ascii=False), file=out)
