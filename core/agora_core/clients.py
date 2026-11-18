"""The user's clients in one directory: Central's (while its module is on and it was read) and the ones kept in
AgoraOne by hand, so the mail, WhatsApp, meetings, Fiscal and Watson know them with or without Central.

The name is the identity, as it always was (a meeting keeps its client's name): two clients with the same name,
regardless of case and spaces, are the same one. A client kept here and one of Central's become a single entry
when the user linked them, when their names are the same, or when one only of Central's clients has the same tax
id or the same exact address; then Central's data rules and the empty fields are filled with the local ones.
Names that are only alike (accents, signs) are never linked by themselves: they become a suggestion the user
confirms («Enlazar») or rejects («Son distintos»). Nothing is copied from Central and nothing is deleted when
Central goes away: its clients just stop showing. A client kept here has no projects (they live in Central)."""

import json
import re
import sqlite3
import unicodedata
from urllib.parse import urlparse

from .db import now, transaction

FREE_MAIL = {"gmail.com", "googlemail.com", "hotmail.com", "outlook.com", "live.com", "yahoo.com", "yahoo.es", "icloud.com", "me.com",
             "protonmail.com", "proton.me", "gmx.com", "aol.com", "msn.com"}
PRIVATE_FIELDS = ("email", "phone", "taxId", "notes")  # never to the screen's lists nor to a model
LIMITS = {"name": 200, "company": 200, "email": 320, "phone": 40, "taxId": 30, "notes": 4000}
MAX_DOMAINS = 20
LOCAL_PHONE_DIGITS = 9  # a number kept without its country prefix (a Spanish one) is matched by its last digits


class ClientError(ValueError):
    pass


def domain(value: str | None) -> str | None:
    """The domain of an address or a web («acme.com»), without «www.»; None for anything else."""
    if not value:
        return None
    host = value.rsplit("@", 1)[-1] if "@" in value and "//" not in value else urlparse(value if "//" in value else f"//{value}").hostname
    host = (host or "").lower().removeprefix("www.")
    return host if re.fullmatch(r"(?:[a-z0-9-]+\.)+[a-z]{2,63}", host or "") else None


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
            "centralId": row["central_id"], "linkState": row["link_state"], "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


def local(connection: sqlite3.Connection) -> list[dict]:
    return [_row(r) for r in connection.execute("SELECT * FROM client ORDER BY name COLLATE NOCASE")]


def get(connection: sqlite3.Connection, client_id: int) -> dict | None:
    row = connection.execute("SELECT * FROM client WHERE id = ?", (client_id,)).fetchone()
    return _row(row) if row else None


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
        if found in FREE_MAIL:
            raise ClientError(f"{found} es un correo gratuito que comparte mucha gente: no puede ser el dominio de un cliente.")
        if found not in domains:
            domains.append(found)
    out["domains"] = domains
    return out


def _name_taken(connection: sqlite3.Connection, name: str, client_id: int | None = None) -> bool:
    return any(same_name(r["name"]) == same_name(name) and r["id"] != client_id for r in connection.execute("SELECT id, name FROM client"))


