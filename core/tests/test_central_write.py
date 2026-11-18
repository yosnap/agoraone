"""Changes to Central from AgoraOne's views: preview with the exact change (before and after) checked against what
Central has now, then a single-use token that sends exactly that body once, always with the version read; a 409
answered with what there is now and never retried; a key without `escritura` refused before asking Central for any
read or write; modules off answering 404; Watson without a way in; «Crear en Central» linking the own client.
Central is a stand-in with the real shape and rules of its write API (`src/lib/api/mutations/*`, branch
`feat/api-v1-escrituras`): version as a hash of the editable fields, 409 `conflict`/`duplicate`/`status_locked` with
`current`, 422 for ARCHIVED and `statusLocked: false`, 503 when busy."""

import asyncio
import hashlib
import json
import threading
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from agora_core import brain_tools, central_api
from test_assistant import MemorySecrets
from test_central_api import HEADERS, KEY, URL, app_with

C1, C2 = "c" + "1" * 24, "c" + "9" * 24
P1 = "p" + "1" * 24
Q1, F1 = "q" + "1" * 24, "f" + "1" * 24
NOW = "2026-11-18T10:00:00.000Z"


def version(fields: dict) -> str:
    return hashlib.sha256(json.dumps(sorted(fields.items()), default=str).encode()).hexdigest()[:20]


