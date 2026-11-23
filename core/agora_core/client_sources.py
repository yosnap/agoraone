"""How the directory joins its three sources (Central, CRMDev and the clients kept in AgoraOne) without duplicates.

Every client of each source starts on its own; a group holds at most one of each source. Groups are joined first by
the links the user confirmed («Enlazar», and the client just created from one kept here). Then automatically, each
signal in this order of strength: the tax id (only Central has one), the exact address, the exact name and, for a CRMDev
client, its company equal to the name of a client of Central or one kept here. A signal joins only when it points to one
client alone (unique over the whole source, not only over the clients still free); a signal that points to several, or
to one that cannot be joined («Son distintos», or already joined to another of that source), stops the weaker ones and
the pair is at most a suggestion. Names that are only alike (accents, signs) are suggestions too.

A CRMDev client whose company is the name of one client alone is a person of that company: every such person goes with
it as one of its `contacts` (not as its CRMDev record, so «Crear en CRMDev» of the company itself is still offered), and
their domains and exact addresses recognise its mail. The entry shows the most advanced commercial state of its CRMDev
clients (Cliente, then Posible cliente, Contacto, Inactivo and Perdido). «Son distintos» with one of them takes it out.

In the entry of a group, the name is Central's, else the one kept here, else CRMDev's. Central rules in the tax and contact data, its projects and websites; CRMDev adds its
commercial state and fills what Central has empty; a client kept here fills what is still empty. When Central and
CRMDev disagree on a field, the entry says so (`differences`) without changing either. Nothing is synchronized.

Everything is looked up in dictionaries built once per call, so joining stays linear in the number of clients."""

from .clients import loose, same_name, tax_key

KINDS = ("central", "crmdev", "local")
COMPARED = (("name", "Nombre"), ("company", "Empresa"), ("email", "Correo"))
# A company Central has and CRMDev lacks counts as a difference too (Central leads); a missing mail is its own warning.
# The phone is not compared: CRMDev's `update_client` cannot change it, it only goes when the client is created.
FILLED = ("company",)
STOP = object()
# CRMDev's commercial states, most advanced first: an entry with several CRMDev clients shows the most advanced one.
STATUS_ORDER = ("CUSTOMER", "PROSPECT", "LEAD", "INACTIVE", "CHURNED")  # a signal found but not usable: weaker signals are not tried


def _email(value) -> str | None:
    return (value or "").strip().lower() or None


class Links:
    """The pairs the user confirmed or rejected: `local_crmdev[client_id] = {"linked": id | None, "linkedAt": str | None,
    "distinct": set}` and `central_crmdev[(central_id, crmdev_id)] = "linked" | "distinct"`. Central's own pairs come with
    each local row (`centralId`, `distinct`)."""

    def __init__(self, local_crmdev: dict | None = None, central_crmdev: dict | None = None):
        self.local_crmdev = local_crmdev or {}
        self.central_crmdev = central_crmdev or {}

    def distinct(self, kind_a: str, row_a: dict, kind_b: str, row_b: dict) -> bool:
        if KINDS.index(kind_a) > KINDS.index(kind_b):
            kind_a, row_a, kind_b, row_b = kind_b, row_b, kind_a, row_a
        if (kind_a, kind_b) == ("central", "local"):
            return row_a["id"] in row_b["distinct"]
        if (kind_a, kind_b) == ("crmdev", "local"):
            return row_a["id"] in self.local_crmdev.get(row_b["localId"], {}).get("distinct", ())
        if (kind_a, kind_b) == ("central", "crmdev"):
            return self.central_crmdev.get((row_a["id"], row_b["id"])) == "distinct"
        return False


class Group:
    """At most one client of each source; compared by identity."""
    __slots__ = ("central", "crmdev", "local", "contacts", "alive", "order")

    def __init__(self, kind: str, row: dict, order: int):
        self.central = self.crmdev = self.local = None
        self.contacts: list[dict] = []  # CRMDev clients (people) whose company is this client
        setattr(self, kind, row)
        self.alive, self.order = True, order

    def members(self) -> list[tuple[str, dict]]:
        return [(k, getattr(self, k)) for k in KINDS if getattr(self, k) is not None]


