"""The «Presupuestos» module: Central's quotes and rates read live with a key that has the `presupuestos` permission
(also with the «Central» module off), each field copied on purpose, closed parameters, documents downloaded with
their type and size checked into a folder of the data under a clean name, drafts checked against Central's schema
and created once per form, and everything answering 404 with the module off without asking Central anything.
Central is a stand-in with the real shape of its API v1 (`src/lib/api/quotes.ts`, `src/app/api/v1/presupuestos`)."""

import json
import logging
import os
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from agora_core import central_api, central_quotes, engines
from test_assistant import MemorySecrets
from test_central_api import HEADERS, KEY, URL, app_with

Q1, Q2, Q3 = "q" + "1" * 24, "q" + "2" * 24, "q" + "3" * 24
C1 = "c" + "1" * 24
NOW = "2026-11-18T10:00:00.000Z"
QUOTES = [
    {"id": Q1, "number": "P-2026-007", "title": "Web corporativa", "client": "Cliente Uno", "status": "DRAFT", "issuedAt": NOW, "validUntil": NOW, "total": 2178},
    {"id": Q2, "number": "P-2026-006", "title": "Tienda", "client": "Cliente Uno García", "status": "SENT", "issuedAt": NOW, "validUntil": NOW, "total": 1210,
     "totalMax": 2420},
    {"id": Q3, "number": "../../etc/passwd", "title": "Raro", "client": "Cliente Dos", "status": "ACCEPTED", "issuedAt": NOW, "validUntil": None, "total": 100},
]
RECORD = {
    "id": Q1, "number": "P-2026-007", "title": "Web corporativa", "status": "DRAFT", "client": {"id": C1, "name": "Cliente Uno"}, "project": None,
    "issuedAt": NOW, "validUntil": NOW, "vat": 21, "notes": "Copia en /Users/ana/presupuestos y servidor 203.0.113.7",
    "scope": "Diseño y desarrollo", "includes": ["Hosting un año"], "excludes": ["Textos"], "assumptions": [], "thirdPartyCosts": None,
    "schedule": [{"when": "Semana 1", "what": "Diseño"}],
    "items": [{"description": "Diseño", "details": None, "quantity": 1, "unit": "proyecto", "unitPrice": 900, "priceMax": None},
              {"description": "Desarrollo", "details": "Next.js", "quantity": 1, "unit": None, "unitPrice": 900, "priceMax": 1800}],
    "base": 1800, "tax": 378, "total": 2178, "baseMax": 2700, "totalMax": 3267,
    "phases": [{"name": "Inicio", "percent": 50, "amount": 1089, "dueDate": None, "status": "PENDING", "completedAt": None},
               {"name": "Entrega", "percent": 50, "amount": 1089, "dueDate": NOW, "status": "TELEPORTED", "completedAt": None}],
    "internal": "no debe salir",
}
RATES = [{"id": "r" + "1" * 24, "name": "Web Next.js básica", "unit": "proyecto", "price": 1500}, {"id": "otro/../x", "name": "Hora", "unit": "hora", "price": 50}]
PDF = b"%PDF-1.7\n" + b"0" * 100
DOCX = b"PK\x03\x04" + b"0" * 100
DRAFT = {"client": "Cliente Uno", "title": "Web nueva", "items": [{"description": "Diseño", "unitPrice": 900, "quantity": 1}],
         "phases": [{"name": "Inicio", "percent": 50}], "validDays": 30}


