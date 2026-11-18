"""The «Central» section's views: a closed list of views mapped to fixed paths of Central's API, ids with the shape of
a cuid, allowed query parameters per view, nothing of a machine (paths, IPs, tokens, Central's own links) on screen,
contact only in a client's record, errors without the key nor Central's address, the snapshot as a fallback for
clients, and everything answering 404 with the «Central» module off without asking Central anything.
Central is a stand-in with the real shape of its API v1 (`src/lib/api/*`, `src/lib/alerts.ts`) and invented data."""

import logging

import httpx
import pytest
from fastapi.testclient import TestClient

from agora_core import central_api, central_views
from test_assistant import MemorySecrets
from test_central_api import HEADERS, KEY, URL, app_with

C1, C2 = "c" + "1" * 24, "c" + "2" * 24
P1, P2, P3 = "p" + "1" * 24, "p" + "2" * 24, "p" + "3" * 24
NOW = "2026-11-18T10:00:00.000Z"
CLIENTS = [
    {"id": C1, "name": "Cliente Uno", "company": "Uno SL", "email": "info@clienteuno.com", "phone": "+34 600 000 001", "taxId": "B12345678",
     "address": "Calle Falsa 1", "projects": 2, "websites": 1, "createdAt": NOW, "updatedAt": NOW},
    {"id": C2, "name": "Cliente Dos", "company": None, "email": None, "phone": None, "taxId": None, "address": None, "projects": 1, "websites": 0,
     "createdAt": NOW, "updatedAt": NOW},
]


def row(pid, name, status, client):
    return {"id": pid, "name": name, "type": "web", "platform": None, "kind": "CLIENT", "status": status, "phase": "Producción", "client": client,
            "version": "1.0.0", "framework": "next", "stack": ["next"], "repo": "https://github.com/ejemplo/web", "lastActivity": NOW, "uncommitted": 0}


PROJECTS = [row(P1, "Web Uno", "ACTIVE", "Cliente Uno"), row(P2, "Tienda", "ACTIVE", "Cliente Uno"), row(P3, "Blog", "DORMANT", "Cliente Dos")]
ALERTS = [
    {"key": "web-down-x", "kind": "web", "level": "critical", "title": "Web Uno", "detail": "Caída (código 502)", "href": f"/proyectos/{P1}", "at": NOW},
    {"key": "server-checks-s", "kind": "server", "level": "warning", "title": "hetzner-1",
     "detail": "Protección incompleta en 203.0.113.7:22 con /Users/ana/.ssh/id_ed25519", "href": "/servidores/s1", "at": NOW},
]
PENDING = [{"id": P2, "name": "Tienda", "client": "Cliente Uno", "missing": ["Repositorio", "Hosting"]}]
CLIENT_RECORD = {**CLIENTS[0], "projects": [{"id": P1, "name": "Web Uno", "kind": "CLIENT", "status": "ACTIVE", "phase": "Producción", "version": "1.0.0",
                                              "repoUrl": "git@github.com:ejemplo/web.git", "lastActivityAt": NOW}],
                 "websites": [{"id": "w" + "1" * 24, "url": "https://www.clienteuno.com", "label": "Web", "kind": "CLIENT", "lastStatus": "up", "lastCode": 200,
                               "lastMs": 120, "lastCheckedAt": NOW, "sslDaysLeft": 40},
                              {"id": "w" + "2" * 24, "url": "http://203.0.113.7:3000", "label": "Directa", "kind": "CLIENT", "lastStatus": "up", "lastCode": 200,
                               "lastMs": 90, "lastCheckedAt": NOW, "sslDaysLeft": None}],
                 "notes": [{"id": "n" + "1" * 24, "body": "Llamar el lunes; copia en /home/ana/backup", "pinned": True, "source": "app", "createdAt": NOW}]}
