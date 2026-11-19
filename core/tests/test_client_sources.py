"""How the three sources of clients are joined: the order of the signals (user links, tax id, exact address, exact
name, CRMDev's company), a signal that points to several never guesses, the domains of Central and of the clients kept
here win in the mail, conflicting links are refused, a link to a client that disappeared is said, and joining stays
fast with a full CRMDev. Rows have the shapes `clients.build` passes."""

import threading
import time

import pytest
from fastapi.testclient import TestClient

from agora_core import central, client_sources, clients, crmdev_sync
from agora_core.client_sources import Links
from agora_core.db import DB_NAME, connect, transaction
from test_assistant import MemorySecrets
from test_central_api import HEADERS, app_with
from test_crmdev_api import KEY, URL
from test_crmdev_write import empty_cache, fake  # noqa: F401 - pytest fixtures


def c(id_, name, **over):
    return {"id": id_, "name": name, "company": None, "email": None, "phone": None, "taxId": None, "domains": [], "projects": [], "websites": [], **over}


def r(id_, name, **over):
    return {"id": id_, "name": name, "company": None, "email": None, "status": "LEAD", "domains": [], **over}


def own(local_id, name, **over):
    return {"localId": local_id, "name": name, "company": None, "email": None, "phone": None, "taxId": None, "domains": [], "notes": None,
            "centralId": None, "distinct": [], "createdAt": "x", "updatedAt": "x", **over}


def groups(entries):
    return sorted((e["name"], e["sources"]) for e in entries)


def test_un_manual_con_el_nif_de_central_va_con_central_aunque_crmdev_tenga_su_nombre():
    project = {"name": "Tienda", "status": "ACTIVE", "phase": None, "repo": None}
    entries, _ = client_sources.join([c("c1", "ACME S.L.", taxId="B12345678", projects=[project])], [r("k1", "Acme")],
                                     [own(1, "Acme", taxId="ES-B12345678")], Links())
    assert len(entries) == 1
    entry = entries[0]
    assert entry["sources"] == ["central", "crmdev", "local"] and entry["source"] == "ambos" and entry["projects"] == [project]


def test_el_nif_gana_al_nombre_y_un_nif_repetido_no_adivina():
    entries, _ = client_sources.join([c("c1", "Acme"), c("c2", "Otro Nombre", taxId="B1")], [], [own(1, "Acme", taxId="B1")], Links())
    assert ("Otro Nombre", ["central", "local"]) in groups(entries) and ("Acme", ["central"]) in groups(entries)
    entries, _ = client_sources.join([c("c1", "Uno", taxId="B1"), c("c2", "Dos", taxId="B1"), c("c3", "Acme")], [], [own(1, "Acme", taxId="B1")], Links())
    assert ("Acme", ["central"]) in groups(entries) and ("Acme", ["local"]) in groups(entries), "NIF en dos: no se une, ni por el nombre"


def test_todas_las_personas_de_esa_empresa_van_con_el_cliente_como_contactos():
    people = [r("k2", "Luis Gil", company="ACME", status="LEAD", email="luis@acme.com", domains=["acme.com"]),
              r("k1", "Juan Pérez", company="Acme", status="CUSTOMER", email="juan@gmail.com")]
    for order in (people, people[::-1]):
        entries, suggestions = client_sources.join([c("c1", "Acme", domains=["acme.com"])], order, [], Links())
        assert groups(entries) == [("Acme", ["central"])] and suggestions == []
        entry = entries[0]
        assert entry["contacts"] == [{"id": "k1", "name": "Juan Pérez", "status": "CUSTOMER"}, {"id": "k2", "name": "Luis Gil", "status": "LEAD"}]
        assert entry["crmdevStatus"] == "CUSTOMER", "el estado más avanzado de sus clientes de CRMDev"
        assert clients.find(entries, address="juan@gmail.com")["name"] == "Acme", "la dirección exacta de un contacto"
        assert "contactEmails" not in clients.public(entry) and "juan@gmail.com" not in str(clients.public(entry))
        assert "Juan" not in str(clients.for_model(entry)), "a Watson no le llegan las personas"
    entries, _ = client_sources.join([], [r("k1", "Ana", company="Bravo")], [own(1, "bravo")], Links())
    assert entries[0]["sources"] == ["local"] and entries[0]["contacts"][0]["name"] == "Ana", "también con un cliente manual"


def test_son_distintos_saca_a_una_persona_de_los_contactos():
    people = [r("k1", "Juan Pérez", company="Acme"), r("k2", "Luis Gil", company="Acme")]
    entries, _ = client_sources.join([c("c1", "Acme")], people, [], Links(central_crmdev={("c1", "k2"): "distinct"}))
    assert [x["id"] for x in entries[0]["contacts"]] == ["k1"] and ("Luis Gil", ["crmdev"]) in groups(entries)
    entries, _ = client_sources.join([], people, [own(1, "Acme")], Links(local_crmdev={1: {"linked": None, "distinct": {"k1"}}}))
    assert [x["id"] for x in next(e for e in entries if e["localId"] == 1)["contacts"]] == ["k2"]


