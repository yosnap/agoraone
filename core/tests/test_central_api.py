"""Central over HTTP: the URL rules (https except loopback), redirections never followed, errors and logs without
the key, the size cap, the snapshot read through the API in the shape AgoraOne keeps, the connection routes (the key is
never returned nor stored in the database), and the «Central» and «Presupuestos» modules isolated when off.
Central is a stand-in with the real shape of its API v1 (`src/app/api/v1`, `src/lib/api/*`) and invented data."""

import json
import logging

import httpx
import pytest
from fastapi.testclient import TestClient

from agora_core import central, central_api, engines
from agora_core.app import SECRET_HEADER, create_app
from agora_core.db import DB_NAME, connect, migrate
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings
from agora_core.engines import Turn
from test_assistant import OWNER, SECRET, FakeEngine, MemorySecrets, events

KEY = "cen_" + "Ab3_-" * 8 + "xyz"  # 43 characters after «cen_», like Central's own
URL = "https://central.example.com"

CLIENTS = [
    {"id": "c1", "name": "Cliente Uno", "company": "Uno SL", "email": "Info@ClienteUno.com", "phone": "+34 600 000 001", "taxId": "B12345678",
     "address": "Calle Falsa 1", "projects": 2, "websites": 1, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"},
    {"id": "c2", "name": "Gmail Persona", "company": None, "email": "persona@gmail.com", "phone": None, "taxId": None,
     "address": None, "projects": 1, "websites": 0, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"},
]


def project(pid, name, status, client):
    return {"id": pid, "name": name, "type": "web", "platform": None, "kind": "CLIENT", "status": status, "phase": "Producción", "client": client,
            "version": "1.0.0", "framework": "next", "stack": ["next"], "repo": f"https://github.com/ejemplo/{pid}", "lastActivity": "2026-11-01T00:00:00.000Z",
            "uncommitted": 0}


PAGES = [[project("p1", "Web Uno", "ACTIVE", "Cliente Uno"), project("p2", "Viejo", "ARCHIVED", "Cliente Uno")], [project("p3", "Blog", "ACTIVE", "Gmail Persona")]]
WEBSITES = [{"id": "w1", "url": "https://www.clienteuno.com", "kind": "CLIENT", "client": "Cliente Uno", "status": "up", "code": 200, "ms": 120,
             "checkedAt": "2026-11-18T10:00:00.000Z"}]
SERVERS = [{"id": "s1", "name": "hetzner-1", "provider": "Hetzner", "status": "green", "cpu": 12, "memory": 40, "disk": 55, "services": [],
            "projects": [{"id": "p1", "name": "Web Uno"}]}]


class FakeCentral:
    """Answers like Central's API v1 for the key `KEY` with the given scopes."""

    def __init__(self, scopes=("lectura", "presupuestos")):
        self.scopes, self.seen, self.created = list(scopes), [], []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        if request.headers.get("authorization") != f"Bearer {KEY}":
            return httpx.Response(401, json={"error": "unauthorized"})
        path = request.url.path
        need = "presupuestos" if path.startswith("/api/v1/presupuestos") else None if path == "/api/v1/estado" else "lectura"
        if need and need not in self.scopes:
            return httpx.Response(403, json={"error": "forbidden", "scope": need})
        if path == "/api/v1/estado":
            return httpx.Response(200, json={"version": "0.5.0", "api": "v1", "scopes": self.scopes, "runtime": "production"})
        if path == "/api/v1/clientes":
            return httpx.Response(200, json={"clients": CLIENTS})
        if path == "/api/v1/proyectos":
            page = 1 if request.url.params.get("cursor") == "p2" else 0
            return httpx.Response(200, json={"projects": PAGES[page], "nextCursor": "p2" if page == 0 else None})
        if path == "/api/v1/webs":
            return httpx.Response(200, json={"websites": WEBSITES})
        if path == "/api/v1/servidores":
            return httpx.Response(200, json={"servers": SERVERS})
        if path == "/api/v1/presupuestos" and request.method == "POST":
            body = json.loads(request.content)
            if body["client"] != "Cliente Uno":
                return httpx.Response(422, json={"error": "invalid", "detail": "No existe ese cliente en Central"})
            self.created.append(body)
            return httpx.Response(201, json={"id": "q1", "number": "P-2026-007", "status": "DRAFT"})
        if path == "/api/v1/presupuestos/q1" and request.method == "GET":
            return httpx.Response(200, json={"id": "q1", "number": "P-2026-007", "status": "DRAFT", "client": {"id": "c1", "name": "Cliente Uno"}})
        return httpx.Response(404, json={"error": "not_found"})


@pytest.fixture
def fake(monkeypatch):
    found = FakeCentral()
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(found))
    return found


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "data" / DB_NAME)
    migrate(connection)
    yield connection
    connection.close()