class _Groups:
    def __init__(self, links: Links):
        self.links = links
        self.all: list[Group] = []
        self.of: dict[tuple, Group] = {}

    def add(self, kind: str, key, row: dict) -> None:
        group = Group(kind, row, len(self.all))
        self.all.append(group)
        self.of[(kind, key)] = group

    def can_join(self, a: Group | None, b: Group | None) -> bool:
        if a is None or b is None or a is b:
            return False
        ma, mb = a.members(), b.members()
        if {k for k, _ in ma} & {k for k, _ in mb}:
            return False
        return not any(self.links.distinct(ka, ra, kb, rb) for ka, ra in ma for kb, rb in mb)

    def join(self, a: Group | None, b: Group | None) -> bool:
        if not self.can_join(a, b):
            return False
        keep, gone = (a, b) if a.order <= b.order else (b, a)
        for kind, row in gone.members():
            setattr(keep, kind, row)
            self.of[(kind, row["_key"])] = keep
        gone.alive = False
        return True


def _index(rows: list[dict], field: str) -> dict:
    found: dict = {}
    for row in rows:
        if (key := row.get(field)):
            found.setdefault(key, []).append(row)
    return found


def _prepare(kind: str, rows: list[dict]) -> list[dict]:
    """Each row with its keys computed once: `_key` (its id), `_name`, `_loose`, `_email`, `_tax` and `_company`."""
    out = []
    for n, row in enumerate(rows):
        key = row["localId"] if kind == "local" else (row.get("id") if row.get("id") is not None else f"#{n}")
        out.append({**row, "_key": key, "_name": same_name(row.get("name")), "_loose": loose(row.get("name")), "_email": _email(row.get("email")),
                    "_tax": tax_key(row.get("taxId")) if kind != "crmdev" else None,
                    "_company": same_name(row.get("company")) if kind == "crmdev" else None})
    return out