class FakeCentral:
    """Central's API v1 with writes. `scopes` of the key; `busy` answers the next write with 503; `slow` holds a write."""

    def __init__(self, scopes=("lectura", "escritura", "presupuestos")):
        self.scopes = list(scopes)
        self.seen: list[httpx.Request] = []
        self.busy = False
        self.fail_writes: int | None = None
        self.client = {"id": C1, "name": "Cliente Uno", "company": "Uno SL", "email": "info@clienteuno.com", "phone": "600000001",
                       "taxId": "B12345678", "address": "Calle Falsa 1"}
        self.project = {"id": P1, "name": "Web Uno", "kind": "CLIENT", "status": "ACTIVE", "statusLocked": False, "phase": "Desarrollo",
                        "description": None, "clientId": C1, "version": "1.0.0"}
        self.phase = {"id": F1, "name": "Inicio", "description": None, "percent": 50, "dueDate": None, "status": "PENDING", "completedAt": None}
        self.created: list[dict] = []
        self.notes: list[dict] = []

    def client_version(self):
        return version({k: self.client[k] for k in ("name", "company", "email", "phone", "taxId", "address")})

    def project_version(self):
        return version({k: self.project[k] for k in ("name", "kind", "status", "statusLocked", "phase", "description", "clientId")})

    def phase_version(self):
        return version({k: self.phase[k] for k in ("name", "description", "percent", "dueDate", "status")})

    def writes(self):
        return [r for r in self.seen if r.method in ("POST", "PATCH")]

    def reads(self):
        return [r for r in self.seen if r.method == "GET" and r.url.path != "/api/v1/estado"]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        if request.headers.get("authorization") != f"Bearer {KEY}":
            return httpx.Response(401, json={"error": "unauthorized"})
        path, method = request.url.path, request.method
        if path == "/api/v1/estado":
            return httpx.Response(200, json={"version": "0.6.0", "api": "v1", "scopes": self.scopes, "runtime": "production"})
        write = method in ("POST", "PATCH")
        need = ["escritura", "lectura"] if write else ["lectura"]
        if "/presupuestos" in path:
            need = need + ["presupuestos"] if write else ["presupuestos"]
        missing = [s for s in need if s not in self.scopes]
        if missing:
            return httpx.Response(403, json={"error": "forbidden", "scope": missing[0]})
        if write and self.busy:
            self.busy = False
            return httpx.Response(503, json={"error": "busy", "detail": "ocupada"}, headers={"retry-after": "2"})
        if write and self.fail_writes:
            return httpx.Response(self.fail_writes, json={"error": "internal"})
        body = json.loads(request.content) if request.content else {}
        if method == "GET" and path in ("/api/v1/clientes", "/api/v1/proyectos", "/api/v1/webs", "/api/v1/servidores"):
            rows = {"/api/v1/clientes": ("clients", [{**self.client, "projects": 1, "websites": 0, "version": self.client_version()}]),
                    "/api/v1/proyectos": ("projects", [{"id": P1, "name": "Web Uno", "status": "ACTIVE", "client": "Cliente Uno"}]),
                    "/api/v1/webs": ("websites", []), "/api/v1/servidores": ("servers", [])}[path]
            return httpx.Response(200, json={rows[0]: rows[1], "nextCursor": None})
        if path == f"/api/v1/clientes/{C1}":
            if method == "GET":
                return httpx.Response(200, json={**self.client, "projects": [], "websites": [], "notes": [], "version": self.client_version()})
            if body.pop("version", None) != self.client_version():
                return httpx.Response(409, json={"error": "conflict", "detail": "Ha cambiado", "current": {**self.client, "version": self.client_version()}})
            self.client.update(body)
            return httpx.Response(200, json={"client": {**self.client, "version": self.client_version()}})
        if path == "/api/v1/clientes" and method == "POST":
            if body["name"].lower() in (self.client["name"].lower(), *[c["name"].lower() for c in self.created]):
                return httpx.Response(409, json={"error": "duplicate", "detail": f"Ya hay un cliente llamado «{body['name']}»"})
            self.created.append(body)
            return httpx.Response(201, json={"client": {"id": C2, **body, "version": "a" * 20}})
        if path == f"/api/v1/proyectos/{P1}":
            if method == "GET":
                return httpx.Response(200, json={**self.project, "repoUrl": None, "editVersion": self.project_version()})
            if body.get("status") == "ARCHIVED" or body.get("statusLocked") is False:
                return httpx.Response(422, json={"error": "invalid", "detail": "status: Archivar se hace en Central"})
            if body.pop("version", None) != self.project_version():
                return httpx.Response(409, json={"error": "conflict", "detail": "x", "current": {**self.project, "version": self.project_version()}})
            if "status" in body and body["status"] != self.project["status"] and self.project["statusLocked"] and "statusLocked" not in body:
                return httpx.Response(409, json={"error": "status_locked", "detail": "fijado", "current": {**self.project, "version": self.project_version()}})
            self.project.update(body)
            return httpx.Response(200, json={"project": {**self.project, "version": self.project_version()}})
        if path == f"/api/v1/presupuestos/{Q1}" and method == "GET":
            return httpx.Response(200, json={"id": Q1, "number": "P-2026-007", "phases": [{**self.phase, "version": self.phase_version()}]})
        if path == f"/api/v1/presupuestos/{Q1}/fases/{F1}":
            if body.pop("version", None) != self.phase_version():
                return httpx.Response(409, json={"error": "conflict", "detail": "x", "current": {**self.phase, "version": self.phase_version()}})
            self.phase.update(body)
            return httpx.Response(200, json={"phase": {**self.phase, "version": self.phase_version()}})
        if path == "/api/v1/notas" and method == "POST":
            self.notes.append(body)
            return httpx.Response(201, json={"note": {"id": "n" + "1" * 24, **body, "source": "api"}})
        if method == "DELETE":
            return httpx.Response(405)
        return httpx.Response(404, json={"error": "not_found"})


@pytest.fixture
def fake(monkeypatch):
    found = FakeCentral()
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(found))
    return found


@pytest.fixture
def client(tmp_path, fake):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as test_client:
        assert test_client.put("/central/connection", json={"url": URL, "key": KEY}, headers=HEADERS).status_code == 200
        test_client.put("/modules", json={"modules": {"central": True, "presupuestos": True}}, headers=HEADERS)
        yield test_client


def preview(client, **given):
    return client.post("/central/write/preview", json=given, headers=HEADERS)


def confirm(client, token):
    return client.post("/central/write/confirm", json={"token": token}, headers=HEADERS)


def test_permisos_segun_la_clave(client, fake):
    assert client.get("/central/write/permissions", headers=HEADERS).json() == {"central": True, "quotes": True, "problem": None, "quotesProblem": None}
    fake.scopes = ["lectura", "presupuestos"]
    answer = client.get("/central/write/permissions", headers=HEADERS).json()
    assert answer["central"] is False and answer["quotes"] is False and "Apps conectadas" in answer["problem"]
    fake.scopes = ["lectura", "escritura"]
    answer = client.get("/central/write/permissions", headers=HEADERS).json()
    assert answer["central"] is True and answer["quotes"] is False and answer["problem"] is None and "presupuestos" in answer["quotesProblem"]


