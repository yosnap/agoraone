"""The directory with three sources (Central, CRMDev and the clients kept in AgoraOne), used at once without
duplicates; the clients kept only here are «sin ubicar» while a CRM is connected and can be created in CRMDev (after
seeing the exact change) and linked; the vault's client cards without a client are found by name only. CRMDev is the
stand-in of test_crmdev_write, Central a snapshot read with a fake fetch, and the vault is the brain's index filled
with temporary notes (the core never reads the vault itself)."""

import asyncio
import json
import threading

import pytest
from fastapi.testclient import TestClient

from agora_core import central, client_cards, clients, crmdev_api, crmdev_sync, db as db_module, modules
from agora_core.brain_tools import Toolbox
from agora_core.db import DB_NAME, connect, migrate
from agora_core.embed import VectorCache
from agora_core.index import Note, upsert_notes
from test_assistant import MemorySecrets
from test_central_api import HEADERS, app_with
from test_crmdev_api import DELETES, KEY, URL
from test_crmdev_write import StatefulCrmdev, empty_cache, fake  # noqa: F401 - pytest fixtures

CENTRAL = {
    "clients": [{"id": "c1", "name": "Cliente Uno"}, {"id": "c2", "name": "Bravo"}],
    "projects": [{"id": "p1", "name": "Tienda", "status": "ACTIVE", "client": "Cliente Uno"}],
    "websites": [], "servers": [],
    "details": {"Cliente Uno": {"email": "hola@uno.example", "phone": "+34 600 111 222", "taxId": "B12345678"}},
}
VAULT = "vault-" + "a" * 24


def ref(n: int) -> str:
    return f"note-{n:024x}"


@pytest.fixture
def setup(tmp_path, fake):  # noqa: F811
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        assert client.put("/connectors/crmdev", json={"url": URL, "key": KEY}, headers=HEADERS).status_code == 200
        yield client, settings


def database(settings):
    return connect(settings.data_dir / DB_NAME)


def read_crmdev(client) -> dict:
    answer = client.post("/crmdev/clients/refresh", headers=HEADERS)
    assert answer.status_code == 200, answer.text
    return answer.json()


def with_central(settings, raw=CENTRAL) -> None:
    connection = database(settings)
    try:
        central.refresh(connection, None, fetch=lambda origin: raw)
    finally:
        connection.close()


def directory(client, **params) -> dict:
    answer = client.get("/clients", params=params, headers=HEADERS)
    assert answer.status_code == 200
    return answer.json()


def build(settings):
    connection = database(settings)
    try:
        return clients.build(connection)
    finally:
        connection.close()


def set_modules(settings, **changes) -> None:
    connection = database(settings)
    try:
        modules.save(connection, changes)
    finally:
        connection.close()


def add_crmdev_client(fake, **row) -> None:  # noqa: F811
    fake.rows["list_clients"].insert(0, row)


def test_un_mismo_cliente_en_central_y_crmdev_se_ve_una_vez(setup, fake):  # noqa: F811
    client, settings = setup
    with_central(settings)
    read_crmdev(client)
    entries, _ = build(settings)
    uno = [e for e in entries if clients.same_name(e["name"]) == "cliente uno"]
    assert len(uno) == 1, "mismo nombre: una sola entrada"
    entry = uno[0]
    assert entry["sources"] == ["central", "crmdev"] and entry["source"] == "central" and entry["crmdevId"] == "c1" and entry["centralId"] == "c1"
    assert entry["email"] == "hola@uno.example" and entry["phone"] == "+34 600 111 222", "Central manda en el contacto"
    assert entry["company"] == "Uno SL", "CRMDev rellena lo que Central tiene vacío"
    assert entry["crmdevStatus"] == "CUSTOMER" and entry["projects"][0]["name"] == "Tienda"
    assert {"field": "email", "label": "Correo", "crmdev": "info@cliente.example"} in entry["differences"]
    listed = next(c for c in directory(client)["clients"] if c["crmdevId"] == "c1")
    assert {"field": "email", "label": "Correo"} in listed["differences"], "en la lista solo se dice que es distinto"
    assert "info@cliente.example" not in json.dumps(directory(client)) and "+34 600" not in json.dumps(directory(client))


