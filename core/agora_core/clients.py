"""The user's clients in one directory: Central's (while its module is on and it was read) and the ones kept in
AgoraOne by hand, so the mail, WhatsApp, meetings, Fiscal and Watson know them with or without Central.

The name is the identity, as it always was (a meeting keeps its client's name): two clients with the same name,
regardless of case and spaces, are the same one. A client kept here and one of Central's become a single entry
when the user linked them («Enlazar», which always wins), else when their names are the same, or when one only of
Central's clients has the same tax id or the same exact address; then Central's data rules and the empty fields
are filled with the local ones. Names that are only alike (accents, signs) are never linked by themselves: they
become a suggestion the user confirms («Enlazar») or rejects («Son distintos», kept per pair and undoable).
Nothing is copied from Central and nothing is deleted when Central goes away: its clients just stop showing. A
client kept here has no projects (they live in Central), and its domains are only the ones the user wrote."""

import json
import re
import sqlite3
import unicodedata
from urllib.parse import urlparse

from .db import now, transaction

# Mail providers many people share: never the domain of a client. Whole families by their first label
# («hotmail.es», «yahoo.co.uk»…) and single ones.
FREE_MAIL = {"gmail.com", "googlemail.com", "me.com", "mac.com", "proton.me", "pm.me", "tutanota.com", "tutanota.de", "tuta.io",
             "zoho.com", "zohomail.com", "zohomail.eu", "mail.com", "email.com", "web.de", "t-online.de", "freenet.de", "posteo.de",
             "mailbox.org", "telefonica.net", "movistar.es", "orange.es", "orange.fr", "wanadoo.es", "wanadoo.fr", "vodafone.es",
             "terra.es", "terra.com", "ono.com", "jazztel.es", "euskaltel.net", "r.mail.ru", "mail.ru", "yandex.ru", "qq.com",
             "163.com", "libero.it", "virgilio.it", "free.fr", "laposte.net", "sfr.fr", "btinternet.com", "sky.com", "comcast.net",
             "verizon.net", "att.net", "fastmail.com", "hey.com", "duck.com"}
_FREE_FAMILIES = re.compile(r"(?:hotmail|outlook|live|msn|windowslive|yahoo|ymail|rocketmail|aol|icloud|gmx|protonmail|yandex)"
                            r"(?:\.[a-z]{2,3}){1,2}")
# Suffixes under which anybody gets a name: never a client's domain (it would take in every site below them).
_PUBLIC_SECOND = {"co", "com", "org", "net", "gob", "gov", "edu", "nom", "ac", "ltd", "plc", "me", "info", "biz", "or", "ne", "go"}
PUBLIC_SUFFIXES = {"github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "web.app", "firebaseapp.com",
                   "herokuapp.com", "appspot.com", "azurewebsites.net", "cloudfront.net", "amazonaws.com", "blogspot.com",
                   "wordpress.com", "wixsite.com", "squarespace.com", "myshopify.com", "onrender.com", "fly.dev", "surge.sh",
                   "now.sh", "glitch.me", "replit.app", "framer.website", "webflow.io", "carrd.co", "notion.site", "substack.com",
                   "medium.com", "tumblr.com", "weebly.com", "jimdosite.com", "godaddysites.com", "hostingersite.com"}
PRIVATE_FIELDS = ("email", "phone", "taxId", "notes")  # never to the screen's lists nor to a model
LIMITS = {"name": 200, "company": 200, "email": 320, "phone": 40, "taxId": 30, "notes": 4000}
MAX_DOMAINS = 20
LOCAL_PHONE_DIGITS = 9  # a number kept without its country prefix (a Spanish one) is matched by its last digits
SAME_NAME = "Cambia antes el nombre de tu cliente: si se llaman igual, son el mismo."


class ClientError(ValueError):
    pass


class ClientConflict(ClientError):
    """Another client already has that name."""


def domain(value: str | None) -> str | None:
    """The domain of an address or a web («acme.com»), without «www.»; None for anything else."""
    if not value:
        return None
    host = value.rsplit("@", 1)[-1] if "@" in value and "//" not in value else urlparse(value if "//" in value else f"//{value}").hostname
    host = (host or "").lower().removeprefix("www.")
    return host if re.fullmatch(r"(?:[a-z0-9-]+\.)+[a-z]{2,63}", host or "") else None


