import hashlib
import re

import pytest
from fastapi.testclient import TestClient

from agora_core.app import SECRET_HEADER, create_app
from agora_core.db import DB_NAME, connect, migrate
from agora_core.embed import EmbedError, VectorCache, embed_pending
from agora_core.index import Note, chunks, declared_level, remove_notes, replace_folder_rules, state, status, upsert_notes
from agora_core.keystore import MemoryStore
from agora_core.search import fts_query, search
from agora_core.settings import load_settings

SOURCE = "vault-" + "a" * 24
SECRET = "a" * 64
CONCEPTS = {"dinero": ("factura", "iva", "trimestre", "gasto"), "viaje": ("vuelo", "hotel", "maleta")}


class FakeEmbedder:
    """Words of the same concept land on the same dimension: enough to test search by meaning."""

    model = "falso"

    def __init__(self, fail=False):
        self.fail = fail

    def embed(self, texts):
        if self.fail:
            raise EmbedError("sin ollama")
        vectors = []
        for text in texts:
            vector = [0.0] * 8
            for word in re.findall(r"\w+", text.lower()):
                for n, (concept, words) in enumerate(CONCEPTS.items()):
                    if word == concept or word in words:
                        vector[n] += 1
                vector[2 + int(hashlib.sha256(word.encode()).hexdigest(), 16) % 6] += 0.05
            vectors.append(vector)
        return vectors


def ref(n):
    return "note-" + f"{n:024x}"


def note(n, title, text, folder=""):
    return Note(ref(n), title, folder, f"rev{n}", "2026-11-13T10:00:00Z", text)


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    yield connection
    connection.close()


def test_fragmentos_por_parrafos_y_encabezados():
    text = "---\ntags: x\n---\nIntro.\n\n# Sección\n\n" + ("palabra " * 300)
    pieces = chunks("Título", text)
    assert all(p.startswith("Título\n\n") for p in pieces)
    assert "tags: x" not in "".join(pieces), "las propiedades no se indexan como texto"
    assert pieces[0].endswith("Intro."), "un encabezado empieza fragmento nuevo"
    assert all(len(p) <= 1000 + len("Título\n\n") for p in pieces)
    assert chunks("Vacía", "") == ["Vacía"]


@pytest.mark.parametrize("value, level", [
    ("privado", "private"), ("Solo-Local", "local_only"), ("normal", "normal"), ("'privado'", "private"),
    ("algo raro", "private"),
])
def test_confidencialidad_declarada(value, level):
    assert declared_level(f"---\nconfidencialidad: {value}\n---\ntexto") == level
    assert declared_level("sin propiedades\nconfidencialidad: privado") == "normal", "solo cuenta en las propiedades"


def test_alta_cambio_y_baja_incremental(db):
    upsert_notes(db, SOURCE, "Vault", [note(1, "Uno", "hola"), note(2, "Dos", "adiós")])
    assert state(db, SOURCE) == {ref(1): "rev1", ref(2): "rev2"}
    upsert_notes(db, SOURCE, "Vault", [Note(ref(1), "Uno", "", "rev9", "x", "cambiado")])
    assert state(db, SOURCE)[ref(1)] == "rev9"
    assert db.execute("SELECT count(*) FROM chunk").fetchone()[0] == 2, "los fragmentos viejos se sustituyen"
    assert remove_notes(db, SOURCE, [ref(2)]) == 1
    assert state(db, SOURCE) == {ref(1): "rev9"}
    assert db.execute("SELECT count(*) FROM chunk_fts WHERE chunk_fts MATCH 'adios'").fetchone()[0] == 0


def test_busqueda_por_palabras_sin_tildes(db):
    upsert_notes(db, SOURCE, "Vault", [note(1, "Reunión", "Hablamos de la reunión con Álvaro sobre la ponencia")])
    found = search(db, "reunion alvaro", None, VectorCache(), "owner")
    assert [r["ref"] for r in found["results"]] == [ref(1)]
    assert found["semantic"] is False
    assert "«" in found["results"][0]["snippet"]
    assert fts_query('"; DROP TABLE item; --') is not None, "la sintaxis del usuario se neutraliza"
    assert search(db, '"; DROP TABLE item; --', None, VectorCache(), "owner")["results"] == []