def test_las_dos_fuentes_a_la_vez_y_apagar_una_no_toca_la_otra(setup, fake):  # noqa: F811
    client, settings = setup
    add_crmdev_client(fake, id="r9", name="Solo CRM", email="ana@solocrm.example", company=None, status="LEAD")
    with_central(settings)
    read_crmdev(client)
    names = {c["name"] for c in directory(client)["clients"]}
    assert {"Cliente Uno", "Bravo", "Solo CRM"} <= names
    set_modules(settings, crmdev=False)
    state = directory(client)
    assert "Solo CRM" not in {c["name"] for c in state["clients"]} and "Bravo" in {c["name"] for c in state["clients"]}
    assert state["crmdev"]["on"] is False and all(c["crmdevId"] is None for c in state["clients"])
    connection = database(settings)
    try:
        assert central.client_for(connection, "ana@solocrm.example") is None, "apagado: el correo no lo reconoce"
        assert crmdev_sync.stored(connection) is not None, "la instantánea se conserva"
    finally:
        connection.close()
    set_modules(settings, crmdev=True, central=False)
    names = {c["name"] for c in directory(client)["clients"]}
    assert "Solo CRM" in names and "Bravo" not in names


def test_correo_de_un_cliente_solo_de_crmdev_se_reconoce_y_gmail_no(setup, fake):  # noqa: F811
    client, settings = setup
    add_crmdev_client(fake, id="r9", name="Solo CRM", email="ana@solocrm.example", company=None, status="LEAD")
    add_crmdev_client(fake, id="r8", name="Persona Gmail", email="persona@gmail.com", company=None, status="LEAD")
    read_crmdev(client)
    connection = database(settings)
    try:
        assert central.client_for(connection, "luis@solocrm.example")["name"] == "Solo CRM", "por el dominio de su correo"
        assert central.client_for(connection, "otra@gmail.com") is None, "un correo gratuito nunca casa por dominio"
        assert crmdev_sync.stored(connection)["clients"][0]["domains"] == [] or all(
            "gmail.com" not in c["domains"] for c in crmdev_sync.stored(connection)["clients"])
    finally:
        connection.close()


def test_correo_exacto_unico_se_enlaza_solo_y_repetido_no(setup, fake):  # noqa: F811
    client, settings = setup
    add_crmdev_client(fake, id="r1", name="Bravo Estudio", email="hola@bravo.example", company=None, status="LEAD")
    with_central(settings, {**CENTRAL, "details": {**CENTRAL["details"], "Bravo": {"email": "hola@bravo.example"}}})
    read_crmdev(client)
    bravo = [e for e in build(settings)[0] if e["centralId"] == "c2"]
    assert bravo[0]["crmdevId"] == "r1" and bravo[0]["aliases"] == ["Bravo Estudio"]
    add_crmdev_client(fake, id="r2", name="Bravo Otro", email="hola@bravo.example", company=None, status="LEAD")
    read_crmdev(client)
    entries, _ = build(settings)
    assert next(e for e in entries if e["centralId"] == "c2")["crmdevId"] is None, "dos de CRMDev con ese correo: no se adivina"


def test_sin_ubicar_y_crear_en_crmdev_enlaza_sin_borrar_nada(setup, fake):  # noqa: F811
    client, settings = setup
    own = client.post("/clients", json={"name": "Nuevo Local", "email": "yo@nuevo.example", "phone": "+34 611 000 000", "taxId": "B22222222"},
                      headers=HEADERS).json()
    assert directory(client)["unplacedCount"] == 1, "conectado, aunque aún no se haya leído: cuenta"
    read_crmdev(client)
    state = directory(client)
    assert state["unplacedCount"] == 1 and next(c for c in state["clients"] if c["localId"] == own["localId"])["unplaced"] is True
    preview = client.post("/crmdev/write/preview", json={"kind": "cliente-desde-local", "localId": own["localId"], "status": "PROSPECT"}, headers=HEADERS)
    assert preview.status_code == 200, preview.text
    rows = {r["field"]: r["after"] for r in preview.json()["rows"]}
    assert rows == {"name": "Nuevo Local", "email": "yo@nuevo.example", "phone": "+34 611 000 000", "status": "Posible cliente"}
    assert "B22222222" not in preview.text, "el NIF no va a CRMDev"
    done = client.post("/crmdev/write/confirm", json={"token": preview.json()["token"]}, headers=HEADERS)
    assert done.status_code == 200 and "warning" not in done.json(), done.text
    writes = fake.writes()
    assert [w["tool"] for w in writes] == ["create_client"] and not any(t.startswith("delete_") for t in fake.tools())
    assert writes[0]["arguments"] == {"name": "Nuevo Local", "email": "yo@nuevo.example", "phone": "+34 611 000 000", "status": "PROSPECT"}
    state = directory(client)
    entry = next(c for c in state["clients"] if c["localId"] == own["localId"])
    assert state["unplacedCount"] == 0 and entry["sources"] == ["crmdev", "local"] and entry["crmdevId"] == "n2", "enlazado y releído"
    assert client.get(f"/clients/{own['localId']}", headers=HEADERS).json()["links"][0]["state"] == "linked"
    again = client.post("/crmdev/write/preview", json={"kind": "cliente-desde-local", "localId": own["localId"]}, headers=HEADERS)
    assert again.status_code == 422 and "ya está en CRMDev" in again.json()["error"]


