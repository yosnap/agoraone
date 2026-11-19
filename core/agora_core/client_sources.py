"""How the directory joins its three sources (Central, CRMDev and the clients kept in AgoraOne) without duplicates.

Every client of each source starts on its own; a group holds at most one of each source. Groups are joined first by
the links the user confirmed («Enlazar», and the client just created from one kept here), then automatically: a
CRMDev client with one of Central's by the same name, else by the same exact address when that address is the only one
on both sides (CRMDev has no tax id); then each client kept here with a remote group by the same name, else by the
only one with its tax id (Central's), else by the only one with its exact address. A pair the user said are different
(«Son distintos») is never joined. Names that are only alike (accents, signs) become a suggestion.

In the entry of a group, Central rules in the tax and contact data, its projects and websites; CRMDev adds its
commercial state and fills what Central has empty; a client kept here fills what is still empty. When Central and
CRMDev disagree on a field, the entry says so (`differences`) without changing either. Nothing is synchronized."""

from .clients import loose, same_name, tax_key

KINDS = ("central", "crmdev", "local")
COMPARED = (("name", "Nombre"), ("company", "Empresa"), ("email", "Correo"))


def _email(value) -> str | None:
    return (value or "").strip().lower() or None


class Links:
    """The pairs the user confirmed or rejected: `local_crmdev[client_id] = {"linked": id | None, "distinct": set}` and
    `central_crmdev[(central_id, crmdev_id)] = "linked" | "distinct"`. Central's own pairs come with each local row
    (`centralId`, `distinct`)."""

    def __init__(self, local_crmdev: dict | None = None, central_crmdev: dict | None = None):
        self.local_crmdev = local_crmdev or {}
        self.central_crmdev = central_crmdev or {}

    def distinct(self, a: tuple[str, dict], b: tuple[str, dict]) -> bool:
        (kind_a, row_a), (kind_b, row_b) = sorted((a, b), key=lambda item: KINDS.index(item[0]))
        if (kind_a, kind_b) == ("central", "local"):
            return row_a["id"] in row_b["distinct"]
        if (kind_a, kind_b) == ("crmdev", "local"):
            return row_a["id"] in self.local_crmdev.get(row_b["localId"], {}).get("distinct", set())
        if (kind_a, kind_b) == ("central", "crmdev"):
            return self.central_crmdev.get((row_a["id"], row_b["id"])) == "distinct"
        return False


class _Groups:
    def __init__(self, links: Links):
        self.links = links
        self.order: list[dict] = []
        self.of: dict[tuple, dict] = {}
        self.keys: dict[int, object] = {}  # each row's own key (a Central client may come without an id)

    def add(self, kind: str, key, row: dict) -> None:
        group = {kind: row}
        key = key if key is not None else object()
        self.keys[id(row)] = key
        self.order.append(group)
        self.of[(kind, key)] = group

    def get(self, kind: str, key) -> dict | None:
        return self.of.get((kind, key))

    def can_join(self, a: dict, b: dict) -> bool:
        if a is b or set(a) & set(b):
            return False
        return not any(self.links.distinct((ka, ra), (kb, rb)) for ka, ra in a.items() for kb, rb in b.items())

    def join(self, a: dict | None, b: dict | None) -> bool:
        if a is None or b is None or not self.can_join(a, b):
            return False
        a.update(b)
        for kind, row in b.items():
            self.of[(kind, self.keys[id(row)])] = a
        self.order.remove(b)
        return True


def _names(group: dict, kinds=("central", "crmdev")) -> set[str]:
    return {same_name(group[k]["name"]) for k in kinds if k in group}


def _alike(group: dict, name: str, kinds=("central", "crmdev")) -> bool:
    wanted = loose(name)
    return bool(wanted) and any(loose(group[k]["name"]) == wanted for k in kinds if k in group)


def _only(found: list[dict]) -> dict | None:
    return found[0] if len(found) == 1 else None