class FakeCentral:
    """Answers like Central's API v1 for the key `KEY` with the given scopes."""

    def __init__(self, scopes=("presupuestos",)):
        self.scopes, self.seen, self.created = list(scopes), [], []
        self.documents = {"pdf": (PDF, "application/pdf"), "docx": (DOCX, central_quotes.DOCUMENTS["docx"])}
        self.record = RECORD

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        if request.headers.get("authorization") != f"Bearer {KEY}":
            return httpx.Response(401, json={"error": "unauthorized"})
        path = request.url.path
        need = None if path == "/api/v1/estado" else "presupuestos" if path.startswith(("/api/v1/presupuestos", "/api/v1/tarifas")) else "lectura"
        if need and need not in self.scopes:
            return httpx.Response(403, json={"error": "forbidden", "scope": need})
        if path == "/api/v1/estado":
            return httpx.Response(200, json={"version": "0.5.0", "api": "v1", "scopes": self.scopes, "runtime": "production"})
        if path == "/api/v1/presupuestos" and request.method == "GET":
            client, status = request.url.params.get("cliente"), request.url.params.get("estado")
            found = [q for q in QUOTES if (not client or client.lower() in q["client"].lower()) and (not status or q["status"] == status)]
            return httpx.Response(200, json={"quotes": found})
        if path == "/api/v1/presupuestos" and request.method == "POST":
            body = json.loads(request.content)
            if body["client"] not in ("Cliente Uno", C1):
                return httpx.Response(422, json={"error": "invalid", "detail": "No existe ese cliente en Central"})
            self.created.append(body)
            return httpx.Response(201, json={"id": Q1, "number": "P-2026-007", "status": "DRAFT"})
        if path == "/api/v1/tarifas":
            return httpx.Response(200, json={"rates": RATES})
        for q in QUOTES:
            if path == f"/api/v1/presupuestos/{q['id']}":
                return httpx.Response(200, json={**self.record, "id": q["id"], "number": q["number"]})
            for kind, (content, mime) in self.documents.items():
                if path == f"/api/v1/presupuestos/{q['id']}/{kind}":
                    return httpx.Response(200, content=content, headers={"content-type": mime})
        return httpx.Response(404, json={"error": "not_found"})


@pytest.fixture
def fake(monkeypatch):
    found = FakeCentral()
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(found))
    return found


@pytest.fixture
def opened(monkeypatch):
    seen = []
    monkeypatch.setattr(central_quotes, "OPEN", seen.append)
    return seen


@pytest.fixture
def setup(tmp_path, fake, opened):
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as test_client:
        assert test_client.put("/connectors/central", json={"url": URL, "key": KEY}, headers=HEADERS).status_code == 200
        # Only the «presupuestos» permission and the «Central» module off: Presupuestos works on its own.
        assert test_client.put("/modules", json={"modules": {"central": False, "presupuestos": True}}, headers=HEADERS).status_code == 200
        yield test_client, settings


@pytest.fixture
def client(setup):
    return setup[0]


def paths(fake: FakeCentral) -> list[str]:
    return [r.url.path for r in fake.seen if r.url.path != "/api/v1/estado"]


def draft(token="t" * 20, **change):
    return {"token": token, "quote": {**DRAFT, **change}}


def test_lista_con_solo_el_permiso_presupuestos_y_central_apagado(client, fake):
    quotes = client.get("/quotes", headers=HEADERS).json()["quotes"]
    assert [q["number"] for q in quotes] == ["P-2026-007", "P-2026-006", "../../etc/passwd"]
    assert quotes[0] == {"id": Q1, "number": "P-2026-007", "title": "Web corporativa", "client": "Cliente Uno", "status": "DRAFT", "issuedAt": NOW,
                         "validUntil": NOW, "total": 2178, "totalMax": None}
    assert quotes[1]["totalMax"] == 2420


def test_filtro_de_cliente_exacto_y_de_estado(client, fake):
    quotes = client.get("/quotes?cliente=Cliente%20Uno&estado=DRAFT", headers=HEADERS).json()["quotes"]
    assert [q["id"] for q in quotes] == [Q1], "«Cliente Uno García» no entra aunque Central filtre por «contiene»"
    assert dict(fake.seen[-1].url.params) == {"cliente": "Cliente Uno", "estado": "DRAFT"}


@pytest.mark.parametrize("query", ["estado=BORRADO", "estado=draft", "x=1", "cliente=", "cliente=" + "a" * 201, "cliente=a%0Ab", "ruta=/api/v1/secretos"])
def test_parametros_cerrados(client, fake, query):
    assert client.get(f"/quotes?{query}", headers=HEADERS).status_code == 422
    assert paths(fake) == []


def test_ficha_campo_a_campo_y_sin_rutas_ni_ips(client):
    record = client.get(f"/quotes/{Q1}", headers=HEADERS).json()
    assert record["client"] == {"id": C1, "name": "Cliente Uno"} and record["project"] is None
    assert [i["description"] for i in record["items"]] == ["Diseño", "Desarrollo"] and record["items"][1]["priceMax"] == 1800
    assert [(p["name"], p["amount"], p["status"]) for p in record["phases"]] == [("Inicio", 1089, "PENDING"), ("Entrega", 1089, None)]
    assert (record["base"], record["tax"], record["total"], record["baseMax"], record["totalMax"], record["vat"]) == (1800, 378, 2178, 2700, 3267, 21)
    assert "internal" not in record and "/Users/ana" not in record["notes"] and "203.0.113.7" not in record["notes"]
    assert record["schedule"] == [{"when": "Semana 1", "what": "Diseño"}]