def test_crear_en_crmdev_con_duplicado_ofrece_enlazar_con_el_existente(setup, fake):  # noqa: F811
    client, settings = setup
    add_crmdev_client(fake, id="r5", name="Otro Nombre", email="dup@dup.example", company=None, status="LEAD")
    read_crmdev(client)
    own = client.post("/clients", json={"name": "Duplicado", "email": "dup@dup.example"}, headers=HEADERS).json()
    entries, suggestions = build(settings)
    assert next(e for e in entries if e["localId"] == own["localId"])["crmdevId"] == "r5", "correo exacto único: se enlaza solo"
    client.post(f"/clients/{own['localId']}/link", json={"connector": "crmdev", "remoteId": "r5", "state": "distinct"}, headers=HEADERS)
    answer = client.post("/crmdev/write/preview", json={"kind": "cliente-desde-local", "localId": own["localId"]}, headers=HEADERS)
    assert answer.status_code == 409 and answer.json()["status"] == "exists" and answer.json()["crmdevId"] == "r5"
    assert fake.writes() == []
    linked = client.post(f"/clients/{own['localId']}/link", json={"connector": "crmdev", "remoteId": "r5", "state": "linked"}, headers=HEADERS)
    assert linked.status_code == 200
    assert next(e for e in build(settings)[0] if e["localId"] == own["localId"])["crmdevId"] == "r5"


def test_son_distintos_con_crmdev_se_guarda_y_deshacerlo_vuelve_a_sugerir(setup, fake):  # noqa: F811
    client, settings = setup
    add_crmdev_client(fake, id="r3", name="Acmé", email=None, company=None, status="LEAD")
    with_central(settings, {**CENTRAL, "clients": [*CENTRAL["clients"], {"id": "c3", "name": "ACME!"}]})
    read_crmdev(client)
    own = client.post("/clients", json={"name": "Acme"}, headers=HEADERS).json()
    state = directory(client)
    assert {"localId": own["localId"], "localName": "Acme", "centralId": "c3", "centralName": "ACME!"} in state["suggestions"]
    assert {"centralId": "c3", "centralName": "ACME!", "crmdevId": "r3", "crmdevName": "Acmé"} in state["suggestions"]
    client.post(f"/clients/{own['localId']}/distinct", json={"centralId": "c3"}, headers=HEADERS)
    state = directory(client)
    assert {"localId": own["localId"], "localName": "Acme", "crmdevId": "r3", "crmdevName": "Acmé"} in state["suggestions"], "ahora con el de CRMDev"
    answer = client.post(f"/clients/{own['localId']}/link", json={"connector": "crmdev", "remoteId": "r3", "state": "distinct"}, headers=HEADERS)
    assert answer.status_code == 200 and answer.json()["links"] == [{"connector": "crmdev", "remoteId": "r3", "remoteName": "Acmé", "state": "distinct"}]
    assert not any(s.get("localId") == own["localId"] for s in directory(client)["suggestions"])
    connection = database(settings)
    try:
        assert connection.execute("SELECT state FROM client_link WHERE client_id = ?", (own["localId"],)).fetchone()["state"] == "distinct"
    finally:
        connection.close()
    client.post(f"/clients/{own['localId']}/link", json={"connector": "crmdev", "remoteId": "r3", "state": "undistinct"}, headers=HEADERS)
    assert any(s.get("crmdevId") == "r3" and s.get("localId") == own["localId"] for s in directory(client)["suggestions"])
    # Between the two CRMs, without a client kept here.
    assert client.post("/clients/pairs", json={"centralId": "c3", "crmdevId": "r3", "state": "distinct"}, headers=HEADERS).status_code == 200
    state = directory(client)
    assert not any(s.get("centralId") == "c3" and s.get("crmdevId") == "r3" for s in state["suggestions"])
    assert state["distinctPairs"] == [{"centralId": "c3", "centralName": "ACME!", "crmdevId": "r3", "crmdevName": "Acmé"}]
    assert client.post("/clients/pairs", json={"centralId": "c3", "crmdevId": "r3", "state": "linked"}, headers=HEADERS).status_code == 200
    assert next(e for e in build(settings)[0] if e["centralId"] == "c3")["crmdevId"] == "r3", "«Enlazar» entre CRMs"
    assert directory(client)["distinctPairs"] == []