TARGET = central_api.Connection(URL, KEY)


@pytest.mark.parametrize("url", ["http://central.example.com", "ftp://central.example.com", "https://yo:clave@central.example.com", "https://central.example.com/?a=1",
                                 "https://central.example.com/#x", "", "central.example.com", "http://192.168.1.10:3099", "https://central .example.com", 42,
                                 "https://a..b", "https://-a.com", "https://a-.com", "https://central.example.com:0", "https://central.example.com:70000",
                                 "https://" + "a" * 64 + ".com"])
def test_direcciones_rechazadas(url):
    with pytest.raises(central_api.CentralApiError):
        central_api.normalize_url(url)


def test_direcciones_aceptadas():
    assert central_api.normalize_url("http://localhost:3099/") == "http://localhost:3099"
    assert central_api.normalize_url("http://127.0.0.1:3099") == "http://127.0.0.1:3099"
    assert central_api.normalize_url("http://[::1]:3099") == "http://[::1]:3099"
    assert central_api.normalize_url(" https://central.example.com ") == "https://central.example.com"
    assert central_api.normalize_url("https://central.example.com:8443/central/") == "https://central.example.com:8443/central"
    assert "KEY" not in repr(TARGET) and KEY not in repr(TARGET)


def test_formato_de_la_clave():
    assert central_api.key_problem(KEY) is None and central_api.key_problem(f" {KEY} ") is None
    assert central_api.key_problem("cen_corta") and central_api.key_problem(123) and central_api.key_problem("ts_" + "a" * 43)


def test_estado_y_cabecera(fake):
    assert central_api.status(TARGET) == {"version": "0.5.0", "api": "v1", "scopes": ["lectura", "presupuestos"], "runtime": "production"}
    sent = fake.seen[-1]
    assert sent.url == f"{URL}/api/v1/estado" and sent.headers["authorization"] == f"Bearer {KEY}"


def test_una_redireccion_no_se_sigue(monkeypatch):
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(302, headers={"location": "https://otro.example.net/robar"})
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(handler))
    with pytest.raises(central_api.CentralApiError, match="redirección"):
        central_api.status(TARGET)
    assert seen == [f"{URL}/api/v1/estado"], "nunca se pide al otro servidor"


def test_un_401_no_repite_la_clave_ni_en_el_registro(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(lambda r: httpx.Response(401, json={"error": f"unauthorized {KEY}"})))
    with pytest.raises(central_api.CentralApiError) as failure:
        central_api.status(TARGET)
    assert failure.value.status == "auth" and KEY not in str(failure.value)
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(lambda r: httpx.Response(400, json={"error": "invalid", "detail": f"clave {KEY} rara"})))
    with pytest.raises(central_api.CentralApiError) as failure:
        central_api.status(TARGET)
    assert KEY not in str(failure.value) and "***" in str(failure.value)
    assert KEY not in caplog.text


def test_fallos_de_red_y_respuestas_raras(monkeypatch):
    def offline(request):
        raise httpx.ConnectError(f"sin red {request.headers['authorization']}")
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(offline))
    with pytest.raises(central_api.CentralApiError) as failure:
        central_api.status(TARGET)
    assert failure.value.status == "unreachable" and KEY not in str(failure.value) and failure.value.__cause__ is None
    for answer, state in ((httpx.Response(500, text="boom"), "unreachable"), (httpx.Response(200, text="<html>"), "error"),
                          (httpx.Response(200, json=[1, 2]), "error"), (httpx.Response(429, json={"error": "rate_limited"}), "unreachable"),
                          (httpx.Response(403, json={"error": "forbidden", "scope": "lectura"}), "forbidden")):
        monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(lambda r, a=answer: a))
        with pytest.raises(central_api.CentralApiError) as failure:
            central_api.status(TARGET)
        assert failure.value.status == state