def join(central: list[dict], crmdev: list[dict], owns: list[dict], links: Links) -> tuple[list[dict], list[dict]]:
    """The groups of the three sources and the suggestions of links. Rows: Central's with `id` and the snapshot's
    fields; CRMDev's with `id`, `name`, `company`, `email`, `status`, `domains`; the local ones as `clients.local`."""
    groups = _Groups(links)
    for row in central:
        groups.add("central", row.get("id"), row)
    for row in crmdev:
        groups.add("crmdev", row["id"], row)
    for own in owns:
        groups.add("local", own["localId"], own)
    # The links the user confirmed come first.
    for own in owns:
        if own["centralId"]:
            groups.join(groups.get("central", own["centralId"]), groups.get("local", own["localId"]))
    for own in owns:
        linked = links.local_crmdev.get(own["localId"], {}).get("linked")
        if linked:
            groups.join(groups.get("crmdev", linked), groups.get("local", own["localId"]))
    for (central_id, crmdev_id), state in links.central_crmdev.items():
        if state == "linked":
            groups.join(groups.get("central", central_id), groups.get("crmdev", crmdev_id))
    # CRMDev with Central: same name, else the only same exact address on both sides.
    crmdev_mails: dict[str, int] = {}
    for row in crmdev:
        if (mail := _email(row.get("email"))):
            crmdev_mails[mail] = crmdev_mails.get(mail, 0) + 1
    for row in crmdev:
        own_group = groups.get("crmdev", row["id"])
        if "central" in own_group:
            continue
        free = [g for g in groups.order if "central" in g and groups.can_join(own_group, g)]
        target = next((g for g in free if _names(own_group, KINDS) & _names(g, KINDS)), None)
        mail = _email(row.get("email"))
        if target is None and mail and crmdev_mails.get(mail) == 1:
            target = _only([g for g in free if _email(g["central"].get("email")) == mail])
        groups.join(target, own_group)
    # Each client kept here with a remote group: same name, else the only same tax id, else the only same address.
    suggestions = []
    for own in owns:
        own_group = groups.get("local", own["localId"])
        if "central" in own_group or "crmdev" in own_group:
            continue
        free = [g for g in groups.order if ("central" in g or "crmdev" in g) and groups.can_join(own_group, g)]
        target = next((g for g in free if same_name(own["name"]) in _names(g)), None)
        if target is None and (tax := tax_key(own["taxId"])):
            target = _only([g for g in free if "central" in g and tax_key(g["central"].get("taxId")) == tax])
        if target is None and (mail := _email(own["email"])):
            target = _only([g for g in free if mail in {_email(g[k].get("email")) for k in ("central", "crmdev") if k in g}])
        if groups.join(target, own_group):
            continue
        alike = next((g for g in free if _alike(g, own["name"]) and (g.get("central") or g["crmdev"])["id"]), None)
        if alike:
            kind = "central" if "central" in alike else "crmdev"
            suggestions.append(({"localId": own["localId"], "localName": own["name"], f"{kind}Id": alike[kind]["id"], f"{kind}Name": alike[kind]["name"]}, alike))
    for row in crmdev:  # a CRMDev client alone whose name is only like one of Central's
        own_group = groups.get("crmdev", row["id"])
        if "central" in own_group:
            continue
        alike = next((g for g in groups.order if "central" in g and g["central"].get("id") and groups.can_join(own_group, g)
                      and _alike(g, row["name"], ("central",))), None)
        if alike:
            suggestions.append(({"centralId": alike["central"]["id"], "centralName": alike["central"]["name"], "crmdevId": row["id"],
                                 "crmdevName": row["name"]}, alike))
    # A suggestion whose group was taken meanwhile by another link is no longer one.
    kept = [s for s, group in suggestions if group in groups.order and ("localId" not in s or "local" not in group)]
    return [entry(g) for g in groups.order], kept


def entry(group: dict) -> dict:
    """The directory's entry of a group (see the module's rules of precedence)."""
    central, crmdev, own = group.get("central"), group.get("crmdev"), group.get("local")
    rows = [r for r in (central, crmdev, own) if r]
    first = lambda field: next((r.get(field) for r in rows if r.get(field)), None)  # noqa: E731
    name = rows[0]["name"]
    aliases = []
    for row in (crmdev, own):
        if row and same_name(row["name"]) != same_name(name) and all(same_name(a) != same_name(row["name"]) for a in aliases):
            aliases.append(row["name"])
    differences = []
    if central and crmdev:
        for field, label in COMPARED:
            mine, theirs = central.get(field), crmdev.get(field)
            if mine and theirs and same_name(mine) != same_name(theirs):
                differences.append({"field": field, "label": label, "crmdev": theirs})
    return {"name": name, "company": first("company"), "email": first("email"),
            "phone": (central or {}).get("phone") or (own or {}).get("phone"), "taxId": (central or {}).get("taxId") or (own or {}).get("taxId"),
            "domains": sorted({d for r in rows for d in (r.get("domains") or [])}),
            "projects": list((central or {}).get("projects") or []), "websites": list((central or {}).get("websites") or []),
            "source": ("ambos" if own else "central") if central else "local", "sources": [k for k in KINDS if k in group],
            "localId": own["localId"] if own else None, "centralId": central["id"] if central else None,
            "crmdevId": crmdev["id"] if crmdev else None, "crmdevStatus": crmdev.get("status") if crmdev else None,
            "aliases": aliases, "differences": differences, "unplaced": False}