PROJECT_RECORD = {
    "id": P1, "slug": "github.com/ejemplo/web", "name": "Web Uno", "kind": "CLIENT", "status": "ACTIVE", "phase": "Producción", "description": "La web",
    "version": "1.0.0", "framework": "next", "stack": ["next", "postgres"], "repoUrl": "https://github.com/ejemplo/web", "defaultBranch": "main",
    "deployStatus": "PRODUCTION", "hosting": "Dokploy · Hetzner", "deployedVersion": "0.9.0", "environments": ["production"],
    "localUrl": "http://localhost:3000", "envFiles": [{"name": ".env.local"}], "localCompose": {"web": {"ports": ["3000:3000"]}}, "composeProject": "web",
    "lastActivityAt": NOW, "client": {"id": C1, "name": "Cliente Uno", "email": "info@clienteuno.com"},
    "locations": [{"id": "l" + "1" * 24, "path": "/Users/ana/Proyectos/web", "kind": "MAIN"}],
    "services": [{"id": "s" + "1" * 24, "name": "web", "environment": "production", "url": "https://www.clienteuno.com", "hosting": None,
                  "liveVersion": "0.9.0", "liveVersionAt": NOW, "serverId": "srv", "notes": "ssh root@203.0.113.7"}],
    "websites": CLIENT_RECORD["websites"][:1], "notes": [], "kumaPushId": 3,
}


class FakeCentral:
    """Answers like Central's API v1 for `KEY`; `fail` makes every read answer that status."""

    def __init__(self):
        self.seen: list[httpx.Request] = []
        self.fail: int | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        if request.headers.get("authorization") != f"Bearer {KEY}":
            return httpx.Response(401, json={"error": "unauthorized"})
        path = request.url.path
        if path == "/api/v1/estado":
            return httpx.Response(200, json={"version": "0.5.0", "api": "v1", "scopes": ["lectura"], "runtime": "production"})
        if self.fail:
            return httpx.Response(self.fail, json={"error": "internal", "detail": f"con {KEY}"})
        if path == "/api/v1/clientes":
            return httpx.Response(200, json={"clients": CLIENTS})
        if path == f"/api/v1/clientes/{C1}":
            return httpx.Response(200, json=CLIENT_RECORD)
        if path == "/api/v1/proyectos":
            status = request.url.params.get("estado")
            found = [p for p in PROJECTS if not status or p["status"] == status]
            if request.url.params.get("cursor") == P1:
                return httpx.Response(200, json={"projects": found[1:], "nextCursor": None})
            return httpx.Response(200, json={"projects": found[:1], "nextCursor": P1 if len(found) > 1 else None})
        if path == f"/api/v1/proyectos/{P1}":
            return httpx.Response(200, json=PROJECT_RECORD)
        if path == "/api/v1/alertas":
            return httpx.Response(200, json={"alerts": ALERTS})
        if path == "/api/v1/pendientes":
            return httpx.Response(200, json={"pending": PENDING})
        if path == "/api/v1/webs":
            return httpx.Response(200, json={"websites": []})
        if path == "/api/v1/servidores":
            return httpx.Response(200, json={"servers": []})
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
        yield test_client


def paths(fake: FakeCentral) -> list[str]:
    return [r.url.path for r in fake.seen if r.url.path != "/api/v1/estado"]


def test_vistas_fuera_de_la_lista_no_existen(client, fake):
    for path in ("/central/views/ajustes", "/central/views/..%2Fajustes", "/central/views/alertas/" + C1, "/central/views/resumen/" + C1,
                 "/central/views/secretos/" + C1):
        answer = client.get(path, headers=HEADERS)
        assert answer.status_code == 404, path
    assert paths(fake) == [], "no se pide nada a Central"


@pytest.mark.parametrize("item", ["a/b", C1 + "/notas", "..", "%2E%2E", "abc%3Fx%3D1", "C" + "1" * 24, "corto", "c" * 33, C1 + "%2F..%2Fsecretos"])
def test_identificador_con_forma_de_cuid(client, fake, item):
    answer = client.get(f"/central/views/clientes/{item}", headers=HEADERS)
    assert answer.status_code in (404, 422), item
    assert answer.status_code == 422 or item in ("..",), item
    assert paths(fake) == []


def test_parametros_permitidos_por_vista(client, fake):
    for path in ("/central/views/alertas?q=x", "/central/views/proyectos?estado=BORRADO", "/central/views/proyectos?limite=500", "/central/views/proyectos?limite=²", "/central/views/proyectos?limite=٣",
                 "/central/views/proyectos?limite=１",
                 "/central/views/proyectos?cursor=../x", "/central/views/proyectos?ruta=/api/v1/secretos", "/central/views/clientes/" + C1 + "?x=1"):
        assert client.get(path, headers=HEADERS).status_code == 422, path
    assert paths(fake) == []