def test_con_la_ficha_de_la_empresa_y_sus_personas_en_crmdev():
    entries, _ = client_sources.join([c("c1", "Acme")], [r("k0", "Acme", status="PROSPECT"), r("k1", "Juan", company="Acme", status="CUSTOMER")], [], Links())
    assert len(entries) == 1 and entries[0]["crmdevId"] == "k0" and [x["id"] for x in entries[0]["contacts"]] == ["k1"]
    assert entries[0]["crmdevStatus"] == "CUSTOMER"


def test_la_empresa_con_dos_candidatos_o_con_una_senal_mas_fuerte_es_solo_sugerencia():
    # «acme» kept here is not «Acme» of Central (the user said so): two candidates for the company.
    entries, suggestions = client_sources.join([c("c1", "Acme")], [r("k1", "Ana", company="Acme")], [own(2, "acme", distinct=["c1"])], Links())
    assert ("Ana", ["crmdev"]) in groups(entries)
    assert {"centralId": "c1", "centralName": "Acme", "crmdevId": "k1", "crmdevName": "Ana"} in suggestions
    assert {"localId": 2, "localName": "acme", "crmdevId": "k1", "crmdevName": "Ana"} in suggestions
    # Its address points to another client of Central, already taken: the company does not join it by itself.
    central = [c("c1", "Acme"), c("c2", "Bravo", email="ana@bravo.example")]
    links = Links(central_crmdev={("c2", "k9"): "linked"})
    entries, suggestions = client_sources.join(central, [r("k9", "Bravo CRM"), r("k1", "Ana", company="Acme", email="ana@bravo.example")], [], links)
    assert ("Ana", ["crmdev"]) in groups(entries) and any(s.get("crmdevId") == "k1" and s.get("centralId") == "c1" for s in suggestions)


def test_dos_iguales_en_crmdev_no_se_unen_solos_y_se_marcan():
    rows = [r("k2", "Acme"), r("k1", "Acme")]
    for order in (rows, rows[::-1]):
        entries, suggestions = client_sources.join([c("c1", "Acme")], order, [], Links())
        assert [e["sources"] for e in entries] == [["central"], ["crmdev"], ["crmdev"]], "el resultado no depende del orden de CRMDev"
        assert all(e["repeated"] for e in entries)
        assert sorted(s["crmdevId"] for s in suggestions) == ["k1", "k2"]


def test_el_correo_unico_cuenta_sobre_todos_los_de_central():
    central = [c("c1", "Uno", email="hola@x.example"), c("c2", "Dos", email="hola@x.example")]
    entries, _ = client_sources.join(central, [r("k1", "Otro", email="hola@x.example")], [], Links(central_crmdev={("c1", "k0"): "linked"}))
    assert ("Otro", ["crmdev"]) in groups(entries), "dos de Central con ese correo: aunque uno esté tomado, no se une"


def test_un_contacto_de_crmdev_en_el_dominio_de_un_cliente_de_central_no_lo_hace_ambiguo(tmp_path):
    connection = connect(tmp_path / DB_NAME)
    try:
        from agora_core.db import migrate
        migrate(connection)
        entries, _ = client_sources.join([c("c1", "Acme", domains=["acme.com"])], [r("k1", "Juan Pérez", email="juan@acme.com", domains=["acme.com"])], [], Links())
        assert len(entries) == 2
        assert clients.find(entries, address="maria@acme.com")["name"] == "Acme"
        assert clients.find(entries, address="juan@acme.com")["name"] == "Juan Pérez", "su dirección exacta sí es suya"
    finally:
        connection.close()


def test_unir_mil_clientes_de_crmdev_es_rapido():
    central = [c(f"c{n}", f"Central {n}", email=f"a{n}@c{n}.example", taxId=f"B{n:08d}") for n in range(300)]
    crmdev = [r(f"k{n}", f"Persona {n}" if n % 3 else f"Central {n % 300}", company=f"Central {n % 7}", email=f"p{n}@k{n}.example") for n in range(1000)]
    owns = [own(n + 1, f"Propio {n}" if n % 2 else f"central {n}", taxId=f"B{n:08d}" if n % 5 == 0 else None) for n in range(60)]
    started = time.perf_counter()
    entries, _ = client_sources.join(central, crmdev, owns, Links())
    elapsed = time.perf_counter() - started
    assert entries and elapsed < 1.0, f"{elapsed:.2f} s (objetivo bastante por debajo de 0,1 s)"


# --- with the database and the routes --------------------------------------------------------------------------

