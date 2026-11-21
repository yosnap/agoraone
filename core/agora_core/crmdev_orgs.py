"""The organizations of CRMDev AgoraOne knows (user's decision, 21/11/2026). A key of CRMDev (`crm_…`) belongs to one
organization and CRMDev's API does not say which, so the user names each one here. CRMDev's address is one for all
(`crmdev_api.SETTING`); each organization has its own key in the secret store, under its own account: the first one
keeps `crmdev-api-key`, so the key saved before organizations existed is still the first organization's.

`crmdev.orgs` in `setting`: `[{id, name}]`, ids given here (`o1`, `o2`…), never a path nor anything of CRMDev. With an
address saved and no list yet (the connection made before), there is one organization, «Organización 1», which the user
may rename. A key never travels to another address: `web_api` keeps that rule for each organization's key alike."""

import dataclasses
import json
import re
import sqlite3

from . import crmdev_api, web_api
from .db import transaction

SETTING = "crmdev.orgs"
FIRST = "o1"
DEFAULT_NAME = "Organización 1"
NAME_CHARS = 80
ID = re.compile(r"^o[1-9][0-9]{0,3}$")


class OrgError(ValueError):
    pass


def _saved(connection: sqlite3.Connection) -> list[dict] | None:
    row = connection.execute("SELECT value FROM setting WHERE key = ?", (SETTING,)).fetchone()
    try:
        found = json.loads(row["value"]) if row else None
    except (TypeError, ValueError):
        return None
    if not isinstance(found, list):
        return None
    return [{"id": o["id"], "name": o["name"]} for o in found
            if isinstance(o, dict) and isinstance(o.get("id"), str) and ID.fullmatch(o["id"]) and isinstance(o.get("name"), str)]


def orgs(connection: sqlite3.Connection) -> list[dict]:
    """The organizations, in the order they were added; none while CRMDev has no address saved."""
    saved = _saved(connection)
    if saved:
        return saved
    return [{"id": FIRST, "name": DEFAULT_NAME}] if crmdev_api.saved_url(connection) else []


def default(connection: sqlite3.Connection) -> str | None:
    """The organization used where none is chosen yet: the first one."""
    found = orgs(connection)
    return found[0]["id"] if found else None


def known(connection: sqlite3.Connection, org: str | None) -> bool:
    return org is not None and any(o["id"] == org for o in orgs(connection))


def name_of(connection: sqlite3.Connection, org: str | None) -> str | None:
    return next((o["name"] for o in orgs(connection) if o["id"] == org), None)


def secret_of(org: str) -> str:
    return crmdev_api.SECRET if org == FIRST else f"{crmdev_api.SECRET}-{org}"


def spec_of(org: str) -> web_api.WebApiSpec:
    """CRMDev's shared spec with this organization's account in the secret store."""
    return dataclasses.replace(crmdev_api.SPEC, secret=secret_of(org))


def connection_of(connection: sqlite3.Connection, secrets, org: str | None = None) -> web_api.Connection | None:
    """The address and this organization's key (the first one when none is said); None without both."""
    org = org or default(connection)
    if org is None or not known(connection, org):
        return None
    return web_api.connection_of(spec_of(org), connection, secrets)


def _clean_name(name: object) -> str:
    if not isinstance(name, str):
        raise OrgError("El nombre de la organización tiene que ser texto.")
    text = " ".join(name.split())[:NAME_CHARS]
    if not text or any(ord(c) < 32 for c in text):
        raise OrgError("Escribe el nombre de la organización tal como se llama en CRMDev.")
    return text


def _write(connection: sqlite3.Connection, found: list[dict]) -> None:
    with transaction(connection):
        connection.execute("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                           (SETTING, json.dumps(found, ensure_ascii=False)))


def add(connection: sqlite3.Connection, secrets, name: object, key: object) -> dict:
    """A new organization with its own key (checked like any key of CRMDev); needs CRMDev's address saved."""
    if not crmdev_api.saved_url(connection):
        raise OrgError("Guarda antes la dirección de CRMDev.")
    clean = _clean_name(name)
    current = orgs(connection)
    if any(o["name"].casefold() == clean.casefold() for o in current):
        raise OrgError("Ya hay una organización con ese nombre.")
    problem = web_api.key_problem(crmdev_api.SPEC, key)
    if problem:
        raise OrgError(problem)
    used = {int(o["id"][1:]) for o in current}
    org = {"id": f"o{next(n for n in range(1, 10000) if n not in used)}", "name": clean}
    web_api.write_key(spec_of(org["id"]), secrets, str(key).strip())
    _write(connection, [*current, org])
    crmdev_api.clear_cache()
    return org


def rename(connection: sqlite3.Connection, org: str, name: object) -> None:
    current = orgs(connection)
    if not any(o["id"] == org for o in current):
        raise OrgError("Esa organización ya no está.")
    clean = _clean_name(name)
    if any(o["name"].casefold() == clean.casefold() and o["id"] != org for o in current):
        raise OrgError("Ya hay una organización con ese nombre.")
    _write(connection, [{**o, "name": clean} if o["id"] == org else o for o in current])


def set_key(connection: sqlite3.Connection, secrets, org: str, key: object) -> None:
    if not known(connection, org):
        raise OrgError("Esa organización ya no está.")
    problem = web_api.key_problem(crmdev_api.SPEC, key)
    if problem:
        raise OrgError(problem)
    web_api.write_key(spec_of(org), secrets, str(key).strip())
    if _saved(connection) is None:
        _write(connection, orgs(connection))  # the implicit first organization becomes a saved one
    crmdev_api.clear_cache()


def forget_others(connection: sqlite3.Connection, secrets) -> None:
    """«Olvidar» CRMDev, or its address moved to another server: every organization's key but the first one's (which
    the connector itself handles) leaves the store, and the list goes back to the single first organization."""
    for org in orgs(connection):
        if org["id"] != FIRST:
            web_api.write_key(spec_of(org["id"]), secrets, None)
    with transaction(connection):
        connection.execute("DELETE FROM setting WHERE key = ?", (SETTING,))
    crmdev_api.clear_cache()


def forget(connection: sqlite3.Connection, secrets, org: str) -> None:
    """Forgets one organization: its key goes from the store; what was read of it stays (as with any connector) until
    the next reading, and nothing is deleted in CRMDev. The first organization is forgotten with the whole connector."""
    current = orgs(connection)
    if not any(o["id"] == org for o in current):
        raise OrgError("Esa organización ya no está.")
    if len(current) == 1:
        raise OrgError("Es la única organización: para quitarla, olvida CRMDev en Conectores.")
    web_api.write_key(spec_of(org), secrets, None)
    _write(connection, [o for o in current if o["id"] != org])
    crmdev_api.clear_cache()