def test_busqueda_por_significado_y_fusion(db):
    upsert_notes(db, SOURCE, "Vault", [
        note(1, "Trimestre", "Hay que revisar la factura y el IVA"),
        note(2, "Vacaciones", "Reservar vuelo y hotel"),
    ])
    embedder = FakeEmbedder()
    while embed_pending(db, embedder):
        pass
    found = search(db, "dinero", embedder, VectorCache(), "owner")
    assert found["semantic"] is True
    assert found["results"][0]["ref"] == ref(1), "encuentra la nota sin compartir palabras"
    assert found["results"][0]["matchedBy"] == ["meaning"]


def test_sin_ollama_busca_solo_por_palabras(db):
    upsert_notes(db, SOURCE, "Vault", [note(1, "Trimestre", "factura")])
    found = search(db, "factura", FakeEmbedder(fail=True), VectorCache(), "owner")
    assert found["semantic"] is False and found["results"][0]["ref"] == ref(1)


def test_confidencialidad_reglas_de_carpeta_y_filtro(db):
    upsert_notes(db, SOURCE, "Vault", [
        note(1, "Pública", "proyecto agora"),
        note(2, "Impuestos", "proyecto agora", folder="Fiscal/2026"),
        note(3, "Diario", "---\nconfidencialidad: privado\n---\nproyecto agora"),
    ])
    levels = lambda: dict(db.execute("SELECT ref, confidentiality FROM item").fetchall())  # noqa: E731
    assert levels() == {ref(1): "normal", ref(2): "normal", ref(3): "private"}
    assert replace_folder_rules(db, [(SOURCE, "fiscal", "local_only")]) == 1
    assert levels()[ref(2)] == "local_only", "la regla abarca subcarpetas y no distingue mayúsculas"
    assert replace_folder_rules(db, [("*", "Fiscal", "private")]) == 1
    assert levels()[ref(2)] == "private"
    replace_folder_rules(db, [])
    assert levels()[ref(2)] == "normal" and levels()[ref(3)] == "private", "lo declarado en la nota se mantiene"
    assert {r["ref"] for r in search(db, "agora", None, VectorCache(), "owner")["results"]} == {ref(1), ref(2), ref(3)}
    replace_folder_rules(db, [(SOURCE, "Fiscal", "local_only")])
    found = search(db, "agora", None, VectorCache(), "external")
    assert {r["ref"] for r in found["results"]} == {ref(1)}, "fuera del Mac, ni solo-local ni privado"
    replace_folder_rules(db, [])
    assert status(db)["byConfidentiality"] == {"normal": 2, "private": 1}


def test_embeddings_se_rehacen_si_cambia_el_texto(db):
    upsert_notes(db, SOURCE, "Vault", [note(1, "Uno", "factura")])
    embedder = FakeEmbedder()
    embed_pending(db, embedder)
    assert status(db)["pendingEmbeddings"] == 0
    upsert_notes(db, SOURCE, "Vault", [Note(ref(1), "Uno", "", "rev2", "x", "hotel")])
    assert status(db)["pendingEmbeddings"] == 1