def test_tarifas(client):
    rates = client.get("/quotes/rates", headers=HEADERS).json()["rates"]
    assert rates == [{"id": "r" + "1" * 24, "name": "Web Next.js básica", "unit": "proyecto", "price": 1500}, {"id": None, "name": "Hora", "unit": "hora", "price": 50}]


@pytest.mark.parametrize("item", ["a/b", "..", "%2E%2E", "P-2026-007", "Q" + "1" * 24, Q1 + "%2F..%2Fpdf", "corto"])
def test_identificador_con_forma_de_cuid(client, fake, item):
    assert client.get(f"/quotes/{item}", headers=HEADERS).status_code in (404, 422)
    assert client.post(f"/quotes/{item}/open?format=pdf", headers=HEADERS).status_code in (404, 405, 422)
    assert paths(fake) == []


@pytest.mark.parametrize("query", ["", "format=exe", "format=PDF", "format=pdf&x=1", "format=../pdf", "formato=pdf"])
def test_formato_del_documento(client, fake, opened, query):
    assert client.post(f"/quotes/{Q1}/open?{query}", headers=HEADERS).status_code == 422
    assert paths(fake) == [] and opened == []


def test_abre_el_pdf_y_el_word_con_nombre_limpio(setup, fake, opened):
    client, settings = setup
    for kind, content in (("pdf", PDF), ("docx", DOCX)):
        done = client.post(f"/quotes/{Q1}/open?format={kind}", headers=HEADERS)
        assert done.status_code == 200 and done.json() == {"opened": f"P-2026-007.{kind}", "format": kind}
        assert opened[-1] == settings.data_dir / "central-documentos" / f"P-2026-007.{kind}"
        assert opened[-1].read_bytes() == content
    assert URL not in done.text and KEY not in done.text


def test_el_nombre_del_fichero_no_sale_del_numero_sin_limpiar(setup, opened):
    client, settings = setup
    assert client.post(f"/quotes/{Q3}/open?format=pdf", headers=HEADERS).json()["opened"] == "etcpasswd.pdf"
    assert opened[-1].parent == settings.data_dir / "central-documentos"
    for number, expected in (("../..", f"presupuesto-{Q1[:12]}"), ("P/2026\\001", "P2026001"), (None, f"presupuesto-{Q1[:12]}"), ("..", f"presupuesto-{Q1[:12]}")):
        assert central_quotes.file_name(number, Q1) == expected
        assert "/" not in expected and ".." not in expected


def test_documento_de_otro_tipo_o_demasiado_grande(client, fake, opened, monkeypatch):
    fake.documents["pdf"] = (b"<html>hola</html>", "text/html")
    refused = client.post(f"/quotes/{Q1}/open?format=pdf", headers=HEADERS)
    assert refused.status_code == 502 and "otro tipo" in refused.json()["error"]
    fake.documents["pdf"] = (b"MZ ejecutable", "application/pdf")
    assert "no es un PDF" in client.post(f"/quotes/{Q1}/open?format=pdf", headers=HEADERS).json()["error"]
    assert central_quotes.MAX_DOCUMENT == 20 * 1024 * 1024
    monkeypatch.setattr(central_quotes, "MAX_DOCUMENT", 50)
    fake.documents["pdf"] = (PDF, "application/pdf")
    too_big = client.post(f"/quotes/{Q1}/open?format=pdf", headers=HEADERS)
    assert too_big.status_code == 502 and "demasiado grande" in too_big.json()["error"]
    assert opened == []


def test_si_no_se_puede_abrir_no_es_500(client, monkeypatch):
    def broken(path):
        raise OSError("sin programa")
    monkeypatch.setattr(central_quotes, "OPEN", broken)
    answer = client.post(f"/quotes/{Q1}/open?format=pdf", headers=HEADERS)
    assert answer.status_code == 503 and "no se pudo abrir" in answer.json()["error"]


def test_los_documentos_de_mas_de_un_dia_se_borran_al_arrancar(tmp_path):
    folder = tmp_path / "central-documentos"
    folder.mkdir()
    old, new, half = folder / "P-2026-001.pdf", folder / "P-2026-002.pdf", folder / ".descarga-abc"
    for path in (old, new, half):
        path.write_bytes(PDF)
    os.utime(old, (time.time() - 2 * 86400, time.time() - 2 * 86400))
    central_quotes.clean_documents(tmp_path)
    assert sorted(p.name for p in folder.iterdir()) == ["P-2026-002.pdf"]