def join(central: list[dict], crmdev: list[dict], owns: list[dict], links: Links) -> tuple[list[dict], list[dict]]:
    """The entries of the joined groups and the suggestions of links. Rows: Central's with `id` and the snapshot's
    fields; CRMDev's with `id`, `name`, `company`, `email`, `status`, `domains`; the local ones as `clients.local`."""
    c_rows = _prepare("central", central)
    r_rows = sorted(_prepare("crmdev", crmdev), key=lambda r: str(r["_key"]))  # a stable order, whatever CRMDev returns
    l_rows = _prepare("local", owns)
    groups = _Groups(links)
    for kind, rows in (("central", c_rows), ("crmdev", r_rows), ("local", l_rows)):
        for row in rows:
            groups.add(kind, row["_key"], row)
    group = lambda kind, row: groups.of[(kind, row["_key"])]  # noqa: E731

    # The links the user confirmed come first.
    for own in l_rows:
        if own["centralId"]:
            groups.join(groups.of.get(("central", own["centralId"])), group("local", own))
    for own in l_rows:
        linked = links.local_crmdev.get(own["localId"], {}).get("linked")
        if linked:
            groups.join(groups.of.get(("crmdev", linked)), group("local", own))
    for (central_id, crmdev_id), state in links.central_crmdev.items():
        if state == "linked":
            groups.join(groups.of.get(("central", central_id)), groups.of.get(("crmdev", crmdev_id)))

    c_tax, c_email, c_name, c_loose = _index(c_rows, "_tax"), _index(c_rows, "_email"), _index(c_rows, "_name"), _index(c_rows, "_loose")
    r_email, r_name, r_loose = _index(r_rows, "_email"), _index(r_rows, "_name"), _index(r_rows, "_loose")
    l_name = _index(l_rows, "_name")
    suggestions: list[tuple[dict, tuple, tuple]] = []
    blocked: set = set()  # CRMDev clients a stronger signal stopped: their company is only a suggestion

    def by_signals(mine: Group, signals: list[tuple[str | None, dict, str, dict | None]]) -> object:
        """The first signal that finds anything decides: joined (True), or STOP when it is ambiguous or not joinable."""
        for key, index, kind, other in signals:
            if not key:
                continue
            found = index.get(key)
            if not found:
                continue
            if len(found) == 1 and (other is None or len(other.get(key, ())) == 1) and groups.join(group(kind, found[0]), mine):
                return True
            return STOP
        return None

    # Clients kept here with Central: tax id, exact address, exact name.
    for own in l_rows:
        mine = group("local", own)
        if mine.central is None:
            by_signals(mine, [(own["_tax"], c_tax, "central", None), (own["_email"], c_email, "central", None), (own["_name"], c_name, "central", None)])
    # CRMDev with Central: exact address, exact name (each unique on both sides).
    for row in r_rows:
        mine = group("crmdev", row)
        if mine.central is None and by_signals(mine, [(row["_email"], c_email, "central", r_email), (row["_name"], c_name, "central", r_name)]) is STOP:
            blocked.add(row["_key"])
    # Clients kept here (with or without Central) and CRMDev: exact address, exact name.
    for own in l_rows:
        mine = group("local", own)
        if mine.crmdev is None:
            names = [(own["_name"], r_name, "crmdev", None)]
            result = by_signals(mine, [(own["_email"], r_email, "crmdev", None), *names])
            if result is STOP:
                for row in (r_email.get(own["_email"]) or []) + (r_name.get(own["_name"]) or []):
                    blocked.add(row["_key"])
    # CRMDev clients whose company is the name of one client of Central or one kept here: every one of them (people of
    # that company) goes with it as a contact, unless the user said it is not or a stronger signal points elsewhere.
    for row in r_rows:
        mine = group("crmdev", row)
        if mine.central is not None or not row["_company"]:
            continue
        found = {id(g): g for g in [group("central", c) for c in c_name.get(row["_company"], ())] + [group("local", o) for o in l_name.get(row["_company"], ())]}
        targets = [g for g in found.values() if g is not mine]
        if len(targets) == 1 and row["_key"] not in blocked:
            target = targets[0]
            alone = mine.local is None and not mine.contacts
            if alone and not any(links.distinct("crmdev", row, kind, other) for kind, other in target.members()):
                target.contacts.append(row)
                mine.alive = False
                continue
            if not alone and groups.join(target, mine):
                continue
        for target in targets:
            kind = "central" if target.central is not None else "local"
            suggestions.append((None, ("crmdev", row["_key"]), (kind, target.central["_key"] if kind == "central" else target.local["_key"])))

    # Names only alike: suggestions. A client kept here alone, then a CRMDev client without Central.
    for own in l_rows:
        mine = group("local", own)
        if mine.central is not None or mine.crmdev is not None or not own["_loose"]:
            continue
        cands = [group("central", c) for c in c_loose.get(own["_loose"], ()) if c.get("id")] + [group("crmdev", r) for r in r_loose.get(own["_loose"], ())]
        target = next((g for g in cands if g.alive and g.local is None and groups.can_join(g, mine)), None)
        if target is not None:
            kind = "central" if target.central is not None else "crmdev"
            suggestions.append((None, ("local", own["_key"]), (kind, getattr(target, kind)["_key"])))
    for row in r_rows:
        mine = group("crmdev", row)
        if not mine.alive or mine.central is not None or not row["_loose"]:
            continue
        target = next((g for g in (group("central", c) for c in c_loose.get(row["_loose"], ()) if c.get("id")) if groups.can_join(g, mine)), None)
        if target is not None:
            suggestions.append((None, ("central", target.central["_key"]), ("crmdev", row["_key"])))

    kept, seen = [], set()
    for _, a, b in suggestions:
        ga, gb = groups.of[a], groups.of[b]
        if not (ga.alive and gb.alive):
            continue
        pair = _suggestion(a, b, ga, gb)
        if pair is None or not groups.can_join(ga, gb) or tuple(sorted(pair.items())) in seen:
            continue
        seen.add(tuple(sorted(pair.items())))
        kept.append(pair)
    entries = [entry(g) for g in groups.all if g.alive]
    counts: dict[str, int] = {}
    for e in entries:
        key = same_name(e["name"])
        counts[key] = counts.get(key, 0) + 1
    for e in entries:
        e["repeated"] = counts[same_name(e["name"])] > 1
    return entries, kept