def is_free_mail(host: str | None) -> bool:
    return bool(host) and (host in FREE_MAIL or bool(_FREE_FAMILIES.fullmatch(host)))


def is_public_suffix(host: str | None) -> bool:
    """«co.uk», «com.es», «github.io»: shared by unrelated sites."""
    if not host:
        return False
    labels = host.split(".")
    return host in PUBLIC_SUFFIXES or (len(labels) == 2 and labels[0] in _PUBLIC_SECOND and len(labels[1]) == 2)


def client_domain(host: str | None) -> bool:
    """Whether a domain may stand for one client: not a mail provider nor a public suffix."""
    return bool(host) and not is_free_mail(host) and not is_public_suffix(host)


def same_name(value: str | None) -> str:
    """«  Café  Web » and «café web» are the same client."""
    return " ".join(str(value or "").split()).casefold()


def loose(value: str | None) -> str:
    """«Café-Web S.L.» and «cafe_web_sl» are alike: only a suggestion, never a link by itself."""
    text = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode().casefold()
    return re.sub(r"[^a-z0-9]", "", text)


def tax_key(value: str | None) -> str | None:
    """A tax id as it is compared: capitals, no spaces, dots or dashes, and no «ES» VAT prefix."""
    text = re.sub(r"[^A-Z0-9]", "", str(value or "").upper())
    if text.startswith("ES") and len(text) >= 10:
        text = text[2:]
    return text or None


def phone_key(value: str | None) -> str | None:
    """Only the digits, without a leading «00»."""
    digits = re.sub(r"\D", "", str(value or ""))
    digits = digits[2:] if digits.startswith("00") else digits
    return digits or None


# --- the local table ------------------------------------------------------------------------------------------