def test_borrador_tal_cual_y_una_sola_vez_por_formulario(client, fake):
    made = client.post("/quotes", json=draft(), headers=HEADERS)
    assert made.status_code == 201 and made.json()["created"] == {"id": Q1, "number": "P-2026-007", "client": "Cliente Uno"}
    assert fake.created == [DRAFT], "lo que se confirmó, sin añadir ni cambiar nada"
    assert not any(k in fake.created[0] for k in ("status", "send")), "Central lo crea siempre en borrador"
    again = client.post("/quotes", json=draft(), headers=HEADERS)
    assert again.status_code == 200 and again.json()["repeated"] is True and len(fake.created) == 1, "el mismo token no crea otro"
    assert client.post("/quotes", json=draft(token="u" * 20), headers=HEADERS).status_code == 201 and len(fake.created) == 2


def test_un_rechazo_de_central_libera_el_token(client, fake):
    refused = client.post("/quotes", json=draft(client="Nadie"), headers=HEADERS)
    assert refused.status_code == 422 and "No existe ese cliente" in refused.json()["error"]
    assert client.post("/quotes", json=draft(), headers=HEADERS).status_code == 201, "nada se creó: se puede corregir y enviar"


def test_si_no_se_sabe_si_se_creo_no_se_repite(client, fake, monkeypatch):
    def down(request):
        raise httpx.ReadTimeout("lento", request=request)
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(down))
    assert client.post("/quotes", json=draft(), headers=HEADERS).status_code == 502
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(fake))
    again = client.post("/quotes", json=draft(), headers=HEADERS)
    assert again.status_code == 409 and "vuelve a leer la lista" in again.json()["error"] and fake.created == []


@pytest.mark.parametrize("change", [{"items": []}, {"title": ""}, {"title": "   "}, {"items": [{"description": "x", "unitPrice": -1}]},
                                    {"items": [{"description": "x", "unitPrice": 100, "priceMax": 50}]}, {"items": [{"description": "x", "unitPrice": 1e9}]},
                                    {"items": [{"description": "x", "unitPrice": "100"}]}, {"items": [{"description": "x", "unitPrice": True}]},
                                    {"vat": 120}, {"validDays": 0}, {"status": "SENT"}, {"phases": [{"name": "x", "dueDate": "2026-02-31"}]},
                                    {"phases": [{"name": "x", "dueDate": "9999-12-31"}]}, {"includes": ["x" * 1001]}, {"client": ""}])
def test_borradores_no_validos_no_llegan_a_central(client, fake, change):
    refused = client.post("/quotes", json=draft(**change), headers=HEADERS)
    assert refused.status_code == 422 and fake.created == []


@pytest.mark.parametrize("body", [{"quote": DRAFT}, {"token": "corto", "quote": DRAFT}, {"token": "t" * 20 + "/", "quote": DRAFT},
                                  {"token": "t" * 20, "quote": DRAFT, "enviar": True}, [1, 2]])
def test_sin_token_valido_no_se_crea(client, fake, body):
    assert client.post("/quotes", json=body, headers=HEADERS).status_code == 422 and fake.created == []


def test_un_cliente_solo_propio_no_se_puede_usar(client, fake, monkeypatch):
    from agora_core import central
    monkeypatch.setattr(central, "snapshot", lambda connection: {"clients": [{"name": "Cliente Uno"}]})
    assert client.post("/clients", json={"name": "Solo Mío", "company": None, "email": None, "phone": None, "taxId": None, "domains": [], "notes": None},
                       headers=HEADERS).status_code == 201
    refused = client.post("/quotes", json=draft(client="Solo Mío"), headers=HEADERS)
    assert refused.status_code == 422 and refused.json()["status"] == "not_in_central" and fake.created == []
    assert client.post("/quotes", json=draft(client="Cliente Uno"), headers=HEADERS).status_code == 201


def test_clave_sin_permiso_presupuestos(client, fake):
    fake.scopes = ["lectura"]
    for answer in (client.get("/quotes", headers=HEADERS), client.get("/quotes/rates", headers=HEADERS), client.post("/quotes", json=draft(), headers=HEADERS)):
        assert answer.status_code == 403 and answer.json()["status"] == "forbidden"
        assert "permiso «presupuestos»" in answer.json()["error"] and "Conectores › Central" in answer.json()["error"]
    assert fake.created == []