def test_vista_previa_con_antes_y_despues_y_aviso_al_vaciar(client, fake):
    answer = preview(client, kind="cliente", id=C1, revision=fake.client_version(), changes={"phone": "", "name": "Cliente Uno", "email": "hola@uno.es"})
    assert answer.status_code == 200, answer.text
    data = answer.json()
    assert data["rows"] == [{"field": "email", "label": "Correo", "before": "info@clienteuno.com", "after": "hola@uno.es", "emptied": False},
                            {"field": "phone", "label": "Teléfono", "before": "600000001", "after": None, "emptied": True}]
    assert len(data["warnings"]) == 1 and "Teléfono" in data["warnings"][0]
    assert fake.writes() == [], "la vista previa nunca escribe"
    read = fake.client_version()
    sent = confirm(client, data["token"])
    assert sent.status_code == 200 and sent.json()["done"] is True
    patch = fake.writes()[0]
    assert patch.method == "PATCH" and json.loads(patch.content) == {"version": read, "email": "hola@uno.es", "phone": None}
    assert fake.client["phone"] is None and fake.client["email"] == "hola@uno.es"


def test_token_de_un_solo_uso_contra_el_doble_clic(client, fake):
    token = preview(client, kind="proyecto", id=P1, revision=fake.project_version(), changes={"phase": "Entrega"}).json()["token"]
    first, second = confirm(client, token), confirm(client, token)
    assert first.status_code == 200 and second.status_code == 200 and second.json()["repeated"] is True
    assert len(fake.writes()) == 1
    assert confirm(client, "x" * 32).status_code == 410


