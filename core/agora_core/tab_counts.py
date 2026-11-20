"""The counters of the tabs (Trabajos › Clientes, Central and CRMDev), from what AgoraOne already keeps: the directory
of clients and the snapshots of Central and CRMDev. Nothing is asked to Central nor CRMDev here, so a counter never
spends their limits; a tab whose number is not known shows none. Only numbers: also in discreet mode."""

import sqlite3

from . import central, clients, crmdev_sync


def build(connection: sqlite3.Connection) -> dict:
    entries = clients.directory(connection)
    mine = central.snapshot(connection)
    theirs = crmdev_sync.snapshot(connection)
    found: dict = {"clientes": len(entries), "central": None, "crmdev": None}
    if mine is not None:
        found["central"] = {"clientes": len(mine.get("clients") or []), "proyectos": len(mine.get("projects") or []),
                            "webs": sum(len(c.get("websites") or []) for c in mine.get("clients") or []),
                            "servidores": len(mine.get("servers") or [])}
    if theirs is not None:
        counts = theirs.get("counts") or {}
        found["crmdev"] = {"clientes": len(theirs.get("clients") or []), "clientesMore": bool(theirs.get("truncated")),
                           "proyectos": len(theirs.get("projects") or []), "proyectosMore": bool(theirs.get("projectsTruncated")),
                           **{name: (counts.get(name) or {}).get("n") for name in ("tareas", "tickets")},
                           **{f"{name}More": bool((counts.get(name) or {}).get("more")) for name in ("tareas", "tickets")}}
    return found