def test_cada_vista_pide_su_ruta_fija(client, fake):
    for view in ("alertas", "pendientes", "clientes", "proyectos"):
        assert client.get(f"/central/views/{view}", headers=HEADERS).status_code == 200
    client.get("/central/views/proyectos?estado=ACTIVE&cliente=Uno&q=web&limite=20", headers=HEADERS)
    client.get(f"/central/views/clientes/{C1}", headers=HEADERS)
    client.get(f"/central/views/proyectos/{P1}", headers=HEADERS)
    assert paths(fake) == ["/api/v1/alertas", "/api/v1/pendientes", "/api/v1/clientes", "/api/v1/proyectos", "/api/v1/proyectos",
                           f"/api/v1/clientes/{C1}", f"/api/v1/proyectos/{P1}"]
    assert all(str(r.url).startswith(URL + "/api/v1/") for r in fake.seen)
    assert dict(fake.seen[-3].url.params) == {"estado": "ACTIVE", "cliente": "Uno", "q": "web", "limite": "20"}


def test_listas_sin_contacto_y_ficha_con_contacto(client):
    clients = client.get("/central/views/clientes", headers=HEADERS).json()["clients"]
    assert clients[0] == {"id": C1, "name": "Cliente Uno", "company": "Uno SL", "projects": 2, "websites": 1}
    record = client.get(f"/central/views/clientes/{C1}", headers=HEADERS).json()
    assert record["email"] == "info@clienteuno.com" and record["taxId"] == "B12345678" and record["address"] == "Calle Falsa 1"
    assert record["projects"][0]["repo"] == "ejemplo/web" and "repoUrl" not in record["projects"][0]
    assert [w["url"] for w in record["websites"]] == ["https://www.clienteuno.com", None], "una dirección con IP nunca se muestra"
    assert "/home/ana" not in record["notes"][0]["body"] and "[ruta oculta]" in record["notes"][0]["body"]


def test_alertas_pendientes_y_proyectos_sin_rutas_ni_ips(client):
    alerts = client.get("/central/views/alertas", headers=HEADERS).json()["alerts"]
    assert [a["level"] for a in alerts] == ["critical", "warning"] and all("href" not in a for a in alerts)
    assert "203.0.113.7" not in alerts[1]["detail"] and "/Users/" not in alerts[1]["detail"] and "id_ed25519" not in alerts[1]["detail"]
    assert client.get("/central/views/pendientes", headers=HEADERS).json() == {"pending": [{"id": P2, "name": "Tienda", "client": "Cliente Uno", "missing": ["Repositorio", "Hosting"]}]}
    page = client.get("/central/views/proyectos", headers=HEADERS).json()
    assert [p["name"] for p in page["projects"]] == ["Web Uno"] and page["nextCursor"] == P1
    assert [p["name"] for p in client.get(f"/central/views/proyectos?cursor={P1}", headers=HEADERS).json()["projects"]] == ["Tienda", "Blog"]
    shown = client.get(f"/central/views/proyectos/{P1}", headers=HEADERS)
    record = shown.json()
    assert record["deploy"] == {"status": "PRODUCTION", "hosting": "Dokploy · Hetzner", "version": "0.9.0", "environments": ["production"]}
    assert record["services"][0]["liveVersion"] == "0.9.0" and "notes" not in record["services"][0] and "serverId" not in record["services"][0]
    assert record["client"] == {"id": C1, "name": "Cliente Uno"}
    for hidden in ("/Users/ana", "localhost:3000", ".env.local", "203.0.113.7", "locations", "slug", "composeProject", "kumaPush"):
        assert hidden not in shown.text, hidden


def test_resumen(client):
    summary = client.get("/central/views/resumen", headers=HEADERS).json()
    assert summary == {"alerts": {"critical": 1, "warning": 1}, "pending": 1, "clients": 2, "activeProjects": 2, "activeProjectsMore": False}


def test_modulo_apagado_responde_404_sin_pedir_nada(client, fake):
    client.put("/modules", json={"modules": {"central": False}}, headers=HEADERS)
    seen = len(fake.seen)
    for path in ("/central/views/resumen", "/central/views/clientes", f"/central/views/clientes/{C1}", "/central/views/ajustes", "/central/views/clientes/a/b"):
        answer = client.get(path, headers=HEADERS)
        assert answer.status_code == 404 and answer.json()["status"] == "off", path
    assert len(fake.seen) == seen