def test_respuesta_demasiado_grande(monkeypatch):
    monkeypatch.setattr(central_api, "MAX_BYTES", 1000)
    big = json.dumps({"clients": [{"name": "x" * 2000}]})
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(lambda r: httpx.Response(200, text=big)))
    with pytest.raises(central_api.CentralApiError, match="demasiado grande"):
        central_api.request(TARGET, "GET", "/api/v1/clientes")

    def chunked(request):
        return httpx.Response(200, content=iter([b"{" + b" " * 600, b" " * 600 + b"}"]))
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(chunked))
    with pytest.raises(central_api.CentralApiError, match="demasiado grande"):
        central_api.request(TARGET, "GET", "/api/v1/clientes")


def test_solo_rutas_de_la_api():
    with pytest.raises(central_api.CentralApiError):
        central_api.request(TARGET, "GET", "/ajustes")


def reference_raw() -> dict:
    """The same Central as plain lists plus each client's record: the reference the API reading must equal."""
    return {"clients": [{"id": c["id"], "name": c["name"], "projects": c["projects"], "websites": c["websites"]} for c in CLIENTS],
            "projects": PAGES[0] + PAGES[1], "websites": WEBSITES, "servers": SERVERS,
            "details": {c["name"]: dict(c) for c in CLIENTS}}


def test_la_instantanea_por_http_tiene_la_forma_de_referencia(db, fake):
    by_http = central.refresh(db, TARGET)
    reference = central.refresh(db, TARGET, fetch=lambda origin: reference_raw())
    assert {**by_http, "fetchedAt": None} == {**reference, "fetchedAt": None}
    uno = by_http["clients"][0]
    assert uno["id"] == "c1" and uno["phone"] == "+34 600 000 001" and uno["email"] == "info@clienteuno.com" and uno["domains"] == ["clienteuno.com"]
    assert [p["name"] for p in uno["projects"]] == ["Web Uno", "Viejo"] and by_http["clients"][1]["projects"][0]["name"] == "Blog", "sigue las páginas"
    assert by_http["servers"] == [{"name": "hetzner-1", "status": "green", "provider": "Hetzner", "projects": ["Web Uno"]}]
    assert central.client_for(db, "ana@clienteuno.com")["name"] == "Cliente Uno"


def test_sin_permiso_de_lectura_no_se_leen_clientes(db, fake):
    fake.scopes = ["presupuestos"]
    with pytest.raises(central.CentralError, match="lectura"):
        central.refresh(db, TARGET)
    assert central.stored(db) is None
    assert [r.url.path for r in fake.seen] == ["/api/v1/estado"]
    made = central.create_quote(TARGET, {"client": "Cliente Uno", "title": "Web", "items": [{"description": "Diseño", "unitPrice": 900}]})
    assert made == {"id": "q1", "number": "P-2026-007", "client": "Cliente Uno"}
    with pytest.raises(central.CentralError, match="No existe ese cliente"):
        central.create_quote(TARGET, {"client": "Nadie", "title": "Web", "items": [{"description": "Diseño", "unitPrice": 900}]})


def test_central_solo_se_lee_con_url_y_clave(db):
    secrets = MemorySecrets()
    db.execute("INSERT INTO setting (key, value) VALUES ('addons.central', ?)", (json.dumps({"path": "/ruta/de/central"}),))
    assert central.source(db, secrets) is None, "la carpeta antigua no es una fuente"
    central_api.save_url(db, URL)
    assert central.source(db, secrets) is None, "sin clave tampoco"
    secrets.put(central_api.SECRET, KEY)
    assert central.source(db, secrets) == TARGET


def app_with(tmp_path, secrets, engine=None):
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    options = {"engines": (lambda s, k: [engine])} if engine else {}
    return settings, create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=secrets, **options)


HEADERS = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}