def create(connection: sqlite3.Connection, fields: dict) -> dict:
    data = clean(fields)
    if _name_taken(connection, data["name"]):
        raise ClientError(f"Ya tienes un cliente llamado «{data['name']}».")
    stamp = now()
    with transaction(connection):
        cursor = connection.execute(
            "INSERT INTO client (name, company, email, phone, tax_id, domains, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (data["name"], data["company"], data["email"], data["phone"], data["taxId"], json.dumps(data["domains"]), data["notes"], stamp, stamp))
    return get(connection, cursor.lastrowid)


def update(connection: sqlite3.Connection, client_id: int, fields: dict) -> dict | None:
    current = get(connection, client_id)
    if not current:
        return None
    data = clean({**{k: current[k] for k in (*LIMITS, "domains")}, **fields})
    if _name_taken(connection, data["name"], client_id):
        raise ClientError(f"Ya tienes un cliente llamado «{data['name']}».")
    with transaction(connection):
        connection.execute("UPDATE client SET name = ?, company = ?, email = ?, phone = ?, tax_id = ?, domains = ?, notes = ?, updated_at = ? WHERE id = ?",
                           (data["name"], data["company"], data["email"], data["phone"], data["taxId"], json.dumps(data["domains"]), data["notes"],
                            now(), client_id))
    return get(connection, client_id)


def delete(connection: sqlite3.Connection, client_id: int) -> bool:
    """Only a client kept here; Central's are never touched."""
    with transaction(connection):
        return connection.execute("DELETE FROM client WHERE id = ?", (client_id,)).rowcount > 0


def set_link(connection: sqlite3.Connection, client_id: int, central_id: str, state: str) -> dict | None:
    """«Enlazar» (`linked`) or «Son distintos» (`distinct`) with one of Central's clients, which must be there now."""
    if state not in ("linked", "distinct"):
        raise ClientError("Estado de enlace no válido.")
    if not get(connection, client_id):
        return None
    if not any(c.get("id") == central_id for c in _central(connection)):
        raise ClientError("Ese cliente no está en Central (o Central no está conectado).")
    with transaction(connection):
        connection.execute("UPDATE client SET central_id = ?, link_state = ?, updated_at = ? WHERE id = ?", (central_id, state, now(), client_id))
    return get(connection, client_id)


# --- the directory ---------------------------------------------------------------------------------------------

def _central(connection: sqlite3.Connection) -> list[dict]:
    from . import central

    return [c for c in ((central.snapshot(connection) or {}).get("clients") or []) if c.get("name")]


def _own_domains(entry: dict) -> list[str]:
    found = list(entry.get("domains") or [])
    mail = domain(entry.get("email"))
    if mail and mail not in FREE_MAIL and mail not in found:
        found.append(mail)
    return found


def _unique(entries: list[dict], key, wanted) -> dict | None:
    if not wanted:
        return None
    found = [e for e in entries if key(e) == wanted]
    return found[0] if len(found) == 1 else None


def build(connection: sqlite3.Connection) -> tuple[list[dict], list[dict]]:
    """The directory and the suggestions of links. Each entry has the snapshot's shape (`name`, `company`, `email`,
    `phone`, `taxId`, `domains`, `projects`, `websites`) plus `source` (`central`, `local`, `ambos`), `localId`,
    `centralId` and `aliases` (other names it is known by, the local one when it differs)."""
    entries = [{"name": c["name"], "company": c.get("company"), "email": c.get("email"), "phone": c.get("phone"), "taxId": c.get("taxId"),
                "domains": list(c.get("domains") or []), "projects": list(c.get("projects") or []), "websites": list(c.get("websites") or []),
                "source": "central", "localId": None, "centralId": c.get("id"), "aliases": []} for c in _central(connection)]
    remote = list(entries)
    suggestions: list[dict] = []
    for own in local(connection):
        refused = own["centralId"] if own["linkState"] == "distinct" else None
        free = [e for e in remote if e["localId"] is None and (e["centralId"] is None or e["centralId"] != refused)]
        target = None
        if own["linkState"] == "linked":
            target = next((e for e in free if e["centralId"] == own["centralId"]), None)
        target = target or next((e for e in free if same_name(e["name"]) == same_name(own["name"])), None)
        target = target or _unique(free, lambda e: tax_key(e["taxId"]), tax_key(own["taxId"]))
        target = target or _unique(free, lambda e: (e["email"] or "").lower() or None, (own["email"] or "").lower() or None)
        if target:
            for field in ("company", "email", "phone", "taxId"):
                target[field] = target[field] or own[field]
            target["domains"] = sorted(set(target["domains"]) | set(_own_domains(own)))
            target.update(source="ambos", localId=own["localId"])
            if same_name(own["name"]) != same_name(target["name"]):
                target["aliases"].append(own["name"])
            continue
        entries.append({"name": own["name"], "company": own["company"], "email": own["email"], "phone": own["phone"], "taxId": own["taxId"],
                        "domains": sorted(_own_domains(own)), "projects": [], "websites": [], "source": "local", "localId": own["localId"],
                        "centralId": None, "aliases": []})
        alike = next((e for e in free if loose(e["name"]) and loose(e["name"]) == loose(own["name"]) and e["centralId"]), None)
        if alike:
            suggestions.append({"localId": own["localId"], "localName": own["name"], "centralId": alike["centralId"], "centralName": alike["name"]})
    entries.sort(key=lambda e: (e["name"].casefold(), e["source"]))
    return entries, suggestions


def directory(connection: sqlite3.Connection) -> list[dict]:
    return build(connection)[0]


def public(entry: dict) -> dict:
    """What the screen's lists and a model may see: no address, phone, tax id nor notes."""
    return {k: v for k, v in entry.items() if k not in PRIVATE_FIELDS}


def find(entries: list[dict], address: str | None = None, phone: str | None = None, tax_id: str | None = None) -> dict | None:
    """The client a sender, a number or a tax id belongs to, among `entries` (the directory, read once). An address
    by itself or else by its domain (never a free mail domain, which many people share); a phone by its digits, or by
    its last nine when the kept one has no prefix and only one client has them; a tax id exactly. Nothing by name."""
    if address:
        address = address.strip().lower()
        exact = next((e for e in entries if (e.get("email") or "").lower() == address), None)
        if exact:
            return exact
        host = domain(address)
        if host and host not in FREE_MAIL:
            found = next((e for e in entries if host in e["domains"] or any(host.endswith("." + d) for d in e["domains"])), None)
            if found:
                return found
    if phone and (digits := phone_key(phone)):
        exact = [e for e in entries if phone_key(e.get("phone")) == digits]
        if exact:
            return exact[0] if len(exact) == 1 else None
        if len(digits) > LOCAL_PHONE_DIGITS:
            short = [e for e in entries if (k := phone_key(e.get("phone"))) and len(k) == LOCAL_PHONE_DIGITS
                     and not str(e.get("phone")).strip().startswith("+") and digits.endswith(k)]
            if len(short) == 1:
                return short[0]
    if tax_id and (wanted := tax_key(tax_id)):
        found = [e for e in entries if tax_key(e.get("taxId")) == wanted]
        if len(found) == 1:
            return found[0]
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