def test_dos_envios_a_la_vez_solo_escriben_una_vez(client, fake):
    token = preview(client, kind="proyecto", id=P1, revision=fake.project_version(), changes={"phase": "Entrega"}).json()["token"]
    answers: list[int] = []
    threads = [threading.Thread(target=lambda: answers.append(confirm(client, token).status_code)) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(fake.writes()) == 1 and answers.count(200) >= 1 and set(answers) <= {200, 409}


def test_conflicto_muestra_lo_actual_y_no_reintenta(client, fake):
    token = preview(client, kind="proyecto", id=P1, revision=fake.project_version(), changes={"phase": "Entrega"}).json()["token"]
    fake.project["phase"] = "Mantenimiento"  # someone changed it in Central meanwhile
    answer = confirm(client, token)
    assert answer.status_code == 409 and answer.json()["status"] == "conflict"
    assert {"field": "phase", "label": "Fase", "value": "Mantenimiento"} in answer.json()["current"]
    assert len(fake.writes()) == 1, "sin reintentos"
    assert confirm(client, token).status_code == 410, "el token se gasta: hay que volver a revisar"
    assert fake.project["phase"] == "Mantenimiento"


def test_version_vieja_en_la_vista_previa(client, fake):
    old = fake.project_version()
    fake.project["phase"] = "Otra"
    answer = preview(client, kind="proyecto", id=P1, revision=old, changes={"phase": "Entrega"})
    assert answer.status_code == 409 and "token" not in answer.json() and answer.json()["current"]
    assert fake.writes() == []


def test_estado_fijado_se_manda_y_se_explica(client, fake):
    fake.project["statusLocked"] = True
    data = preview(client, kind="proyecto", id=P1, revision=fake.project_version(), changes={"status": "DORMANT"}).json()
    assert [r["field"] for r in data["rows"]] == ["status"] and any("fijado" in n for n in data["notes"])
    assert confirm(client, data["token"]).status_code == 200
    assert json.loads(fake.writes()[0].content)["statusLocked"] is True and fake.project["status"] == "DORMANT"


@pytest.mark.parametrize("changes", [{"status": "ARCHIVED"}, {"statusLocked": False}, {"status": "VOLANDO"}, {"kumaPushToken": "x"},
                                     {"phase": "x" * 81}])
def test_cambios_no_permitidos_no_llegan_a_central(client, fake, changes):
    answer = preview(client, kind="proyecto", id=P1, revision=fake.project_version(), changes=changes)
    assert answer.status_code == 422
    assert fake.writes() == []


def test_campos_y_claves_desconocidos_se_rechazan(client, fake):
    assert preview(client, kind="cliente", id=C1, revision=fake.client_version(), changes={"notes": "x"}).status_code == 422
    assert preview(client, kind="cliente", id=C1, revision=fake.client_version(), changes={"name": "N"}, path="/api/v1/x").status_code == 422
    assert preview(client, kind="borrar", id=C1).status_code == 422
    assert preview(client, kind="cliente", id="../x", revision=fake.client_version(), changes={"name": "N"}).status_code == 422
    assert preview(client, kind="cliente", id=C1, revision=fake.client_version(), changes={"email": "no-es-correo"}).status_code == 422
    assert fake.writes() == [] and fake.reads() == []


def test_sin_permiso_de_escritura_403_sin_pedir_nada_mas(client, fake):
    fake.scopes = ["lectura", "presupuestos"]
    answer = preview(client, kind="cliente", id=C1, revision="a" * 20, changes={"name": "Otro"})
    assert answer.status_code == 403 and "Apps conectadas" in answer.json()["error"] and KEY not in answer.text
    assert fake.writes() == [] and fake.reads() == []
    fake.scopes = ["lectura", "escritura"]
    answer = preview(client, kind="fase", id=Q1, phaseId=F1, revision="a" * 20, changes={"status": "DONE"})
    assert answer.status_code == 403 and "presupuestos" in answer.json()["error"]
    assert fake.writes() == [] and fake.reads() == []


def test_modulos_apagados_responden_404(client, fake):
    token = preview(client, kind="proyecto", id=P1, revision=fake.project_version(), changes={"phase": "Entrega"}).json()["token"]
    client.put("/modules", json={"modules": {"central": False}}, headers=HEADERS)
    seen = len(fake.seen)
    assert preview(client, kind="proyecto", id=P1, revision="a" * 20, changes={"phase": "x"}).status_code == 404
    assert confirm(client, token).status_code == 404
    assert len(fake.seen) == seen and fake.writes() == []
    assert preview(client, kind="fase", id=Q1, phaseId=F1, revision=fake.phase_version(), changes={"status": "DONE"}).status_code == 200, \
        "los hitos van con Presupuestos"
    client.put("/modules", json={"modules": {"presupuestos": False}}, headers=HEADERS)
    assert preview(client, kind="fase", id=Q1, phaseId=F1, revision=fake.phase_version(), changes={"status": "DONE"}).status_code == 404
    assert client.get("/central/write/permissions", headers=HEADERS).status_code == 404


def test_hito_de_presupuesto(client, fake):
    data = preview(client, kind="fase", id=Q1, phaseId=F1, revision=fake.phase_version(), changes={"status": "DONE", "dueDate": "2026-12-01"}).json()
    assert [(r["field"], r["before"], r["after"]) for r in data["rows"]] == [("status", "Pendiente", "Hecha"), ("dueDate", None, "01/12/2026")]
    assert confirm(client, data["token"]).status_code == 200
    assert fake.phase["status"] == "DONE" and fake.phase["dueDate"] == "2026-12-01"
    assert preview(client, kind="fase", id=Q1, phaseId=F1, revision=fake.phase_version(), changes={"dueDate": "2026-02-31"}).status_code == 422


def test_nota_en_un_proyecto(client, fake):
    data = preview(client, kind="nota", target="proyecto", id=P1, body="  Llamar al cliente  ").json()
    assert data["rows"][0]["after"] == "Llamar al cliente" and "Web Uno" in data["title"]
    assert confirm(client, data["token"]).status_code == 200
    assert fake.notes == [{"body": "Llamar al cliente", "projectId": P1}]


def test_ocupada_permite_volver_a_pulsar_y_una_alta_desconocida_no_se_repite(client, fake):
    token = preview(client, kind="proyecto", id=P1, revision=fake.project_version(), changes={"phase": "Entrega"}).json()["token"]
    fake.busy = True
    busy = confirm(client, token)
    assert busy.status_code == 503 and busy.json()["status"] == "busy"
    assert confirm(client, token).status_code == 200 and fake.project["phase"] == "Entrega"
    token = preview(client, kind="nota", target="proyecto", id=P1, body="Hola").json()["token"]
    fake.fail_writes = 500
    first = confirm(client, token)
    assert first.status_code == 502 and first.json()["status"] == "unknown" and "puede haberse creado" in first.json()["error"]
    fake.fail_writes = None
    again = confirm(client, token)
    assert again.status_code == 409 and again.json()["status"] == "unknown" and fake.notes == []


def test_crear_en_central_enlaza_el_cliente_propio_sin_duplicar(client, fake):
    own = client.post("/clients", json={"name": "Cliente Nuevo", "email": "hola@nuevo.es", "taxId": "B87654321", "notes": "privado"}, headers=HEADERS).json()
    assert client.post("/central/refresh", headers=HEADERS).status_code == 200
    data = preview(client, kind="cliente-nuevo", localId=own["localId"]).json()
    assert {r["field"]: r["after"] for r in data["rows"]} == {"name": "Cliente Nuevo", "email": "hola@nuevo.es", "taxId": "B87654321"}
    assert confirm(client, data["token"]).status_code == 200
    assert fake.created == [{"name": "Cliente Nuevo", "email": "hola@nuevo.es", "taxId": "B87654321"}], "sin notas ni dominios"
    assert client.get(f"/clients/{own['localId']}", headers=HEADERS).json()["centralId"] == C2
    again = preview(client, kind="cliente-nuevo", localId=own["localId"])
    assert again.status_code == 422 and len(fake.created) == 1
    log = client.get("/clients", headers=HEADERS).json()
    assert sum(1 for c in log["clients"] if c["name"] == "Cliente Nuevo") == 1


def test_crear_en_central_no_para_un_cliente_que_ya_esta(client, fake):
    own = client.post("/clients", json={"name": "cliente uno"}, headers=HEADERS).json()
    client.post("/central/refresh", headers=HEADERS)
    assert preview(client, kind="cliente-nuevo", localId=own["localId"]).status_code == 422
    assert fake.writes() == []


def test_watson_no_tiene_herramientas_que_escriban_en_central():
    source = Path(brain_tools.__file__).read_text(encoding="utf-8")
    assert "central_write" not in source and "central/write" not in source and "central_api.write" not in source
    names = {spec["name"] for spec in brain_tools.SPECS}
    assert not {n for n in names if "central" in n or n.startswith(("cambiar", "editar"))}, names


def test_ni_la_clave_ni_la_direccion_en_errores(client, fake):
    fake.scopes = ["lectura", "escritura"]
    fake.fail_writes = 401
    token = preview(client, kind="proyecto", id=P1, revision=fake.project_version(), changes={"phase": "Entrega"}).json()["token"]
    answer = confirm(client, token)
    assert KEY not in answer.text and "central.example.com" not in answer.text


def test_las_fichas_dan_su_version_para_cambiar_sin_confundirla_con_la_del_proyecto():
    from agora_core import central_quotes, central_views

    hashed = central_views.project_record({"id": P1, "name": "Web", "version": "0123456789abcdef0123", "statusLocked": True})
    assert hashed["revision"] == "0123456789abcdef0123" and hashed["version"] is None and hashed["statusLocked"] is True
    plain = central_views.project_record({"id": P1, "name": "Web", "version": "1.0.0"})
    assert plain["revision"] is None and plain["version"] == "1.0.0", "una Central sin API de escrituras no deja cambiar"
    assert central_views.client_record({"id": C1, "name": "X", "version": "f" * 20})["revision"] == "f" * 20
    assert central_views.client_record({"id": C1, "name": "X", "version": "../x"})["revision"] is None
    phases = central_quotes.quote_record({"id": Q1, "phases": [{"id": F1, "version": "a" * 20, "name": "Inicio", "status": "PENDING"}]})["phases"]
    assert phases[0]["id"] == F1 and phases[0]["revision"] == "a" * 20


def test_crear_en_central_lee_central_ahora_y_ofrece_enlazar(client, fake):
    # Central has this client since after its last reading (another name, the same tax id): never a second one.
    own = client.post("/clients", json={"name": "Uno Soluciones", "taxId": "b-12345678"}, headers=HEADERS).json()
    answer = preview(client, kind="cliente-nuevo", localId=own["localId"])
    assert answer.status_code == 409 and answer.json()["status"] == "exists"
    assert answer.json()["centralId"] == C1 and answer.json()["centralName"] == "Cliente Uno"
    other = client.post("/clients", json={"name": "Otra Persona", "email": "INFO@clienteuno.com"}, headers=HEADERS).json()
    assert preview(client, kind="cliente-nuevo", localId=other["localId"]).json()["status"] == "exists"
    named = client.post("/clients", json={"name": "  CLIENTE   uno "}, headers=HEADERS).json()
    assert preview(client, kind="cliente-nuevo", localId=named["localId"]).json()["status"] == "exists"
    assert fake.writes() == []


def test_la_ficha_da_el_valor_completo_para_editar(client, fake):
    long = "Calle " + "x" * 400 + " /home/ana/notas"
    fake.client["address"] = long
    record = client.get(f"/central/views/clientes/{C1}", headers=HEADERS).json()
    assert record["address"] != long and record["editable"]["address"] == long, "se muestra tratado, se edita tal cual"


def test_no_se_guardan_marcadores_y_se_avisa_del_recorte(client, fake):
    fake.client["address"] = "Calle Mayor 1, 28001 Madrid, portal 3"
    answer = preview(client, kind="cliente", id=C1, revision=fake.client_version(), changes={"address": "Calle [ruta oculta] 1"})
    assert answer.status_code == 422 and "ruta oculta" in answer.json()["error"]
    cut = preview(client, kind="cliente", id=C1, revision=fake.client_version(), changes={"address": "Calle Mayor 1, 28001"}).json()
    assert any("recortado" in w for w in cut["warnings"])
    assert preview(client, kind="proyecto", id=P1, revision=fake.project_version(), changes={"phase": "Fase [IP oculta]"}).status_code == 422
    assert fake.writes() == []


@pytest.mark.parametrize("changes", [{"status": ["ACTIVE"]}, {"status": {"a": 1}}, {"phase": 3}, {"statusLocked": "true"}])
def test_tipos_que_no_son_texto_dan_422(client, fake, changes):
    assert preview(client, kind="proyecto", id=P1, revision=fake.project_version(), changes=changes).status_code == 422
    assert preview(client, kind="fase", id=Q1, phaseId=F1, revision=fake.phase_version(), changes={"status": ["DONE"]}).status_code == 422


def test_correo_y_topes_como_central(client, fake):
    for bad in ("a..b@uno.es", ".a@uno.es", "a%b@uno.es", "a@uno"):
        assert preview(client, kind="cliente", id=C1, revision=fake.client_version(), changes={"email": bad}).status_code == 422, bad
    assert preview(client, kind="cliente", id=C1, revision=fake.client_version(), changes={"name": "😀" * 60}).status_code == 200
    assert preview(client, kind="cliente", id=C1, revision=fake.client_version(), changes={"name": "😀" * 61}).status_code == 422, "120 unidades UTF-16"


def test_la_version_de_edicion_del_proyecto_y_su_version_de_software(client, fake):
    record = client.get(f"/central/views/proyectos/{P1}", headers=HEADERS).json()
    assert record["revision"] == fake.project_version() and record["version"] == "1.0.0"


def test_si_cambia_la_conexion_no_se_envia_a_otra_central(client, fake):
    token = preview(client, kind="proyecto", id=P1, revision=fake.project_version(), changes={"phase": "Entrega"}).json()["token"]
    other = "cen_" + "Zz9_-" * 8 + "abc"
    assert client.put("/central/connection", json={"url": URL, "key": other}, headers=HEADERS).status_code == 200
    answer = confirm(client, token)
    assert answer.status_code == 409 and answer.json()["status"] == "expired" and fake.writes() == []


def test_envios_simultaneos_en_el_mismo_bucle(client, fake):
    """Several confirmations at once in one event loop: the reservation before any wait lets one only through."""
    token = preview(client, kind="nota", target="proyecto", id=P1, body="Una vez").json()["token"]
    app = client.app

    async def run():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url=str(client.base_url)) as asynchronous:
            answers = await asyncio.gather(*[asynchronous.post("/central/write/confirm", json={"token": token}, headers=HEADERS) for _ in range(6)])
        return [a.json().get("status") if a.status_code != 200 else "ok" for a in answers]
    outcomes = asyncio.run(run())
    assert len(fake.notes) == 1 and outcomes.count("ok") >= 1 and set(outcomes) <= {"ok", "repeated"}, outcomes