def _suggestion(a: tuple, b: tuple, ga: Group, gb: Group) -> dict | None:
    """The suggestion's shape, by the two sources it pairs (`localId`/`centralId`/`crmdevId` two by two)."""
    rows = {a[0]: getattr(ga, a[0]), b[0]: getattr(gb, b[0])}
    if "local" in rows and "central" in rows:
        return {"localId": rows["local"]["localId"], "localName": rows["local"]["name"], "centralId": rows["central"]["id"], "centralName": rows["central"]["name"]}
    if "local" in rows and "crmdev" in rows:
        return {"localId": rows["local"]["localId"], "localName": rows["local"]["name"], "crmdevId": rows["crmdev"]["id"], "crmdevName": rows["crmdev"]["name"]}
    if "central" in rows and "crmdev" in rows and rows["central"].get("id"):
        return {"centralId": rows["central"]["id"], "centralName": rows["central"]["name"], "crmdevId": rows["crmdev"]["id"], "crmdevName": rows["crmdev"]["name"]}
    return None


def entry(group: Group) -> dict:
    """The directory's entry of a group (see the module's rules of precedence)."""
    central, crmdev, own = group.central, group.crmdev, group.local
    rows = [r for r in (central, crmdev, own) if r]
    first = lambda field: next((r.get(field) for r in rows if r.get(field)), None)  # noqa: E731
    # The name: Central's, else the one the user keeps here, else CRMDev's (often a person of that company).
    named = central or own or crmdev
    aliases: list[str] = []
    seen = {named["_name"]}
    for row in (crmdev, own):
        if row and row["_name"] not in seen:
            seen.add(row["_name"])
            aliases.append(row["name"])
    differences = []
    if central and crmdev:
        for field, label in COMPARED:
            mine, theirs = central.get(field), crmdev.get(field)
            if mine and theirs and same_name(mine) != same_name(theirs):
                differences.append({"field": field, "label": label, "crmdev": theirs})
            elif mine and not theirs and field in FILLED:
                differences.append({"field": field, "label": label, "crmdev": None, "missing": True})
    domains = set()
    for row in (*rows, *group.contacts):
        domains.update(row.get("domains") or ())
    contacts = sorted(group.contacts, key=lambda c: (c["_name"], str(c["_key"])))
    statuses = [r.get("status") for r in ([crmdev] if crmdev else []) + contacts if r.get("status") in STATUS_ORDER]
    return {"name": named["name"], "company": first("company"), "email": first("email"),
            "phone": (central and central.get("phone")) or (own and own.get("phone")) or None,
            "taxId": (central and central.get("taxId")) or (own and own.get("taxId")) or None,
            "domains": sorted(domains), "projects": list(central.get("projects") or []) if central else [], "websites": list(central.get("websites") or []) if central else [],
            "source": ("ambos" if own else "central") if central else "local", "sources": [k for k in KINDS if getattr(group, k) is not None],
            "localId": own["localId"] if own else None, "centralId": central["id"] if central else None,
            "crmdevId": crmdev["id"] if crmdev else None,
            "crmdevStatus": min(statuses, key=STATUS_ORDER.index) if statuses else (crmdev.get("status") if crmdev else None),
            "contacts": [{"id": c["id"], "name": c["name"], "status": c.get("status")} for c in contacts],
            "contactEmails": sorted({c["_email"] for c in contacts if c["_email"]}),
            "aliases": aliases, "differences": differences, "unplaced": False, "staleLink": None, "repeated": False}
