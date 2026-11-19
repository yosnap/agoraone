"""The connectors of AgoraOne: every external module the user connects, described the same way so the screen draws
one card per connector and a new one is added by declaring it in `REGISTRY`.

Each connector has a kind and an adapter of that kind: `web_api` (a URL and a key in the system's secret store,
`web_api.py`), `local_port` (a panel of this computer on 127.0.0.1), `local_file` (a data file read in read-only
mode) and `guide` (nothing to connect: instructions to follow). Every adapter answers the same state:
`{status, configured, notice, storeProblem}`; a key never appears in it, only `hasKey`.

Connecting and disconnecting never depend on a module being on. Forgetting a connector never deletes what was read
from it: only its key or its local setting."""

import sqlite3
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from . import addons, central, central_api, crmdev_api, modules, web_api

STATUSES = ("not_configured", "legacy", "saved", "responding", "failing", "detected", "recording", "not_found", "unreadable", "guide")
NEW_ORIGIN = "Para otra dirección (otro servidor, puerto o esquema), escribe otra vez la clave: la guardada no viaja a un servidor nuevo."
NOTHING_TO_SAVE = "Este conector no guarda nada: sigue sus indicaciones."


class ConnectorError(ValueError):
    """A request that cannot be done as asked; `status` is the HTTP status to answer (422 or 503)."""

    def __init__(self, message: str, status: int = 422, kind: str = "config"):
        super().__init__(message)
        self.status = status
        self.kind = kind


def _state(status: str, configured: dict | None = None, notice: str | None = None, store_problem: str | None = None) -> dict:
    return {"status": status, "configured": configured or {}, "notice": notice, "storeProblem": store_problem}


class Adapter(Protocol):
    hint: str | None  # an example of what to write (a URL), or None

    def state(self, connection: sqlite3.Connection, secrets) -> dict: ...

    def save(self, connection: sqlite3.Connection, secrets, body: dict) -> None: ...

    def test(self, connection: sqlite3.Connection, secrets, body: dict) -> dict: ...

    def forget(self, connection: sqlite3.Connection, secrets) -> None: ...


class WebApiAdapter:
    """A service reached through its web API. `probe` asks it with a connection and answers its version and the
    permissions of the key; `legacy` says whether an older way of connecting is still set (shown, never used),
    `after_save` runs once a URL is saved and `after_forget` once the key is forgotten."""

    def __init__(self, spec: web_api.WebApiSpec, probe: Callable[[web_api.Connection], dict],
                 legacy: Callable[[sqlite3.Connection], bool] | None = None, notice: str | None = None,
                 after_save: Callable[[sqlite3.Connection, bool], None] | None = None,
                 after_forget: Callable[[], None] | None = None):
        self.spec, self.probe, self.legacy, self.notice, self.after_save = spec, probe, legacy, notice, after_save
        self.after_forget = after_forget
        self.hint = spec.example_url
        self._lock = threading.Lock()  # the origin check, the key and the URL change together

    def state(self, connection, secrets) -> dict:
        url = web_api.saved_url(self.spec, connection)
        try:
            has_key, store = web_api.read_key(self.spec, secrets) is not None, None
        except web_api.WebApiError as error:
            has_key, store = False, str(error)
        configured = {"url": url, "hasKey": has_key}
        if url and has_key:
            return _state("saved", configured, None, store)
        if self.legacy is not None and self.legacy(connection):
            return _state("legacy", configured, self.notice, store)
        return _state("not_configured", configured, None, store)

    def save(self, connection, secrets, body: dict) -> None:
        """`url` is required (a null forgets it); a missing `key` keeps the saved one, which never goes to another
        origin; a null `key` forgets it."""
        with self._lock:
            self._save(connection, secrets, body)

    def _save(self, connection, secrets, body: dict) -> None:
        if "url" not in body:
            raise ConnectorError(web_api.url_problem(self.spec, None) or "")
        url, key = body["url"], body.get("key")
        if url is not None and (problem := web_api.url_problem(self.spec, url)):
            raise ConnectorError(problem)
        if key is not None:
            if problem := web_api.key_problem(self.spec, key):
                raise ConnectorError(problem)
        elif "key" not in body and url is not None and not web_api.same_origin(self.spec, web_api.saved_url(self.spec, connection), url):
            raise ConnectorError(NEW_ORIGIN)
        if "key" in body:
            try:
                web_api.write_key(self.spec, secrets, key.strip() if isinstance(key, str) else None)
            except web_api.WebApiError as error:
                raise ConnectorError(str(error), 503) from None
        web_api.save_url(self.spec, connection, url)
        if self.after_save is not None:
            self.after_save(connection, web_api.connection_of(self.spec, connection, secrets) is not None)

    def test(self, connection, secrets, body: dict) -> dict:
        """Asks the service with the URL and key typed (not saved) or, when missing, the saved ones; the saved key
        never goes to another origin."""
        url, key = body.get("url"), body.get("key")
        if url is not None and (problem := web_api.url_problem(self.spec, url)):
            raise ConnectorError(problem)
        if key is not None and (problem := web_api.key_problem(self.spec, key)):
            raise ConnectorError(problem)
        saved = web_api.saved_url(self.spec, connection)
        target = web_api.normalize_url(self.spec, url) if url is not None else saved
        if not isinstance(key, str) and target and not web_api.same_origin(self.spec, saved, target):
            raise ConnectorError(NEW_ORIGIN)
        try:
            key = key.strip() if isinstance(key, str) else web_api.read_key(self.spec, secrets)
            if not target or not key:
                raise ConnectorError(f"Escribe la dirección y la clave de {self.spec.name}.")
            return self.probe(web_api.Connection(target, key))
        except web_api.WebApiError as error:
            raise ConnectorError(str(error), {"config": 422, "busy": 429}.get(error.status, 502), error.status) from None

    def forget(self, connection, secrets) -> None:
        """Forgets the key only: the URL is not secret and stays, and so does whatever was read."""
        try:
            with self._lock:
                web_api.write_key(self.spec, secrets, None)
        except web_api.WebApiError as error:
            raise ConnectorError(str(error), 503) from None
        if self.after_forget is not None:
            self.after_forget()