def _row(row: sqlite3.Row) -> dict:
    return {"localId": row["id"], "name": row["name"], "company": row["company"], "email": row["email"], "phone": row["phone"],
            "taxId": row["tax_id"], "domains": json.loads(row["domains"] or "[]"), "notes": row["notes"],
            "centralId": row["central_id"], "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


def _distinct(connection: sqlite3.Connection) -> dict[int, set[str]]:
    found: dict[int, set[str]] = {}
    for row in connection.execute("SELECT client_id, central_id FROM client_distinct"):
        found.setdefault(row["client_id"], set()).add(row["central_id"])
    return found


def local(connection: sqlite3.Connection) -> list[dict]:
    pairs = _distinct(connection)
    return [{**_row(r), "distinct": sorted(pairs.get(r["id"], ()))} for r in connection.execute("SELECT * FROM client ORDER BY name COLLATE NOCASE")]


def references(connection: sqlite3.Connection, name: str) -> dict:
    """What keeps the client's name: the meetings assigned to it."""
    return {"meetings": connection.execute("SELECT count(*) FROM meeting WHERE client = ?", (name,)).fetchone()[0]}


def get(connection: sqlite3.Connection, client_id: int) -> dict | None:
    """A client kept here, whole, with the Central clients it is said to be different from and its references."""
    row = connection.execute("SELECT * FROM client WHERE id = ?", (client_id,)).fetchone()
    if not row:
        return None
    names = {c.get("id"): c["name"] for c in _central(connection)}
    pairs = sorted(_distinct(connection).get(client_id, ()))
    return {**_row(row), "distinct": [{"centralId": c, "centralName": names.get(c)} for c in pairs],
            "centralName": names.get(row["central_id"]), "references": references(connection, row["name"])}


def _text(fields: dict, name: str) -> str | None:
    value = fields.get(name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ClientError(f"El campo {name} no es válido.")
    value = " ".join(value.split()) if name != "notes" else value.strip()
    if len(value) > LIMITS[name]:
        raise ClientError(f"El campo {name} es demasiado largo.")
    return value or None


def clean(fields: dict) -> dict:
    """The fields of a client as they are kept, or ClientError saying what is wrong."""
    out = {name: _text(fields, name) for name in LIMITS}
    if not out["name"]:
        raise ClientError("Escribe el nombre del cliente.")
    if out["email"]:
        out["email"] = out["email"].lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+", out["email"]) or not domain(out["email"]):
            raise ClientError("El correo no es válido.")
    if out["phone"] and not re.fullmatch(r"\+?[0-9 ().-]{6,40}", out["phone"]):
        raise ClientError("El teléfono no es válido: solo números, espacios y un «+» inicial.")
    if out["taxId"]:
        out["taxId"] = out["taxId"].upper()
        if not re.fullmatch(r"[A-Z0-9 .-]{5,30}", out["taxId"]):
            raise ClientError("El NIF no es válido.")
    raw = fields.get("domains") or []
    if not isinstance(raw, list) or len(raw) > MAX_DOMAINS:
        raise ClientError(f"Los dominios van en una lista de {MAX_DOMAINS} como mucho.")
    domains = []
    for item in raw:
        found = domain(item) if isinstance(item, str) else None
        if not found:
            raise ClientError(f"«{str(item)[:60]}» no es un dominio.")
        if is_free_mail(found):
            raise ClientError(f"{found} es un correo que comparte mucha gente: no puede ser el dominio de un cliente.")
        if is_public_suffix(found):
            raise ClientError(f"{found} es un sufijo compartido por muchas webs: escribe el dominio completo del cliente.")
        if found not in domains:
            domains.append(found)
    out["domains"] = domains
    return out


def _name_taken(connection: sqlite3.Connection, name: str, client_id: int | None = None) -> bool:
    return any(same_name(r["name"]) == same_name(name) and r["id"] != client_id for r in connection.execute("SELECT id, name FROM client"))


def _taken(name: str) -> ClientConflict:
    return ClientConflict(f"Ya tienes un cliente llamado «{name}».")


def create(connection: sqlite3.Connection, fields: dict) -> dict:
    data = clean(fields)
    if _name_taken(connection, data["name"]):
        raise _taken(data["name"])
    stamp = now()
    try:
        with transaction(connection):
            cursor = connection.execute(
                "INSERT INTO client (name, company, email, phone, tax_id, domains, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (data["name"], data["company"], data["email"], data["phone"], data["taxId"], json.dumps(data["domains"]), data["notes"], stamp, stamp))
    except sqlite3.IntegrityError:  # created meanwhile with the same name
        raise _taken(data["name"]) from None
    return get(connection, cursor.lastrowid)


def update(connection: sqlite3.Connection, client_id: int, fields: dict) -> dict | None:
    """Changes a client kept here; a new name goes with it to the meetings that named it, in the same transaction."""
    row = connection.execute("SELECT * FROM client WHERE id = ?", (client_id,)).fetchone()
    if not row:
        return None
    current = _row(row)
    data = clean({**{k: current[k] for k in (*LIMITS, "domains")}, **fields})
    if _name_taken(connection, data["name"], client_id):
        raise _taken(data["name"])
    try:
        with transaction(connection):
            connection.execute("UPDATE client SET name = ?, company = ?, email = ?, phone = ?, tax_id = ?, domains = ?, notes = ?, updated_at = ? WHERE id = ?",
                               (data["name"], data["company"], data["email"], data["phone"], data["taxId"], json.dumps(data["domains"]), data["notes"],
                                now(), client_id))
            if data["name"] != current["name"]:
                connection.execute("UPDATE meeting SET client = ? WHERE client = ?", (data["name"], current["name"]))
    except sqlite3.IntegrityError:
        raise _taken(data["name"]) from None
    return get(connection, client_id)


def delete(connection: sqlite3.Connection, client_id: int) -> dict | None:
    """Only a client kept here (Central's are never touched): copied whole to `client_backup` first, in the same
    transaction. The meetings that named it keep the name. Returns what was copied, or None when it did not exist."""
    found = get(connection, client_id)
    if not found:
        return None
    with transaction(connection):
        connection.execute("INSERT INTO client_backup (client_id, data, created_at) VALUES (?, ?, ?)",
                           (client_id, json.dumps(found, ensure_ascii=False), now()))
        connection.execute("DELETE FROM client WHERE id = ?", (client_id,))
    return found


def set_link(connection: sqlite3.Connection, client_id: int, central_id: str, state: str) -> dict | None:
    """«Enlazar» (`linked`), «Son distintos» (`distinct`, also undoes a link with that one) or undoing a «Son
    distintos» (`undistinct`) with one of Central's clients, which must be there now for the first two."""
    if state not in ("linked", "distinct", "undistinct"):
        raise ClientError("Estado de enlace no válido.")
    own = connection.execute("SELECT * FROM client WHERE id = ?", (client_id,)).fetchone()
    if not own:
        return None
    if state == "undistinct":
        with transaction(connection):
            connection.execute("DELETE FROM client_distinct WHERE client_id = ? AND central_id = ?", (client_id, central_id))
        return get(connection, client_id)
    other = next((c for c in _central(connection) if c.get("id") == central_id), None)
    if not other:
        raise ClientError("Ese cliente no está en Central (o Central no está conectado).")
    if state == "distinct" and same_name(other["name"]) == same_name(own["name"]):
        raise ClientError(SAME_NAME)
    with transaction(connection):
        if state == "linked":
            connection.execute("UPDATE client SET central_id = ?, updated_at = ? WHERE id = ?", (central_id, now(), client_id))
            connection.execute("DELETE FROM client_distinct WHERE client_id = ? AND central_id = ?", (client_id, central_id))
        else:
            connection.execute("INSERT OR IGNORE INTO client_distinct (client_id, central_id, created_at) VALUES (?, ?, ?)", (client_id, central_id, now()))
            connection.execute("UPDATE client SET central_id = NULL, updated_at = ? WHERE id = ? AND central_id = ?", (now(), client_id, central_id))
    return get(connection, client_id)


def link_created(connection: sqlite3.Connection, client_id: int, central_id: str) -> bool:
    """Links a client kept here with the one just created from it in Central («Crear en Central»), which the
    snapshot will only have after its next reading. Never over another link: False when it already had one."""
    with transaction(connection):
        changed = connection.execute("UPDATE client SET central_id = ?, updated_at = ? WHERE id = ? AND central_id IS NULL",
                                     (central_id, now(), client_id)).rowcount
        connection.execute("DELETE FROM client_distinct WHERE client_id = ? AND central_id = ?", (client_id, central_id))
    return changed == 1


# --- the directory ---------------------------------------------------------------------------------------------

def _central(connection: sqlite3.Connection) -> list[dict]:
    from . import central

    return [c for c in ((central.snapshot(connection) or {}).get("clients") or []) if c.get("name")]


def _unique(entries: list[dict], key, wanted) -> dict | None:
    if not wanted:
        return None
    found = [e for e in entries if key(e) == wanted]
    return found[0] if len(found) == 1 else None


def _merge(target: dict, own: dict) -> None:
    for field in ("company", "email", "phone", "taxId"):
        target[field] = target[field] or own[field]
    target["domains"] = sorted(set(target["domains"]) | set(own["domains"]))
    target.update(source="ambos", localId=own["localId"])
    if same_name(own["name"]) != same_name(target["name"]):
        target["aliases"].append(own["name"])


def build(connection: sqlite3.Connection) -> tuple[list[dict], list[dict]]:
    """The directory and the suggestions of links. Each entry has the snapshot's shape (`name`, `company`, `email`,
    `phone`, `taxId`, `domains`, `projects`, `websites`) plus `source` (`central`, `local`, `ambos`), `localId`,
    `centralId` and `aliases` (other names it is known by, the local one when it differs). The links the user
    confirmed are taken first; the automatic ones only get what is left."""
    remote = [{"name": c["name"], "company": c.get("company"), "email": c.get("email"), "phone": c.get("phone"), "taxId": c.get("taxId"),
               "domains": list(c.get("domains") or []), "projects": list(c.get("projects") or []), "websites": list(c.get("websites") or []),
               "source": "central", "localId": None, "centralId": c.get("id"), "aliases": []} for c in _central(connection)]
    owns = local(connection)
    by_id = {e["centralId"]: e for e in remote if e["centralId"]}
    placed: set[int] = set()
    for own in owns:  # first pass: «Enlazar»
        target = by_id.get(own["centralId"]) if own["centralId"] else None
        if target and target["localId"] is None:
            _merge(target, own)
            placed.add(own["localId"])
    entries, suggestions = list(remote), []
    for own in owns:  # second pass: same name, else one only with the same tax id or the same exact address
        if own["localId"] in placed:
            continue
        free = [e for e in remote if e["localId"] is None and e["centralId"] not in own["distinct"]]
        target = next((e for e in free if same_name(e["name"]) == same_name(own["name"])), None)
        target = target or _unique(free, lambda e: tax_key(e["taxId"]), tax_key(own["taxId"]))
        target = target or _unique(free, lambda e: (e["email"] or "").lower() or None, (own["email"] or "").lower() or None)
        if target:
            _merge(target, own)
            continue
        entries.append({"name": own["name"], "company": own["company"], "email": own["email"], "phone": own["phone"], "taxId": own["taxId"],
                        "domains": sorted(own["domains"]), "projects": [], "websites": [], "source": "local", "localId": own["localId"],
                        "centralId": None, "aliases": []})
        alike = next((e for e in free if loose(e["name"]) and loose(e["name"]) == loose(own["name"]) and e["centralId"]), None)
        if alike:
            suggestions.append({"localId": own["localId"], "localName": own["name"], "centralId": alike["centralId"], "centralName": alike["name"]})
    # A suggestion whose Central client was taken meanwhile by another link is no longer one.
    suggestions = [s for s in suggestions if by_id[s["centralId"]]["localId"] is None]
    entries.sort(key=lambda e: (e["name"].casefold(), e["source"]))
    return entries, suggestions


def directory(connection: sqlite3.Connection) -> list[dict]:
    return build(connection)[0]


def public(entry: dict) -> dict:
    """What the screen's lists and a model may see: no address, phone, tax id nor notes."""
    return {k: v for k, v in entry.items() if k not in PRIVATE_FIELDS}


def _one(found: list[dict]) -> dict | None:
    return found[0] if len(found) == 1 else None


def find(entries: list[dict], address: str | None = None, phone: str | None = None, tax_id: str | None = None) -> dict | None:
    """The client a sender, a number or a tax id belongs to, among `entries` (the directory, read once), only when
    one client alone fits. An address by itself, else by its domain or the closest parent domain (never a mail
    provider's nor a public suffix); a phone by its digits, or by its last nine when the kept one has no prefix; a
    tax id exactly. Nothing by name."""
    if address:
        address = address.strip().lower()
        exact = [e for e in entries if (e.get("email") or "").lower() == address]
        if exact:
            return _one(exact)
        host = domain(address)
        if client_domain(host):
            fits = [(len(d), e) for e in entries for d in e["domains"] if client_domain(d) and (host == d or host.endswith("." + d))]
            closest = max((size for size, _ in fits), default=0)
            found = {id(e): e for size, e in fits if size == closest}
            if found:
                return _one(list(found.values()))
    if phone and (digits := phone_key(phone)):
        exact = [e for e in entries if phone_key(e.get("phone")) == digits]
        if exact:
            return _one(exact)
        if len(digits) > LOCAL_PHONE_DIGITS:
            short = [e for e in entries if (k := phone_key(e.get("phone"))) and len(k) == LOCAL_PHONE_DIGITS
                     and not str(e.get("phone")).strip().startswith("+") and digits.endswith(k)]
            if len(short) == 1:
                return short[0]
    if tax_id and (wanted := tax_key(tax_id)):
        return _one([e for e in entries if tax_key(e.get("taxId")) == wanted])
    return None


def match(connection: sqlite3.Connection, address: str | None = None, phone: str | None = None, tax_id: str | None = None) -> dict | None:
    return find(directory(connection), address, phone, tax_id)


def _named(entries: list[dict], name: str) -> dict | None:
    wanted = same_name(name)
    return next((e for e in entries if same_name(e["name"]) == wanted), None) or \
        next((e for e in entries if any(same_name(a) == wanted for a in e["aliases"])), None)


def canonical_name(connection: sqlite3.Connection, name: str | None) -> str | None:
    """The client as the directory names it (Central's spelling when it is one of Central's), or ClientError."""
    if not name or not same_name(name):
        return None
    found = _named(directory(connection), name)
    if not found:
        raise ClientError("Ese cliente no está entre tus clientes: elige uno de la lista o créalo en Trabajos › Clientes.")
    return found["name"]


def canonical_project(connection: sqlite3.Connection, client: str | None, name) -> str | None:
    """The project as Central names it, and always one of the client's projects (or none). A client kept only in
    AgoraOne has no projects."""
    name = " ".join(str(name or "").split())[:200]
    if not name:
        return None
    if not client:
        raise ClientError("Elige antes el cliente del proyecto.")
    found = _named(directory(connection), client)
    if found and found["source"] == "local":
        raise ClientError(f"{client} es un cliente tuyo sin proyectos: los proyectos viven en Central.")
    known = {same_name(p.get("name")): p["name"] for p in ((found or {}).get("projects") or []) if p.get("name")}
    if same_name(name) not in known:
        raise ClientError(f"Ese proyecto no es de {client} en Central: elige uno de la lista.")
    return known[same_name(name)]
