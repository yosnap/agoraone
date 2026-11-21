"""The reduced shapes of what CRMDev answers: only what the views show, text cut, missing fields as None. Lists that
go to the screen carry no assignee's, member's or guest's address; a client's address only with `contact` (its
record, hidden in discreet mode). The guest's name (`requester`) is hidden in discreet mode by the screen."""

from collections.abc import Callable

from .crmdev_api import ID, MAX_ROWS, ODD
from .web_api import WebApiError

TITLE, DESCRIPTION, SHORT = 300, 4000, 120
HOURS_ROWS = 500


def _text(value: object, limit: int = SHORT) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:limit] if text else None


def row_id(value: object) -> str | None:
    return value if isinstance(value, str) and ID.fullmatch(value) else None


def _number(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _name_of(value: object) -> str | None:
    return _text(value.get("name")) if isinstance(value, dict) else None


def shape_project(row: dict) -> dict:
    progress = _number(row.get("progress"))
    return {"id": row_id(row.get("id")), "name": _text(row.get("name"), TITLE), "status": _text(row.get("status")),
            "progress": progress if progress is not None and 0 <= progress <= 100 else None, "type": _text(row.get("type")),
            "deadline": _text(row.get("deadline"))}


def project_id(row: dict) -> str | None:
    """The CRMDev id of a task's or ticket's project (for «Lanzar en Orca» through the pair of projects)."""
    found = row.get("projectId")
    if found is None and isinstance(row.get("project"), dict):
        found = row["project"].get("id")
    return row_id(found)


def shape_task(row: dict) -> dict:
    assignee = row.get("assignee") if isinstance(row.get("assignee"), dict) else {}
    return {"id": row_id(row.get("id")), "title": _text(row.get("title"), TITLE), "description": _text(row.get("description"), DESCRIPTION),
            "status": _text(row.get("status")), "priority": _text(row.get("priority")), "dueDate": _text(row.get("dueDate")),
            "assignee": {"id": row_id(assignee.get("id")), "name": _text(assignee.get("name"))} if assignee else None,
            "project": _name_of(row.get("project")), "projectId": project_id(row)}


def shape_client(row: dict, contact: bool = False) -> dict:
    shaped = {"id": row_id(row.get("id")), "name": _text(row.get("name"), TITLE), "company": _text(row.get("company"), TITLE),
              "status": _text(row.get("status"))}
    return {**shaped, "email": _text(row.get("email"), TITLE)} if contact else shaped


def shape_ticket(row: dict) -> dict:
    return {"id": row_id(row.get("id")), "title": _text(row.get("title"), TITLE), "description": _text(row.get("description"), DESCRIPTION),
            "status": _text(row.get("status")), "priority": _text(row.get("priority")), "category": _text(row.get("category")),
            "requester": _text(row.get("guestName"), TITLE), "client": _name_of(row.get("client")), "project": _name_of(row.get("project")),
            "projectId": project_id(row),
            "createdAt": _text(row.get("createdAt")), "updatedAt": _text(row.get("updatedAt"))}


def shape_member(row: dict) -> dict:
    user = row.get("user") if isinstance(row.get("user"), dict) else {}
    return {"id": row_id(user.get("id")), "name": _text(user.get("name"), TITLE), "role": _text(row.get("role"))}


def shape_hours(data: object) -> dict:
    data = data if isinstance(data, dict) else {}
    entries = data.get("entries") if isinstance(data.get("entries"), list) else []
    # `cut`: only the first rows are shown, so the total and the count of entries are CRMDev's, not those rows'.
    return {"project": _text(data.get("projectName"), TITLE), "total": _text(data.get("totalHours")), "entries": _number(data.get("totalEntries")),
            "rows": [{"task": _text(e.get("task"), TITLE), "user": _text(e.get("user")), "minutes": _number(e.get("minutes"))}
                     for e in entries[:HOURS_ROWS] if isinstance(e, dict)], "cut": len(entries) > HOURS_ROWS}


def shape_list(shape: Callable[[dict], dict], data: object) -> list[dict]:
    if not isinstance(data, list):
        raise WebApiError("error", ODD)
    return [shape(row) for row in data[:MAX_ROWS] if isinstance(row, dict)]