def test_sin_conexion_pide_conectar(client, fake):
    client.delete("/connectors/central", headers=HEADERS)
    answer = client.get("/quotes", headers=HEADERS)
    assert answer.status_code == 409 and answer.json()["status"] == "not_connected" and paths(fake) == []


def test_modulo_apagado_404_en_todo_y_watson_sin_la_herramienta(client, fake, opened):
    assert client.put("/modules", json={"modules": {"presupuestos": False}}, headers=HEADERS).status_code == 200
    for answer in (client.get("/quotes", headers=HEADERS), client.get("/quotes?estado=BORRADO", headers=HEADERS), client.get("/quotes/rates", headers=HEADERS),
                   client.get(f"/quotes/{Q1}", headers=HEADERS), client.post(f"/quotes/{Q1}/open?format=pdf", headers=HEADERS),
                   client.post(f"/quotes/{Q1}/open?format=exe", headers=HEADERS), client.post("/quotes", json=draft(), headers=HEADERS),
                   client.post("/quotes", json={"basura": 1}, headers=HEADERS)):
        assert answer.status_code == 404 and answer.json()["status"] == "off"
    assert paths(fake) == [] and opened == [] and fake.created == []
    assert "proponer_presupuesto" in engines.HIDDEN_TOOLS and "proponer_presupuesto" not in [s["name"] for s in engines._specs()]


def test_un_fallo_de_central_es_502_sin_clave_ni_direccion(client, fake, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)

    def broken(request):
        return httpx.Response(500, json={"error": "internal", "detail": f"falló con {KEY} en {URL}"})
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(broken))
    for answer in (client.get("/quotes", headers=HEADERS), client.get(f"/quotes/{Q1}", headers=HEADERS), client.post(f"/quotes/{Q1}/open?format=pdf", headers=HEADERS)):
        assert answer.status_code == 502 and KEY not in answer.text and URL not in answer.text
    assert KEY not in caplog.text


def test_sin_cabecera_de_acceso_no_hay_presupuestos(client):
    assert client.get("/quotes").status_code in (401, 403)



def test_dos_envios_a_la_vez_con_el_mismo_token_crean_un_solo_borrador(client, fake, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    from agora_core import central

    def slow(connection):  # a wait between the check of the token and Central: both sends are inside it at once
        time.sleep(0.3)
        return {"clients": [{"name": "Cliente Uno"}]}
    monkeypatch.setattr(central, "snapshot", slow)
    with ThreadPoolExecutor(max_workers=2) as pool:
        answers = list(pool.map(lambda _: client.post("/quotes", json=draft(), headers=HEADERS), range(2)))
    assert sorted(a.status_code for a in answers) == [201, 409] and len(fake.created) == 1


def test_el_mismo_token_con_otro_contenido_es_otro_borrador(client, fake):
    assert client.post("/quotes", json=draft(), headers=HEADERS).status_code == 201
    changed = client.post("/quotes", json=draft(title="Web nueva y tienda"), headers=HEADERS)
    assert changed.status_code == 201 and "repeated" not in changed.json() and len(fake.created) == 2
    assert client.post("/quotes", json=draft(title="Web nueva y tienda"), headers=HEADERS).json()["repeated"] is True and len(fake.created) == 2


def test_solo_van_los_campos_que_vinieron(client, fake):
    sparse = {"client": "Cliente Uno", "title": "Mínimo", "items": [{"description": "Diseño", "unitPrice": 900}]}
    assert client.post("/quotes", json={"token": "m" * 20, "quote": sparse}, headers=HEADERS).status_code == 201
    assert fake.created[-1] == sparse, "sin quantity ni validDays añadidos: Central pone los suyos"


def test_esquema_completo_de_central_y_longitudes_como_zod(client, fake):
    full = draft(thirdPartyCosts="Dominio aparte", schedule=[{"when": "Semana 1", "what": "Diseño"}])
    assert client.post("/quotes", json=full, headers=HEADERS).status_code == 201
    assert fake.created[-1]["schedule"] == [{"when": "Semana 1", "what": "Diseño"}]
    assert client.post("/quotes", json=draft(token="e" * 20, title="😀" * 101), headers=HEADERS).status_code == 422, "202 unidades UTF-16"
    assert client.post("/quotes", json=draft(token="e" * 20, title="😀" * 100), headers=HEADERS).status_code == 201


def test_un_cuerpo_demasiado_grande_no_se_lee(client, fake):
    huge = json.dumps(draft(notes="x" * 300_000))
    answer = client.post("/quotes", content=huge, headers={**HEADERS, "content-type": "application/json"})
    assert answer.status_code == 422 and fake.created == []


def test_si_falla_el_registro_el_borrador_creado_es_un_exito(client, fake, monkeypatch):
    import sqlite3

    from agora_core import routes_quotes

    def broken(connection):
        raise sqlite3.OperationalError("disco lleno")
    monkeypatch.setattr(routes_quotes, "transaction", broken)
    answer = client.post("/quotes", json=draft(), headers=HEADERS)
    assert answer.status_code == 201 and answer.json()["created"]["number"] == "P-2026-007" and "registro" in answer.json()["warning"]


def test_nan_o_infinito_de_central_nunca_da_500(setup, fake, monkeypatch):
    client = setup[0]
    from agora_core import central_views

    assert central_views._number(float("nan")) is None and central_views._number(float("inf")) is None and central_views._number(2.5) == 2.5
    texts = {"/api/v1/tarifas": '{"rates": [{"id": "r%s", "name": "x", "unit": "h", "price": NaN}]}' % ("1" * 24),
             "/api/v1/presupuestos": '{"quotes": [{"id": "%s", "total": Infinity}]}' % Q1,
             f"/api/v1/presupuestos/{Q1}": '{"id": "%s", "total": -Infinity}' % Q1,
             "/api/v1/clientes": '{"clients": [{"id": "c%s", "name": "x", "projects": NaN}]}' % ("1" * 24)}

    def odd(request):
        return httpx.Response(200, content=texts[request.url.path].encode(), headers={"content-type": "application/json"})
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(odd))
    for path in ("/quotes/rates", "/quotes", f"/quotes/{Q1}"):
        assert client.get(path, headers=HEADERS).status_code == 502, path
    client.put("/modules", json={"modules": {"central": True}}, headers=HEADERS)
    assert client.get("/central/views/clientes", headers=HEADERS).status_code == 502