def test_un_enlace_del_usuario_gana_y_es_transitivo(setup, fake):  # noqa: F811
    client, settings = setup
    add_crmdev_client(fake, id="r7", name="Zeta CRM", email=None, company=None, status="LEAD")
    with_central(settings)
    read_crmdev(client)
    own = client.post("/clients", json={"name": "Zeta Mío"}, headers=HEADERS).json()
    client.post(f"/clients/{own['localId']}/link", json={"centralId": "c2"}, headers=HEADERS)
    client.post(f"/clients/{own['localId']}/link", json={"connector": "crmdev", "remoteId": "r7"}, headers=HEADERS)
    found = [e for e in build(settings)[0] if own["localId"] == e["localId"]]
    assert len(found) == 1 and found[0]["sources"] == ["central", "crmdev", "local"] and found[0]["name"] == "Bravo"
    assert found[0]["aliases"] == ["Zeta CRM", "Zeta Mío"]
    other = client.post("/clients", json={"name": "Otro"}, headers=HEADERS).json()
    taken = client.post(f"/clients/{other['localId']}/link", json={"connector": "crmdev", "remoteId": "r7"}, headers=HEADERS)
    assert taken.status_code == 422 and "ya está enlazado" in taken.json()["error"]


def test_con_las_fuentes_apagadas_nadie_esta_sin_ubicar_y_los_enlaces_se_conservan(setup, fake):  # noqa: F811
    client, settings = setup
    read_crmdev(client)
    own = client.post("/clients", json={"name": "Suelto"}, headers=HEADERS).json()
    client.post(f"/clients/{own['localId']}/link", json={"connector": "crmdev", "remoteId": "c1"}, headers=HEADERS)
    lone = client.post("/clients", json={"name": "Solo Aquí"}, headers=HEADERS).json()
    assert directory(client)["unplacedCount"] == 1
    assert client.delete("/connectors/crmdev", headers=HEADERS).status_code == 200
    state = directory(client)
    assert state["crmdev"]["connected"] is False, "sin clave no se ofrece «Crear en CRMDev»; lo leído se conserva, como con Central"
    set_modules(settings, crmdev=False)
    state = directory(client)
    assert state["unplacedCount"] == 0 and not any(c["unplaced"] or c["crmdevId"] for c in state["clients"])
    connection = database(settings)
    try:
        assert connection.execute("SELECT count(*) FROM client_link").fetchone()[0] == 1, "desconectar no borra los enlaces"
        # «Crear en Central» linked it: it no longer counts while Central is a source.
        central.refresh(connection, None, fetch=lambda origin: CENTRAL)
        assert clients.link_created(connection, lone["localId"], "c9")
        unplaced = [e["name"] for e in clients.directory(connection) if e["unplaced"]]
        assert unplaced == ["Suelto"], "«Solo Aquí» enlazado con Central ya no cuenta; «Suelto» solo está en CRMDev, ahora apagado"
    finally:
        connection.close()


class CountingSecrets(MemorySecrets):
    """Counts how many times the store is asked for CRMDev's key."""

    def __init__(self):
        super().__init__()
        self.asked = 0

    def get(self, account):
        self.asked += account == crmdev_api.SECRET
        return super().get(account)


