"""Watson proposes notes; nothing is written: the note is checked (title, a folder that cannot leave the vault,
no passwords) and kept as a proposal for the screen, which creates it through the vault's own route."""

import asyncio
import json

from agora_core.brain_tools import Toolbox
from agora_core.embed import VectorCache


def test_nota_propuesta():
    box = Toolbox(lambda: None, None, VectorCache())
    box.owner = "o"
    answer = json.loads(asyncio.run(box.call("proponer_nota", {"titulo": "Acme / seguimiento", "carpeta": "Clientes/../../etc/Acme", "texto": "## Pendiente\n- Enviar presupuesto"})))
    assert "No está creada" in answer["estado"]
    [proposal] = box.proposals.values()
    assert proposal["note"] == {"title": "Acme - seguimiento", "folder": "Clientes/etc/Acme", "content": "## Pendiente\n- Enviar presupuesto"}
    assert box.events[-1]["tool"] == "note_proposal"
    refused = json.loads(asyncio.run(box.call("proponer_nota", {"titulo": "Accesos", "texto": "Servidor\npassword: hunter2secret"})))
    assert "contraseña" in refused["error"] and len(box.proposals) == 1
    assert "error" in json.loads(asyncio.run(box.call("proponer_nota", {"titulo": "", "texto": "x"})))


def test_evento_propuesto():
    box = Toolbox(lambda: None, None, VectorCache())
    box.owner = "o"
    answer = json.loads(asyncio.run(box.call("proponer_evento", {"titulo": "Reunión con Ana", "inicio": "2026-11-20T10:00"})))
    assert "No está creado" in answer["estado"]
    [proposal] = box.proposals.values()
    assert proposal["event"]["start"] == "2026-11-20T10:00" and proposal["event"]["end"] == "2026-11-20T11:00"
    assert "error" in json.loads(asyncio.run(box.call("proponer_evento", {"titulo": "x", "inicio": "mañana"})))