def test_sin_conexion_http_pide_conectar(client, fake):
    client.delete("/central/connection", headers=HEADERS)
    client.put("/modules", json={"modules": {"central": True}}, headers=HEADERS)
    answer = client.get("/central/views/resumen", headers=HEADERS)
    assert answer.status_code == 409 and answer.json()["status"] == "not_connected"
    assert paths(fake) == []


def test_sin_cabecera_de_acceso_no_hay_vistas(client):
    assert client.get("/central/views/resumen").status_code in (401, 403)


def test_un_fallo_de_central_es_502_sin_clave_ni_direccion(client, fake, caplog):
    caplog.set_level(logging.DEBUG)
    fake.fail = 500
    for path in ("/central/views/resumen", "/central/views/proyectos", f"/central/views/proyectos/{P1}", "/central/views/clientes"):
        answer = client.get(path, headers=HEADERS)
        assert answer.status_code == 502, path
        assert KEY not in answer.text and "central.example.com" not in answer.text and answer.json()["status"] == "unreachable"
    fake.fail = 400
    answer = client.get("/central/views/alertas", headers=HEADERS)
    assert answer.status_code == 502 and KEY not in answer.text and "***" in answer.text
    assert KEY not in caplog.text
    fake.fail = None
    assert client.get("/central/views/proyectos/" + "p" + "9" * 24, headers=HEADERS).status_code == 404


def test_clientes_con_la_instantanea_si_central_no_responde(client, fake):
    assert client.post("/central/refresh", headers=HEADERS).status_code == 200
    fake.fail = 503
    listed = client.get("/central/views/clientes", headers=HEADERS)
    assert listed.status_code == 200
    data = listed.json()
    assert [c["name"] for c in data["clients"]] == ["Cliente Dos", "Cliente Uno"] and data["fallback"]["readAt"]
    assert all(set(c) == {"id", "name", "company", "projects", "websites"} for c in data["clients"]), "sin contacto en la lista"
    record = client.get(f"/central/views/clientes/{C1}", headers=HEADERS).json()
    assert record["fallback"]["readAt"] and record["email"] == "info@clienteuno.com" and record["notes"] == []
    assert client.get("/central/views/proyectos", headers=HEADERS).status_code == 502, "los proyectos no tienen respaldo"
    assert client.get("/central/views/clientes/" + "c" + "9" * 24, headers=HEADERS).status_code == 502
    assert KEY not in listed.text


def test_el_filtro_de_cliente_es_exacto(client, fake):
    # Central filters «cliente» as «contains»; the core keeps only that client's own projects.
    assert client.get("/central/views/proyectos?cliente=Uno", headers=HEADERS).json()["projects"] == []
    page = client.get("/central/views/proyectos?cliente=cliente%20uno", headers=HEADERS).json()
    assert [p["name"] for p in page["projects"]] == ["Web Uno"] and page["nextCursor"] == P1


def test_el_resumen_se_guarda_unos_segundos(client, fake):
    first = client.get("/central/views/resumen", headers=HEADERS).json()
    asked = len(paths(fake))
    assert client.get("/central/views/resumen", headers=HEADERS).json() == first
    assert len(paths(fake)) == asked, "la segunda vez no se pide nada"


def test_el_limpiador_no_toca_direcciones_web():
    assert central_views._text("Ver https://ejemplo.com/opt/app y http://ejemplo.com/var/x") == "Ver https://ejemplo.com/opt/app y http://ejemplo.com/var/x"
    assert central_views._text("copia en /opt/app y ~/claves") == "copia en [ruta oculta] y [ruta oculta]"


@pytest.mark.parametrize("url", ["http://0x7f000001/", "http://2130706433/", "http://017700000001/", "http://127.1/", "http://intranet/",
                                 "https://web.203.0.113.7.sslip.io", "http://[::1]/", "ftp://ejemplo.com"])
def test_direcciones_web_que_no_se_muestran(url):
    assert central_views._web_url(url) is None


def test_direcciones_web_que_si_se_muestran():
    assert central_views._web_url("https://www.clienteuno.com/tienda") == "https://www.clienteuno.com/tienda"
    assert central_views._web_url("https://xn--caf-dma.es") == "https://xn--caf-dma.es"