def test_dos_confirmaciones_a_la_vez_de_watson_crean_un_solo_borrador(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    from agora_core import modules
    from test_central_api import FakeCentral as WatsonCentral, QuoteEngine, propose

    found = WatsonCentral()
    monkeypatch.setattr(central_api, "TRANSPORT", httpx.MockTransport(found))
    settings, app = app_with(tmp_path, MemorySecrets(), QuoteEngine())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        client.put("/connectors/central", json={"url": URL, "key": KEY}, headers=HEADERS)
        proposal = propose(client)
        state = modules.state

        def slow(connection):
            time.sleep(0.3)
            return state(connection)
        monkeypatch.setattr(modules, "state", slow)
        with ThreadPoolExecutor(max_workers=2) as pool:
            answers = list(pool.map(lambda _: client.post(f"/assistant/proposals/{proposal['id']}/quote", headers=HEADERS), range(2)))
        assert sorted(a.status_code for a in answers) == [201, 404] and len(found.created) == 1


def test_word_abierto_en_otro_programa_y_nombres_reservados(tmp_path, monkeypatch):
    assert central_quotes.file_name("CON", Q1) == f"presupuesto-{Q1[:12]}" and central_quotes.file_name("com1", Q1) == f"presupuesto-{Q1[:12]}"
    folder = tmp_path / "docs"
    assert central_quotes._keep(folder, "P-2026-007", "docx", DOCX) == "P-2026-007.docx"
    assert central_quotes._keep(folder, "P-2026-007", "docx", DOCX) == "P-2026-007.docx", "mismo contenido: se reutiliza"
    real = os.replace

    def locked(source, dest):
        if str(dest).endswith("P-2026-007.docx"):
            raise PermissionError("abierto en Word")
        return real(source, dest)
    monkeypatch.setattr(os, "replace", locked)
    assert central_quotes._keep(folder, "P-2026-007", "docx", DOCX + b"nuevo") == "P-2026-007-2.docx"
    assert not [p for p in folder.iterdir() if p.name.startswith(".descarga-")]


def test_apertura_compartida_con_fiscal():
    from pathlib import Path

    from agora_core import system_open

    path = Path("/datos/central-documentos/P-2026-007.pdf")
    assert system_open.command_for(path, platform="darwin") == ["/usr/bin/open", "--", str(path)]
    assert system_open.command_for(path, platform="win32") == ["explorer", str(path)]
    assert system_open.command_for(path, platform="linux") == ["xdg-open", str(path)]
    assert system_open.command_for(path, reveal=True, platform="linux") == ["xdg-open", str(path.parent)]
    assert central_quotes.OPEN is system_open.open_path