def test_rutas_de_la_conexion_nunca_devuelven_la_clave(tmp_path, fake, caplog):
    caplog.set_level(logging.DEBUG)
    secrets = MemorySecrets()
    settings, app = app_with(tmp_path, secrets)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        first = client.get("/central/connection", headers=HEADERS).json()
        assert first == {"url": None, "hasKey": False, "storeProblem": None, "legacy": False, "transport": None, "suggestedUrl": "https://central.example.com"}
        assert client.get("/central", headers=HEADERS).status_code == 404, "sin ninguna fuente, Central empieza apagado"
        for wrong in ({"url": "http://central.example.com", "key": KEY}, {"url": URL, "key": "cen_mala"}, {"url": URL, "key": 123}):
            answer = client.put("/central/connection", json=wrong, headers=HEADERS)
            assert answer.status_code == 422 and KEY not in answer.text and "cen_mala" not in answer.text, wrong
        assert secrets.get(central_api.SECRET) is None
        tested = client.post("/central/connection/test", json={"url": URL, "key": KEY}, headers=HEADERS)
        assert tested.status_code == 200 and tested.json()["scopes"] == ["lectura", "presupuestos"] and KEY not in tested.text
        assert secrets.get(central_api.SECRET) is None, "probar no guarda"
        saved = client.put("/central/connection", json={"url": URL + "/", "key": KEY}, headers=HEADERS)
        assert saved.status_code == 200 and KEY not in saved.text
        assert saved.json()["url"] == URL and saved.json()["hasKey"] is True and saved.json()["transport"] == "http"
        assert secrets.get(central_api.SECRET) == KEY
        assert client.put("/central/connection", json={"url": URL}, headers=HEADERS).json()["hasKey"] is True, "sin clave nueva, se conserva"
        assert client.post("/central/connection/test", headers=HEADERS).json()["version"] == "0.5.0", "con lo guardado"
        refreshed = client.post("/central/refresh", headers=HEADERS)
        assert refreshed.status_code == 200 and refreshed.json()["transport"] == "http"
        shown = client.get("/central", headers=HEADERS)
        assert shown.json()["configured"] is True and shown.json()["snapshot"]["clients"][0]["name"] == "Cliente Uno"
        assert all(set(c) & {"email", "phone", "taxId"} == set() for c in shown.json()["snapshot"]["clients"]), "sin contacto en pantalla"
        fake.scopes = []
        secrets.put(central_api.SECRET, "cen_" + "z" * 43)
        refused = client.post("/central/connection/test", headers=HEADERS)
        assert refused.status_code == 502 and refused.json()["status"] == "auth"
        secrets.put(central_api.SECRET, KEY)
        gone = client.delete("/central/connection", headers=HEADERS).json()
        assert gone["hasKey"] is False and gone["url"] == URL and secrets.get(central_api.SECRET) is None
        assert client.post("/central/refresh", headers=HEADERS).status_code == 502
        for path in ("/central", "/central/connection"):
            assert KEY not in client.get(path, headers=HEADERS).text
    c = connect(settings.data_dir / DB_NAME)
    try:
        dumped = "\n".join(str(tuple(row)) for table in ("setting", "action_log") for row in c.execute(f"SELECT * FROM {table}"))  # noqa: S608
        assert KEY not in dumped, "la clave nunca va a la base de datos"
    finally:
        c.close()
    assert KEY not in caplog.text


class BrokenStore:
    def get(self, account):
        raise RuntimeError("No recommended backend was available")

    def put(self, account, value):
        raise RuntimeError("No recommended backend was available")


def test_sin_almacen_de_secretos_se_dice_claro(tmp_path, fake):
    settings, app = app_with(tmp_path, BrokenStore())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        shown = client.get("/central/connection", headers=HEADERS).json()
        assert shown["hasKey"] is False and "Secret Service" in shown["storeProblem"]
        saved = client.put("/central/connection", json={"url": URL, "key": KEY}, headers=HEADERS)
        assert saved.status_code == 503 and "Secret Service" in saved.json()["error"] and KEY not in saved.text


def test_central_apagado_sin_rutas_ni_instantanea(tmp_path, fake):
    secrets = MemorySecrets()
    settings, app = app_with(tmp_path, secrets)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        client.put("/central/connection", json={"url": URL, "key": KEY}, headers=HEADERS)
        assert client.post("/central/refresh", headers=HEADERS).status_code == 200
        client.put("/modules", json={"modules": {"central": False}}, headers=HEADERS)
        seen = len(fake.seen)
        assert client.get("/central", headers=HEADERS).status_code == 404
        assert client.post("/central/refresh", headers=HEADERS).status_code == 404
        assert len(fake.seen) == seen, "apagado no pide nada a Central"
        assert client.get("/central/connection", headers=HEADERS).status_code == 200, "Ajustes › Central sigue disponible"
        c = connect(settings.data_dir / DB_NAME)
        try:
            assert central.stored(c) is not None and central.snapshot(c) is None, "se conserva pero no se usa"
            assert central.client_for(c, "ana@clienteuno.com") is None
        finally:
            c.close()