@pytest.fixture
def setup(tmp_path, fake):  # noqa: F811
    settings, app = app_with(tmp_path, MemorySecrets())
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        assert client.put("/connectors/crmdev", json={"url": URL, "key": KEY}, headers=HEADERS).status_code == 200
        assert client.post("/crmdev/clients/refresh", headers=HEADERS).status_code == 200
        connection = connect(settings.data_dir / DB_NAME)
        try:
            central.refresh(connection, None, fetch=lambda origin: {"clients": [{"id": "c1", "name": "Uno"}, {"id": "c2", "name": "Dos"}],
                                                                   "projects": [], "websites": [], "servers": [], "details": {}})
        finally:
            connection.close()
        yield client, settings


def test_un_enlace_que_choca_con_otro_se_rechaza(setup):
    client, settings = setup
    mine = client.post("/clients", json={"name": "Mío"}, headers=HEADERS).json()
    client.post(f"/clients/{mine['localId']}/link", json={"centralId": "c2"}, headers=HEADERS)
    assert client.post(f"/clients/{mine['localId']}/link", json={"connector": "crmdev", "remoteId": "c1"}, headers=HEADERS).status_code == 200
    answer = client.post("/clients/pairs", json={"centralId": "c1", "crmdevId": "c1", "state": "linked"}, headers=HEADERS)
    assert answer.status_code == 422 and "Dos" in answer.json()["error"] and "Deshaz" in answer.json()["error"]
    connection = connect(settings.data_dir / DB_NAME)
    try:
        assert connection.execute("SELECT count(*) FROM remote_link").fetchone()[0] == 0, "no se guarda"
    finally:
        connection.close()


def test_un_enlace_con_un_cliente_que_ya_no_aparece_vuelve_a_sin_ubicar(setup):
    client, settings = setup
    mine = client.post("/clients", json={"name": "Huérfano"}, headers=HEADERS).json()
    connection = connect(settings.data_dir / DB_NAME)
    try:
        with transaction(connection):
            connection.execute("INSERT INTO client_link (client_id, connector, remote_id, state, created_at) VALUES (?, 'crmdev', 'borrado', 'linked', ?)",
                               (mine["localId"], "2000-01-01T00:00:00Z"))
        clients._changed()
        entry = next(e for e in clients.directory(connection) if e["localId"] == mine["localId"])
        assert entry["unplaced"] is True and entry["staleLink"] == "crmdev"
        with transaction(connection):
            connection.execute("UPDATE client_link SET created_at = '2999-01-01T00:00:00Z'")
        clients._changed()
        entry = next(e for e in clients.directory(connection) if e["localId"] == mine["localId"])
        assert entry["unplaced"] is False, "recién enlazado y aún sin releer: ubicado"
    finally:
        connection.close()


def test_el_directorio_se_guarda_en_memoria_y_cambia_con_cada_escritura(setup):
    client, settings = setup
    connection = connect(settings.data_dir / DB_NAME)
    try:
        first = clients.directory(connection)
        first[0]["name"] = "tocado"
        assert clients.directory(connection)[0]["name"] != "tocado", "cada uno recibe su copia"
        clients.create(connection, {"name": "Nuevo"})
        assert "Nuevo" in {e["name"] for e in clients.directory(connection)}
    finally:
        connection.close()


def test_actualizar_mientras_lee_el_trabajador_espera_su_resultado(setup, fake):  # noqa: F811
    _, settings = setup
    seen = len(fake.seen)
    result = {}
    crmdev_sync._REFRESHING.acquire()

    def press():
        connection = connect(settings.data_dir / DB_NAME)
        try:
            result["data"] = crmdev_sync.refresh(connection, None)
        finally:
            connection.close()
    thread = threading.Thread(target=press)
    thread.start()
    time.sleep(0.2)
    crmdev_sync._REFRESHING.release()
    thread.join(5)
    assert result["data"]["clients"] and len(fake.seen) == seen, "toma lo que acaba de leer el trabajador, sin otra petición"


def test_el_directorio_en_memoria_cambia_al_apagar_un_modulo_y_al_releer(setup):
    _, settings = setup
    from agora_core import modules
    connection = connect(settings.data_dir / DB_NAME)
    try:
        assert any(e["crmdevId"] for e in clients.directory(connection))
        modules.save(connection, {"crmdev": False})
        assert not any(e["crmdevId"] for e in clients.directory(connection)), "apagar CRMDev cambia el directorio en memoria"
        modules.save(connection, {"crmdev": True})
        assert any(e["crmdevId"] for e in clients.directory(connection))
        central.refresh(connection, None, fetch=lambda origin: {"clients": [{"id": "c7", "name": "Recién Leído"}], "projects": [], "websites": [],
                                                               "servers": [], "details": {}})
        names = {e["name"] for e in clients.directory(connection)}
        assert "Recién Leído" in names and "Dos" not in names, "una lectura nueva de Central también"
    finally:
        connection.close()
