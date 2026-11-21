"""The organization of CRMDev each client and project of Central belongs to (user's decision, 21/11/2026): one only,
and AgoraOne remembers it. Where it comes from, in this order:
- `link`: the record is linked with one of an organization's records (its CRMDev client, or the people of its company
  when all are in one organization; its CRMDev project): that organization, whatever was chosen before;
- `chosen`: the user chose it (`crmdev_org_assignment`), in «Sin organización» or when sending there;
- `client`: a project with neither goes with its client's organization.
Without any, it is in no organization («Sin organización») until the user chooses one. An organization that was
forgotten is no organization. Only ids are kept; nothing here reads or writes CRMDev."""

import re
import sqlite3

from . import crmdev_orgs
from .db import now, transaction

KINDS = ("client", "project")
CENTRAL_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
# The warnings of «Pendiente en CRMDev» that may have no organization yet: what is still missing in CRMDev.
UNPLACED_KINDS = {"client_missing": "client", "project_missing": "project"}


def chosen(connection: sqlite3.Connection) -> dict[tuple[str, str], str]:
    """(kind, central id) → organization, only of the organizations that are still known."""
    known = {o["id"] for o in crmdev_orgs.orgs(connection)}
    return {(r["kind"], r["central_id"]): r["org"] for r in connection.execute("SELECT kind, central_id, org FROM crmdev_org_assignment")
            if r["org"] in known}


def target_of(key: str) -> tuple[str, str] | None:
    """The record a warning without organization is about: (kind, central id), or None for any other warning."""
    kind, _, rest = key.partition(":")
    if kind not in UNPLACED_KINDS or not CENTRAL_ID.fullmatch(rest):
        return None
    return UNPLACED_KINDS[kind], rest


def assign(connection: sqlite3.Connection, targets: list[tuple[str, str]], org: str | None) -> int:
    """Remembers `org` for each (kind, central id), or forgets the choice with None; returns how many."""
    if org is not None and not crmdev_orgs.known(connection, org):
        raise crmdev_orgs.OrgError("Esa organización ya no está.")
    clean = list(dict.fromkeys(t for t in targets if t[0] in KINDS and CENTRAL_ID.fullmatch(t[1])))
    with transaction(connection):
        for kind, central_id in clean:
            if org is None:
                connection.execute("DELETE FROM crmdev_org_assignment WHERE kind = ? AND central_id = ?", (kind, central_id))
            else:
                connection.execute("INSERT INTO crmdev_org_assignment (kind, central_id, org, created_at) VALUES (?, ?, ?, ?) "
                                   "ON CONFLICT (kind, central_id) DO UPDATE SET org = excluded.org, created_at = excluded.created_at",
                                   (kind, central_id, org, now()))
    return len(clean)