def test_rutas_internas_y_busqueda_por_api(tmp_path):
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    app = create_app(settings, MemoryStore(), scheduler=False, embedder=None)
    with TestClient(app, base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET}
        body = {"source": SOURCE, "sourceName": "Vault", "notes": [
            {"ref": ref(1), "title": "Ponencia", "folder": "", "revision": "r1", "modifiedAt": "x", "text": "agentes y memoria"}]}
        assert client.post("/internal/index/notes", json=body, headers=headers).json() == {"indexed": 1}
        assert client.get("/internal/index/state", params={"source": SOURCE}, headers=headers).json() == {"refs": {ref(1): "r1"}}
        bad = dict(body, notes=[dict(body["notes"][0], ref="../../etc/passwd")])
        assert client.post("/internal/index/notes", json=bad, headers=headers).status_code == 422
        assert client.get("/search", params={"q": "memoria"}, headers=headers).status_code == 422, "sin destinatario no hay búsqueda"
        found = client.get("/search", params={"q": "memoria", "audience": "owner"}, headers=headers).json()
        assert found["results"][0]["title"] == "Ponencia"
        rules = {"rules": [{"source": "*", "folder": "Privado", "confidentiality": "private"}]}
        assert client.put("/index/folder-rules", json=rules, headers=headers).status_code == 200
        assert client.get("/index/folder-rules", headers=headers).json()["rules"][0]["folder"] == "Privado"
        assert client.get("/index/status", headers=headers).json()["notes"] == 1
        other = "vault-" + "b" * 24
        client.post("/internal/index/notes", json=dict(body, source=other), headers=headers)
        assert client.post("/internal/index/sources", json={"keep": [SOURCE, "'); DROP TABLE item; --"]}, headers=headers).json() == {"removed": 1}
        assert client.get("/index/status", headers=headers).json()["notes"] == 1, "solo se retira el vault quitado"
        assert client.post("/internal/index/remove", json={"source": SOURCE, "refs": [ref(1)]}, headers=headers).json() == {"removed": 1}
        assert client.get("/search", params={"q": "memoria", "audience": "owner"}).status_code == 401
        assert client.put("/index/folder-rules", json={"rules": [{"source": "*", "folder": "///", "confidentiality": "private"}]}, headers=headers).status_code == 422


def test_significado_sin_parecido_real_no_cuenta(db):
    """With a large enough index, fragments that do not stand out from the rest are not results."""
    import numpy as np

    class Fixed:
        model = "fijo"

        def __init__(self, query):
            self.query = query

        def embed(self, texts):
            return [self.query for _ in texts]

    rng = np.random.default_rng(7)
    notes = [note(n, f"N{n}", f"texto {n}") for n in range(80)]
    upsert_notes(db, SOURCE, "Vault", notes)
    ids = [r[0] for r in db.execute("SELECT id FROM chunk ORDER BY id")]
    noise = rng.normal(size=(len(ids), 16)).astype(np.float32)
    target = noise[3] / np.linalg.norm(noise[3])
    for chunk_id, vector in zip(ids, noise):
        db.execute("UPDATE chunk SET embedding = ?, embed_model = 'fijo' WHERE id = ?", ((vector / np.linalg.norm(vector)).tobytes(), chunk_id))
    cache = VectorCache()
    assert cache.nearest(db, Fixed(list(target)), "x") == [ids[3]], "solo el que destaca de verdad"
    assert cache.nearest(db, Fixed(list(rng.normal(size=16))), "x") == [], "nada destaca: ningún resultado"


def test_ollama_nunca_va_por_un_proxy(monkeypatch):
    """With HTTP_PROXY set (corporate proxy, Charles...), note text still goes straight to the local ollama."""
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from agora_core.embed import OllamaEmbedder

    seen = {"proxy": 0, "ollama": 0}

    def server(kind, reply):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                seen[kind] += 1
                self.rfile.read(int(self.headers["Content-Length"]))
                body = json.dumps(reply).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        http = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=http.serve_forever, daemon=True).start()
        return http

    proxy = server("proxy", {"embeddings": [[1.0]]})
    ollama = server("ollama", {"embeddings": [[1.0]]})
    try:
        for name in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "ALL_PROXY"):
            monkeypatch.setenv(name, f"http://127.0.0.1:{proxy.server_port}")
        monkeypatch.delenv("NO_PROXY", raising=False)
        monkeypatch.delenv("no_proxy", raising=False)
        OllamaEmbedder(f"http://127.0.0.1:{ollama.server_port}").embed(["nota privada"])
        assert seen == {"proxy": 0, "ollama": 1}
    finally:
        proxy.shutdown()
        ollama.shutdown()


