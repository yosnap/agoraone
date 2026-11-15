"""Watson proposes how to reorder the vault; nothing moves: it sees only normal notes, names them by the number it
was given, and every move is checked (an existing folder or a new one inside one, never overwriting another
note, never twice the same note) before it is kept as a proposal for the screen."""

import asyncio
import json
from contextlib import contextmanager

from agora_core.brain_tools import Toolbox
from agora_core.db import DB_NAME, connect, migrate
from agora_core.embed import VectorCache

LONG = "Texto suficiente para que la nota no cuente como casi vacía en la revisión del vault, de verdad."


def _note(c, ref, title, folder, level="normal"):
    item = c.execute("""INSERT INTO item (class, source, ref, title, folder, confidentiality, created_at, updated_at, modified_at)
                        VALUES ('note', 'v', ?, ?, ?, ?, 'x', 'x', 'x')""", (ref, title, folder, level)).lastrowid
    c.execute("INSERT INTO chunk (item_id, ord, text) VALUES (?, 0, ?)", (item, LONG))
    return item


def _box(tmp_path):
    c = connect(tmp_path / DB_NAME)
    migrate(c)
    acme = _note(c, "n1", "Acme", "Clientes/Acme")
    _note(c, "n2", "Reunión Acme", "")
    _note(c, "n3", "Idea suelta", "")
    _note(c, "n4", "Diario íntimo", "", "private")
    _note(c, "n5", "Casa", "Personal/Casa", "local_only")
    c.execute("INSERT INTO note_link (item_id, target) VALUES (?, 'Idea suelta')", (acme,))

    @contextmanager
    def database():
        yield c
    box = Toolbox(database, None, VectorCache())
    box.owner = "o"
    return box, c


def test_revisar_vault_solo_con_notas_normales(tmp_path):
    box, c = _box(tmp_path)
    seen = json.loads(asyncio.run(box.call("revisar_vault", {})))
    text = json.dumps(seen, ensure_ascii=False)
    assert "Diario íntimo" not in text and "Casa" not in text, "lo privado y lo solo local nunca llegan al modelo"
    assert seen["notas"] == 3 and {f["carpeta"] for f in seen["carpetas"]} == {"", "Clientes/Acme"}
    assert {s["titulo"] for s in seen["sueltas_en_la_raiz"]} == {"Reunión Acme", "Idea suelta"}
    assert all(isinstance(s["n"], int) for s in seen["sueltas_en_la_raiz"])
    c.close()


def test_lote_propuesto_y_comprobado(tmp_path):
    box, c = _box(tmp_path)
    seen = json.loads(asyncio.run(box.call("revisar_vault", {})))
    n = {s["titulo"]: s["n"] for s in seen["sueltas_en_la_raiz"]}
    answer = json.loads(asyncio.run(box.call("proponer_reorganizacion", {"resumen": "Lo de Acme, con Acme", "cambios": [
        {"n": n["Reunión Acme"], "carpeta": "Clientes/Acme", "motivo": "Es de Acme"},
        {"n": n["Idea suelta"], "carpeta": "Clientes/Ideas", "titulo": "Idea de producto"},
        {"n": n["Reunión Acme"], "carpeta": "Clientes"},
        {"n": 999, "carpeta": "Clientes"},
        {"n": n["Idea suelta"], "carpeta": "Nueva"},
    ]})))
    assert "No se ha movido nada" in answer["estado"] and answer["propuesta"] == {"cambios": 2, "renombrados": 1}
    assert len(answer["rechazados"]) == 3
    [proposal] = box.proposals.values()
    first, second = proposal["reorg"]
    assert (first["source"], first["ref"], first["toFolder"], first["toTitle"], first["newFolder"]) == ("v", "n2", "Clientes/Acme", None, False)
    assert (second["toFolder"], second["toTitle"], second["newFolder"], second["links"]) == ("Clientes/Ideas", "Idea de producto", True, 1)
    assert box.events[-1]["tool"] == "reorg_proposal"
    c.close()


def test_rechaza_destinos_peligrosos_o_repetidos(tmp_path):
    box, c = _box(tmp_path)
    seen = json.loads(asyncio.run(box.call("revisar_vault", {})))
    n = {s["titulo"]: s["n"] for s in seen["sueltas_en_la_raiz"]}
    bad = [{"n": n["Idea suelta"], "carpeta": "Clientes/../.."}, {"n": n["Idea suelta"], "titulo": "a/b"},
           {"n": n["Reunión Acme"], "carpeta": "Clientes/Acme", "titulo": "acme"}, {"n": n["Idea suelta"]}]
    answer = json.loads(asyncio.run(box.call("proponer_reorganizacion", {"cambios": bad})))
    assert answer["error"] == "Ningún cambio es válido." and len(answer["rechazados"]) == 4 and not box.proposals
    assert "error" in json.loads(asyncio.run(box.call("proponer_reorganizacion", {"cambios": [{"n": 1}] * 41})))
    c.close()


def test_solo_mayusculas_y_fuentes_sin_inflar(tmp_path):
    box, c = _box(tmp_path)
    seen = json.loads(asyncio.run(box.call("revisar_vault", {})))
    assert box.sources == [], "lo solo listado por título no es fuente de la respuesta"
    n = {s["titulo"]: s["n"] for s in seen["sueltas_en_la_raiz"]}
    answer = json.loads(asyncio.run(box.call("proponer_reorganizacion", {"cambios": [{"n": n["Idea suelta"], "titulo": "Idea Suelta"}]})))
    assert answer["propuesta"]["cambios"] == 1, "cambiar solo mayúsculas no choca consigo misma"
    asyncio.run(box.call("leer_nota", {"n": n["Idea suelta"]}))
    assert [s["title"] for s in box.sources] == ["Idea suelta"], "leída, pasa a ser fuente"
    c.close()