def test_el_directorio_no_abre_el_almacen_en_cada_lectura(tmp_path, fake):  # noqa: F811
    secrets = CountingSecrets()
    settings, app = app_with(tmp_path, secrets)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        assert client.put("/connectors/crmdev", json={"url": URL, "key": KEY}, headers=HEADERS).status_code == 200
        set_modules(settings, crmdev=True)
        asked = secrets.asked
        assert all(directory(client)["crmdev"]["connected"] for _ in range(3))
        assert secrets.asked - asked == 1, "se pregunta al almacén una vez y se recuerda"
        assert client.delete("/connectors/crmdev", headers=HEADERS).status_code == 200
        assert directory(client)["crmdev"]["connected"] is False, "olvidar la clave se nota en la siguiente lectura"
        assert client.put("/connectors/crmdev", json={"url": URL, "key": KEY}, headers=HEADERS).status_code == 200
        assert directory(client)["crmdev"]["connected"] is True, "guardarla otra vez también"
        asked = secrets.asked
        directory(client)
        assert secrets.asked == asked
        secrets.put(crmdev_api.SECRET, None)  # removed by hand from the store: still remembered
        assert directory(client)["crmdev"]["connected"] is True
        refused = client.put("/connectors/crmdev", json={"url": URL, "key": "no-vale"}, headers=HEADERS)
        assert refused.status_code == 422
        assert directory(client)["crmdev"]["connected"] is False, "un guardado, aunque falle, vuelve a preguntar al almacén"


def test_un_almacen_que_falla_no_se_recuerda():
    class Broken(MemorySecrets):
        def get(self, account):
            raise OSError("sin almacén")

    working = MemorySecrets()
    working.put(crmdev_api.SECRET, KEY)
    assert crmdev_api.has_key(Broken()) is False
    assert crmdev_api.has_key(working) is True, "el fallo anterior no queda recordado y otro almacén se pregunta"


def test_aislamiento_con_el_modulo_apagado(setup, fake):  # noqa: F811
    client, settings = setup
    read_crmdev(client)
    set_modules(settings, crmdev=False)
    seen = len(fake.seen)
    assert client.post("/crmdev/clients/refresh", headers=HEADERS).status_code == 404
    assert client.post("/crmdev/write/preview", json={"kind": "cliente-desde-local", "localId": 1}, headers=HEADERS).status_code == 404
    assert len(fake.seen) == seen
    ran = []
    stop = threading.Event()
    worker = threading.Thread(target=modules.gated, args=("crmdev", lambda: database(settings), lambda own: ran.append(own), stop))
    worker.start()
    stop.wait(0.3)
    stop.set()
    worker.join(5)
    assert ran == [], "con el módulo apagado no hay trabajador"


def test_sin_conexion_actualizar_dice_que_conectes(tmp_path, fake):  # noqa: F811
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        set_modules(settings, crmdev=True)
        answer = client.post("/crmdev/clients/refresh", headers=HEADERS)
        assert answer.status_code == 409 and answer.json()["status"] == "not_connected" and fake.seen == []


def test_instantanea_recortada_y_con_tope(setup, fake):  # noqa: F811
    client, settings = setup
    fake.rows["list_clients"] = [{"id": f"x{n}", "name": f"Cliente {n}", "email": f"c{n}@cli{n}.example", "company": "  Mucho   espacio ",
                                  "status": "RARO", "notes": "no se guarda"} for n in range(crmdev_api.SYNC_ROWS)]
    data = read_crmdev(client)
    assert data["truncated"] is True and data["count"] == crmdev_api.SYNC_ROWS
    assert fake.seen[-1]["arguments"] == {"limit": crmdev_api.SYNC_ROWS}
    connection = database(settings)
    try:
        kept = crmdev_sync.stored(connection)["clients"][0]
    finally:
        connection.close()
    assert set(kept) == {"id", "name", "company", "email", "status", "domains"} and kept["company"] == "Mucho espacio" and kept["status"] is None
    assert directory(client)["crmdev"]["truncated"] is True
    with pytest.raises(crmdev_api.WebApiError):
        crmdev_api.checked_arguments("list_projects", {"limit": crmdev_api.SYNC_ROWS})


def test_ningun_borrado_sale_al_sincronizar(setup, fake):  # noqa: F811
    client, _ = setup
    read_crmdev(client)
    assert all(not t.startswith("delete_") for t in fake.tools()) and set(DELETES).isdisjoint(crmdev_api.READ_TOOLS | crmdev_api.WRITE_TOOLS)