class QuoteEngine(FakeEngine):
    """Proposes a quote through the tool, as Claude would."""

    def __init__(self):
        super().__init__(reply=("Lo tienes en pantalla.",))
        self.answers = []

    async def stream(self, turn: Turn):
        self.answers.append(await turn.toolbox.call("proponer_presupuesto", {"cliente": "Cliente Uno", "titulo": "Web nueva",
                                                                             "partidas": [{"concepto": "Diseño", "precio": 900}]}))
        yield None
        for part in self.reply:
            yield part


def propose(client) -> dict:
    conversation = client.post("/assistant/conversations", headers=HEADERS).json()
    response = client.post(f"/assistant/conversations/{conversation['id']}/messages", json={"message": "Presupuesto para Cliente Uno"}, headers=HEADERS)
    return next(data for kind, data in events(response.text) if kind == "tool" and data["tool"] == "quote_proposal")


def test_presupuesto_por_http_solo_con_presupuestos_y_sin_lectura(tmp_path, fake):
    fake.scopes = ["presupuestos"]
    secrets = MemorySecrets()
    settings, app = app_with(tmp_path, secrets, QuoteEngine())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        client.put("/central/connection", json={"url": URL, "key": KEY}, headers=HEADERS)
        client.put("/modules", json={"modules": {"central": False}}, headers=HEADERS)
        proposal = propose(client)
        assert proposal["quote"]["client"] == "Cliente Uno", "sin instantánea, el nombre va tal cual y Central lo comprueba"
        made = client.post(f"/assistant/proposals/{proposal['id']}/quote", headers=HEADERS)
        assert made.status_code == 201 and made.json()["created"] == {"id": "q1", "number": "P-2026-007", "client": "Cliente Uno"}
        assert fake.created == [{"client": "Cliente Uno", "title": "Web nueva", "items": [{"description": "Diseño", "unitPrice": 900.0, "quantity": 1.0}]}]
        assert client.post(f"/assistant/proposals/{proposal['id']}/quote", headers=HEADERS).status_code == 404, "una sola vez"


def test_presupuestos_apagado(tmp_path, fake):
    secrets = MemorySecrets()
    settings, app = app_with(tmp_path, secrets, QuoteEngine())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        client.put("/central/connection", json={"url": URL, "key": KEY}, headers=HEADERS)
        proposal = propose(client)
        client.put("/modules", json={"modules": {"presupuestos": False}}, headers=HEADERS)
        assert "proponer_presupuesto" in engines.HIDDEN_TOOLS and "proponer_presupuesto" not in [s["name"] for s in engines._specs()]
        refused = client.post(f"/assistant/proposals/{proposal['id']}/quote", headers=HEADERS)
        assert refused.status_code == 404 and fake.created == []
        client.put("/modules", json={"modules": {"presupuestos": True}}, headers=HEADERS)
        assert client.post(f"/assistant/proposals/{proposal['id']}/quote", headers=HEADERS).status_code == 201, "la propuesta no se gastó"


def connected(client, secrets):
    assert client.put("/central/connection", json={"url": URL, "key": KEY}, headers=HEADERS).status_code == 200
    assert secrets.get(central_api.SECRET) == KEY


def test_la_clave_guardada_nunca_va_a_otro_servidor(tmp_path, fake):
    secrets = MemorySecrets()
    settings, app = app_with(tmp_path, secrets)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        assert client.put("/central/connection", json={"url": URL}, headers=HEADERS).status_code == 422, "la primera vez, con clave"
        connected(client, secrets)
        before = len(fake.seen)
        for other in ("https://central.example.net", "https://central.example.com:8443", "http://localhost:3099"):
            tested = client.post("/central/connection/test", json={"url": other}, headers=HEADERS)
            assert tested.status_code == 422 and "escribe otra vez la clave" in tested.json()["error"], other
            saved = client.put("/central/connection", json={"url": other}, headers=HEADERS)
            assert saved.status_code == 422 and "escribe otra vez la clave" in saved.json()["error"], other
        assert len(fake.seen) == before, "nada salió hacia otra dirección"
        assert client.get("/central/connection", headers=HEADERS).json()["url"] == URL
        assert client.post("/central/connection/test", json={"url": URL + "/"}, headers=HEADERS).status_code == 200, "mismo origen, vale"
        assert client.put("/central/connection", json={"url": "https://CENTRAL.example.com:443"}, headers=HEADERS).status_code == 200
        moved = client.put("/central/connection", json={"url": "https://central.example.net", "key": KEY}, headers=HEADERS)
        assert moved.status_code == 200 and moved.json()["url"] == "https://central.example.net", "con la clave escrita, sí"
        assert client.post("/central/connection/test", json={"url": "https://a..b", "key": KEY}, headers=HEADERS).status_code == 422, "nunca un 500"


