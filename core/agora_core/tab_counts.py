"""The counters of the tabs (Trabajos › Clientes, Central and CRMDev), from what AgoraOne already keeps: the directory
of clients and the snapshots of Central and CRMDev. Nothing is asked to Central nor CRMDev here, so a counter never
spends their limits; a tab whose number is not known shows none. Only numbers: also in discreet mode.

`crmdev` is the first organization's; `crmdevOrgs` has the same counters for each organization read at least once (the
section shows those of the organization chosen), «Desde Central» counting what is about it and what is about none."""

import sqlite3

from . import central, client_births, clients, crmdev_pending, crmdev_sync


def _crmdev(snap: dict) -> dict:
    counts = snap.get("counts") or {}
    return {"clientes": len(snap.get("clients") or []), "clientesMore": bool(snap.get("truncated")),
            "proyectos": len(snap.get("projects") or []), "proyectosMore": bool(snap.get("projectsTruncated")),
            **{name: (counts.get(name) or {}).get("n") for name in ("tareas", "tickets")},
            **{f"{name}More": bool((counts.get(name) or {}).get("more")) for name in ("tareas", "tickets")}}


def build(connection: sqlite3.Connection) -> dict:
    entries = clients.directory(connection)
    mine = central.snapshot(connection)
    theirs = crmdev_sync.snapshot(connection)
    found: dict = {"clientes": len(entries), "central": None, "crmdev": None, "crmdevOrgs": {}}
    if mine is not None:
        found["central"] = {"clientes": len(mine.get("clients") or []), "proyectos": len(mine.get("projects") or []),
                            "webs": sum(len(c.get("websites") or []) for c in mine.get("clients") or []),
                            "servidores": len(mine.get("servers") or []),
                            # «Por crear»: clients kept here or of CRMDev without Central, and the proposals not dismissed.
                            "por-crear": sum(1 for e in entries if not e.get("centralId") and (e.get("localId") or e.get("crmdevId")))
                            + len(client_births.build(connection)["items"])}
    every = crmdev_sync.snapshots(connection)
    pending = crmdev_pending.build(connection) if mine is not None and every else None
    shown = [i for i in pending["items"] if not i["dismissed"]] if pending and pending["active"] else None
    if theirs is not None:
        found["crmdev"] = {**_crmdev(theirs), "central": len(shown) if shown is not None else None}
    for org, snap in every.items():
        found["crmdevOrgs"][org] = {**_crmdev(snap),
                                    "central": sum(1 for i in shown if i["org"] in (org, None)) if shown is not None else None}
    return found