def test_fichas_del_vault_sin_cliente(setup, fake):  # noqa: F811
    client, settings = setup
    read_crmdev(client)
    connection = database(settings)
    try:
        # As the backend sends them: an opaque «note-<hash>» ref, the file name without «.md» as title, the folder.
        upsert_notes(connection, VAULT, "Vault", [
            Note(ref(1), "Cliente Uno", "Clientes", "r", "x", "Datos de contacto: nunca a un modelo"),
            Note(ref(2), "Sin Cliente", "Clientes", "r", "x", "Texto que no se lee"),
            Note(ref(3), "Notas", "clientes/Carpeta Propia", "r", "x", "hola"),
            Note(ref(4), "Más", "clientes/Carpeta Propia", "r", "x", "hola"),
            Note(ref(5), "Secreto", "Clientes", "r", "x", "---\nconfidencialidad: privado\n---\nnada"),
            Note(ref(6), "Nada", "Otros/Clientes", "r", "x", "fuera"),
            Note(ref(7), "Clientes", "", "r", "x", "una nota en la raíz que se llama Clientes"),
        ])
    finally:
        connection.close()
    cards = directory(client)["vaultCards"]
    assert [c["name"] for c in cards["cards"]] == ["Carpeta Propia", "Secreto", "Sin Cliente"] and cards["count"] == 3 and cards["hidden"] == 0
    assert next(c for c in cards["cards"] if c["name"] == "Carpeta Propia")["notes"] == 2
    discreet = directory(client, discreet="true")["vaultCards"]
    assert [c["name"] for c in discreet["cards"]] == ["Carpeta Propia", "Sin Cliente"] and discreet["hidden"] == 1
    assert "Texto que no se lee" not in json.dumps(directory(client)), "nunca el contenido"
    assert "note-" not in json.dumps(directory(client)), "nunca el identificador del índice"

    class Database:
        def __enter__(self):
            self.connection = database(settings)
            return self.connection

        def __exit__(self, *exc):
            self.connection.close()
    answer = json.loads(asyncio.run(Toolbox(Database, None, VectorCache()).call("consultar_clientes", {"cliente": ""})))
    assert answer["fichas_sin_cliente"] == ["Carpeta Propia", "Sin Cliente"] and answer["fichas_sin_cliente_reservadas"] == 1
    assert "Secreto" not in json.dumps(answer) and "info@cliente.example" not in json.dumps(answer)
    assert next(c for c in answer["clientes"] if c["nombre"] == "Cliente Uno")["crmdev"] == "CUSTOMER"
    # «Crear cliente manual» with the card's name: the card stops showing and is never touched.
    made = client.post("/clients", json={"name": "Sin Cliente"}, headers=HEADERS)
    assert made.status_code == 201
    state = directory(client)
    assert "Sin Cliente" not in [c["name"] for c in state["vaultCards"]["cards"]] and state["unplacedCount"] == 1
    connection = database(settings)
    try:
        assert connection.execute("SELECT count(*) FROM item WHERE class = 'note'").fetchone()[0] == 7
        assert client_cards.vault_cards(connection, [], True)["count"] == 4
    finally:
        connection.close()


def test_la_migracion_solo_anade(tmp_path, monkeypatch):
    real = db_module.available_migrations
    monkeypatch.setattr(db_module, "available_migrations", lambda: [m for m in real() if m[0] <= 33])
    connection = connect(tmp_path / DB_NAME)
    try:
        migrate(connection)
        connection.execute("INSERT INTO client (name, central_id, created_at, updated_at) VALUES ('Uno', 'c1', 'x', 'x')")
        connection.execute("INSERT INTO client_distinct (client_id, central_id, created_at) VALUES (1, 'c2', 'x')")
        connection.commit()
        before = [tuple(r) for r in connection.execute("SELECT * FROM client")], [tuple(r) for r in connection.execute("SELECT * FROM client_distinct")]
        monkeypatch.setattr(db_module, "available_migrations", real)
        assert 34 in migrate(connection)
        after = [tuple(r) for r in connection.execute("SELECT * FROM client")], [tuple(r) for r in connection.execute("SELECT * FROM client_distinct")]
        assert before == after
        connection.execute("INSERT INTO client_link (client_id, connector, remote_id, state, created_at) VALUES (1, 'crmdev', 'r1', 'linked', 'x')")
        with pytest.raises(Exception):
            connection.execute("INSERT INTO client_link (client_id, connector, remote_id, state, created_at) VALUES (1, 'crmdev', 'r2', 'linked', 'x')")
        connection.execute("DELETE FROM client WHERE id = 1")
        assert connection.execute("SELECT count(*) FROM client_link").fetchone()[0] == 0, "borrar el cliente se lleva sus enlaces"
    finally:
        connection.close()