def test_plazos_de_cada_peticion_y_de_toda_la_lectura(monkeypatch):
    import time

    def dripping(request):
        def chunks():
            for _ in range(5):
                time.sleep(0.03)
                yield b" "
            yield b"{}"
        return httpx.Response(200, content=chunks())
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(dripping))
    monkeypatch.setattr(central_api, "REQUEST_SECONDS", 0.05)
    with pytest.raises(central_api.CentralApiError, match="a tiempo") as failure:
        central_api.request(TARGET, "GET", "/api/v1/estado")
    assert failure.value.status == "unreachable"


def test_toda_la_lectura_con_una_conexion_y_un_plazo(monkeypatch, fake):
    opened = []
    real = httpx.Client

    def counting(*args, **kwargs):
        opened.append(kwargs.get("follow_redirects"))
        return real(*args, **kwargs)
    monkeypatch.setattr(central_api.httpx, "Client", counting)
    raw = central_api.read_all(TARGET)
    assert len(raw["projects"]) == 3 and opened == [False], "una sola conexión, sin redirecciones"
    with pytest.raises(central_api.CentralApiError, match="a tiempo"):
        central_api.read_all(TARGET, seconds=0)


def test_sin_instantanea_no_vale_un_identificador_como_cliente(tmp_path, monkeypatch):
    import asyncio
    from contextlib import contextmanager

    from agora_core.brain_tools import Toolbox
    from agora_core.embed import VectorCache

    monkeypatch.setattr(engines, "HIDDEN_TOOLS", set())
    c = connect(tmp_path / DB_NAME)
    migrate(c)

    @contextmanager
    def database():
        yield c
    box = Toolbox(database, None, VectorCache())
    box.owner = "o"
    items = [{"concepto": "Diseño", "precio": 900}]
    for raw_id in ("clx0a1b2c3d4e5f6g7h8i9j0k", "123e4567-e89b-12d3-a456-426614174000"):
        answer = json.loads(asyncio.run(box.call("proponer_presupuesto", {"cliente": raw_id, "titulo": "Web", "partidas": items})))
        assert "nombre del cliente" in answer["error"], raw_id
    answer = json.loads(asyncio.run(box.call("proponer_presupuesto", {"cliente": "Cliente Uno", "titulo": "Web", "partidas": items})))
    assert "No está creado" in answer["estado"]
    c.close()


@pytest.fixture
def no_processes(monkeypatch):
    """Central is never started: any attempt to run a program fails the test."""
    import asyncio
    import subprocess

    def refuse(*args, **kwargs):
        raise AssertionError("no se arranca ningún proceso para Central")
    monkeypatch.setattr(subprocess, "Popen", refuse)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", refuse)


def keep_snapshot(settings, legacy: bool):
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    c = connect(settings.data_dir / DB_NAME)
    try:
        migrate(c)
        central.refresh(c, TARGET, fetch=lambda origin: reference_raw())
        if legacy:
            c.execute("INSERT INTO setting (key, value) VALUES ('addons.central', ?)", (json.dumps({"path": "/ruta/de/central", "port": 3099}),))
            c.commit()
    finally:
        c.close()


def test_clave_sin_lectura_conserva_la_instantanea_y_avisa_sin_alarma(tmp_path, fake, no_processes):
    fake.scopes = ["presupuestos"]
    secrets = MemorySecrets()
    settings, app = app_with(tmp_path, secrets)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        connected(client, secrets)
        quiet = client.post("/central/refresh", headers=HEADERS)
        assert quiet.status_code == 200 and quiet.json()["problem"] is None and "lectura" in quiet.json()["notice"], "un aviso, no una avería"
        assert quiet.json()["snapshot"] is None
        shown = client.get("/central", headers=HEADERS).json()
        assert shown["problem"] is None and "lectura" in shown["notice"]
        keep_snapshot(settings, legacy=False)
        read = client.post("/central/refresh", headers=HEADERS).json()
        assert read["transport"] == "http" and read["snapshot"]["clients"][0]["name"] == "Cliente Uno", "la instantánea guardada sigue"
        assert "lectura" in read["notice"]