@pytest.mark.parametrize("properties", [
    '"confidencialidad": privado', "\ufeff", "confidencialidad: normal\nconfidencialidad: privado", "  Confidencialidad : PRIVADO",
])
def test_propiedades_mal_escritas_cuentan_por_lo_mas_estricto(properties):
    text = ("\ufeff---  \nconfidencialidad: privado\n---\ntexto" if properties == "\ufeff"
            else f"---\n{properties}\n---\ntexto")
    assert declared_level(text) == "private"


def test_reglas_de_carpeta_normalizadas(db):
    import unicodedata

    decomposed = unicodedata.normalize("NFD", "Créditos/Año")
    upsert_notes(db, SOURCE, "Vault", [note(1, "Uno", "x", folder=decomposed)])
    replace_folder_rules(db, [(SOURCE, " créditos\\ ", "private")])
    assert db.execute("SELECT confidentiality FROM item").fetchone()[0] == "private"
    for bad in ("///", ".", "*", " / "):
        with pytest.raises(Exception):
            replace_folder_rules(db, [(SOURCE, bad, "private")])


def test_la_cache_ve_una_nota_editada_aunque_se_reutilicen_ids(db):
    """Editing the last note deletes and re-inserts its fragments with the same ids."""
    embedder, cache = FakeEmbedder(), VectorCache()
    upsert_notes(db, SOURCE, "Vault", [note(1, "Animal", "factura factura")])
    embed_pending(db, embedder)
    assert search(db, "dinero", embedder, cache, "owner")["results"]
    first_ids = [r[0] for r in db.execute("SELECT id FROM chunk")]
    upsert_notes(db, SOURCE, "Vault", [Note(ref(1), "Animal", "", "rev2", "x", "vuelo hotel")])
    embed_pending(db, embedder)
    assert [r[0] for r in db.execute("SELECT id FROM chunk")] == first_ids, "mismos ids: el caso que engañaba a la caché"
    import numpy as np

    _, _, matrix = cache.load(db, embedder.model)
    stored = np.frombuffer(db.execute("SELECT embedding FROM chunk").fetchone()[0], dtype=np.float32)
    assert np.array_equal(matrix[0], stored), "la matriz en memoria es la del texto nuevo, no la vieja"


def test_lo_excluido_no_desplaza_a_lo_permitido_por_significado(db):
    embedder = FakeEmbedder()
    notes = [note(n, f"Privada {n}", "---\nconfidencialidad: privado\n---\nfactura iva gasto") for n in range(60)]
    upsert_notes(db, SOURCE, "Vault", notes + [note(99, "Abierta", "trimestre")])
    while embed_pending(db, embedder):
        pass
    found = search(db, "dinero", embedder, VectorCache(), "external")
    assert [r["ref"] for r in found["results"]] == [ref(99)]


def test_el_trabajador_sobrevive_a_cualquier_error(tmp_path):
    import threading

    from agora_core.routes_index import EmbedHealth, embed_worker

    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path)})
    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    upsert_notes(connection, SOURCE, "Vault", [note(1, "Uno", "x")])
    connection.close()

    class Broken:
        model = "roto"
        calls = 0

        def embed(self, texts):
            Broken.calls += 1
            raise RuntimeError("fallo inesperado")

    stop, health = threading.Event(), EmbedHealth()
    worker = threading.Thread(target=embed_worker, args=(settings, Broken(), stop, health))
    import agora_core.routes_index as routes

    routes.IDLE_SECONDS, saved = 0.05, routes.IDLE_SECONDS
    try:
        worker.start()
        for _ in range(100):
            if Broken.calls >= 2:
                break
            threading.Event().wait(0.02)
        assert worker.is_alive() and Broken.calls >= 2, "sigue vivo y reintenta"
        assert health.ok is False and "inesperado" in health.problem
    finally:
        stop.set()
        worker.join(2)
        routes.IDLE_SECONDS = saved