class LocalAdapter:
    """An add-on of this computer (`addons.py`): a panel on a port of 127.0.0.1 (`local_port`) or a data file
    read in read-only mode (`local_file`). Only its own settings are accepted; a null forgets one."""
    hint = None

    def __init__(self, addon: str):
        self.addon = addon

    def state(self, connection, secrets) -> dict:
        settings = addons.config(connection, self.addon)
        configured = {k: settings.get(k) for k in sorted(addons.ALLOWED[self.addon])}
        return _state(addons.status(self.addon, settings), configured)

    def save(self, connection, secrets, body: dict) -> None:
        try:
            addons.save_config(connection, self.addon, body)
        except addons.AddonError as error:
            raise ConnectorError(str(error)) from None

    def test(self, connection, secrets, body: dict) -> dict:
        """The status with what is typed over what is saved (a null keeps the saved value), without saving anything."""
        typed = {k: v for k, v in body.items() if v is not None}
        try:
            for key, value in body.items():
                if value is not None:
                    addons.check_format(self.addon, key, value)
                elif key not in addons.ALLOWED[self.addon]:
                    raise addons.AddonError("Ajuste no válido para este complemento.")
        except addons.AddonError as error:
            raise ConnectorError(str(error)) from None
        return {"status": addons.status(self.addon, {**addons.config(connection, self.addon), **typed})}

    def forget(self, connection, secrets) -> None:
        """Leaves the add-on unconfigured (its port, if any, back to the default)."""
        addons.forget(connection, self.addon)


class GuideAdapter:
    """Nothing to connect: the card shows how to do it by hand."""
    hint = None

    def state(self, connection, secrets) -> dict:
        return _state("guide")

    def save(self, connection, secrets, body: dict) -> None:
        raise ConnectorError(NOTHING_TO_SAVE)

    def test(self, connection, secrets, body: dict) -> dict:
        return {"status": "guide"}

    def forget(self, connection, secrets) -> None:
        return None


@dataclass(frozen=True)
class Connector:
    id: str
    name: str
    description: str
    kind: str  # "web_api" | "local_port" | "local_file" | "guide"
    modules: tuple[str, ...]  # switches shown on its card
    views: tuple[str, ...]  # native sections it offers
    window: str | None  # label of its own window, or None
    scopes: tuple[str, ...]  # what its key may allow, when it has one
    adapter: Adapter


def _central_saved(connection: sqlite3.Connection, connected: bool) -> None:
    modules.apply(connection)  # a first connection turns on the modules that follow Central
    if connected:
        central.forget_legacy(connection)  # the old folder setting is no longer needed; the snapshot stays


REGISTRY: dict[str, Connector] = {c.id: c for c in (
    Connector("central", "Central", "Clientes, proyectos, webs, servidores, agenda y presupuestos de Central, leídos de su API.",
              "web_api", ("central", "presupuestos"), ("central", "quotes"), "central", central_api.SCOPES,
              WebApiAdapter(central_api.SPEC, lambda target: central_api.status(target), central.legacy, central.MOVED, _central_saved)),
    Connector("crmdev", "CRMDev", "CRM de proyectos, tareas, tickets y clientes de tu organización.",
              "web_api", ("crmdev",), ("crmdev",), "crmdev", crmdev_api.SCOPES,
              WebApiAdapter(crmdev_api.SPEC, crmdev_api.probe, after_save=lambda connection, connected: crmdev_api.clear_cache(),
                            after_forget=crmdev_api.clear_cache)),
    Connector("fabrica", "Mi fábrica", "Fábrica de contenido: investiga, produce, espera aprobación, publica y mide.",
              "local_port", ("fabrica",), ("fabrica",), "fabrica", (), LocalAdapter("fabrica")),
    Connector("costguard", "CostGuard", "Mide el gasto de tokens de los agentes (Claude Code, Codex, OpenCode, pi), en solo lectura.",
              "local_file", (), (), None, (), LocalAdapter("costguard")),
    Connector("cerebro-mcp", "MCP del cerebro", "Las herramientas del cerebro para cualquier perfil de Hermes, en solo lectura.",
              "guide", (), (), None, (), GuideAdapter()),
)}


def module_owners() -> dict[str, str]:
    """Which connector's card holds the switch of each module (static: it comes from the manifests)."""
    return {name: connector.id for connector in REGISTRY.values() for name in connector.modules}


def describe(connector: Connector, connection: sqlite3.Connection, secrets) -> dict:
    on = modules.state(connection)
    return {"id": connector.id, "name": connector.name, "description": connector.description, "kind": connector.kind,
            "modules": {name: on[name] for name in connector.modules}, "views": list(connector.views), "window": connector.window,
            "scopes": list(connector.scopes), "hint": connector.adapter.hint, "state": connector.adapter.state(connection, secrets)}


def describe_all(connection: sqlite3.Connection, secrets) -> list[dict]:
    return [describe(connector, connection, secrets) for connector in REGISTRY.values()]