def test_solo_con_la_carpeta_antigua_se_ve_la_instantanea_y_el_aviso(tmp_path, fake, no_processes):
    secrets = MemorySecrets()
    settings, app = app_with(tmp_path, secrets)
    keep_snapshot(settings, legacy=True)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        shown = client.get("/central", headers=HEADERS)
        assert shown.status_code == 200, "Central sigue encendido para quien solo tenía la carpeta"
        body = shown.json()
        assert body["configured"] is False and body["transport"] is None and body["notice"] == central.MOVED
        assert body["snapshot"]["clients"][0]["name"] == "Cliente Uno" and body["snapshot"]["fetchedAt"]
        described = client.get("/central/connection", headers=HEADERS).json()
        assert described["legacy"] is True and described["transport"] is None
        assert client.post("/central/refresh", headers=HEADERS).status_code == 502, "sin dirección ni clave no se lee nada"
        assert client.get("/central", headers=HEADERS).json()["problem"] is None, "falta conectar: no es una avería"
        assert fake.seen == []
        c = connect(settings.data_dir / DB_NAME)
        try:
            before = central.stored(c)
        finally:
            c.close()
        connected(client, secrets)
        c = connect(settings.data_dir / DB_NAME)
        try:
            assert c.execute("SELECT 1 FROM setting WHERE key = 'addons.central'").fetchone() is None, "al conectar se olvida la carpeta"
            assert central.stored(c) == before, "la instantánea sigue intacta"
        finally:
            c.close()
        described = client.get("/central/connection", headers=HEADERS).json()
        assert described["legacy"] is False and described["transport"] == "http"
        assert client.get("/central", headers=HEADERS).json()["notice"] is None


def test_la_carpeta_antigua_solo_se_olvida_al_guardar_una_conexion(tmp_path, fake, no_processes):
    secrets = MemorySecrets()
    settings, app = app_with(tmp_path, secrets)
    keep_snapshot(settings, legacy=True)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        assert client.put("/central/connection", json={"url": "http://central.example.com", "key": KEY}, headers=HEADERS).status_code == 422
        assert client.delete("/central/connection", headers=HEADERS).status_code == 200
        assert client.post("/central/refresh", headers=HEADERS).status_code == 502
        assert client.get("/central/connection", headers=HEADERS).json()["legacy"] is True, "sin conexión sigue el aviso"
        c = connect(settings.data_dir / DB_NAME)
        try:
            assert central.legacy(c), "la fila se conserva mientras no haya conexión"
        finally:
            c.close()


def test_presupuesto_sin_conexion_dice_como_conectar(tmp_path, fake, no_processes):
    secrets = MemorySecrets()
    settings, app = app_with(tmp_path, secrets, QuoteEngine())
    keep_snapshot(settings, legacy=True)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        client.put("/modules", json={"modules": {"presupuestos": True}}, headers=HEADERS)
        proposal = propose(client)
        refused = client.post(f"/assistant/proposals/{proposal['id']}/quote", headers=HEADERS)
        assert refused.status_code == 422 and refused.json()["error"] == "Central no está conectado: conéctalo con su dirección y su clave."
        assert fake.seen == [] and fake.created == []
        connected(client, secrets)
        made = client.post(f"/assistant/proposals/{proposal['id']}/quote", headers=HEADERS)
        assert made.status_code == 201, "la propuesta no se gastó: se crea al conectar Central"
        assert len(fake.created) == 1


def test_una_lectura_por_la_api_olvida_la_carpeta_antigua(tmp_path, fake, no_processes):
    secrets = MemorySecrets()
    settings, app = app_with(tmp_path, secrets)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        connected(client, secrets)
        keep_snapshot(settings, legacy=True)  # a connection made before the old row could be dropped
        c = connect(settings.data_dir / DB_NAME)
        try:
            assert central.legacy(c)
        finally:
            c.close()
        assert client.post("/central/refresh", headers=HEADERS).status_code == 200
        c = connect(settings.data_dir / DB_NAME)
        try:
            assert not central.legacy(c), "leído por la API, la fila antigua sobra"
        finally:
            c.close()
