"""The single-use tokens shared by the confirmed changes of every connector: one send per token, a repeated press
answers the first result, a token expires, and two changes of the same thing are never sent at once."""

import asyncio
from dataclasses import dataclass

import pytest

from agora_core import confirmed_change
from agora_core.confirmed_change import PendingChanges, Refused, Sentences

WORDS = Sentences("caducada", "enviándose", "desconocido", "otro en curso")


@dataclass
class Thing:
    target: str


def run(coroutine):
    return asyncio.run(coroutine)


def test_un_solo_envio_y_la_repeticion_da_el_mismo_resultado():
    changes: PendingChanges[Thing] = PendingChanges(WORDS)
    token = changes.preview(Thing("tarea:t1"), "dueño")
    sent = []

    async def send(token, entry):
        sent.append(entry.change.target)
        entry.state, entry.result = "done", {"done": True}
        return entry.result

    assert run(changes.confirm(token, send)) == {"done": True}
    assert run(changes.confirm(token, send)) == {"done": True, "repeated": True}
    assert sent == ["tarea:t1"]


def test_ficha_caducada_o_desconocida(monkeypatch):
    changes: PendingChanges[Thing] = PendingChanges(WORDS, seconds=900)
    token = changes.preview(Thing("x"), "dueño")
    later = confirmed_change._now() + 901
    monkeypatch.setattr(confirmed_change, "_now", lambda: later)
    for asked in (token, "otra-ficha-que-no-existe"):
        with pytest.raises(Refused) as refused:
            run(changes.confirm(asked, lambda *_: None))
        assert refused.value.status == 410 and refused.value.kind == "expired" and str(refused.value) == "caducada"


def test_estado_desconocido_no_se_reenvia():
    changes: PendingChanges[Thing] = PendingChanges(WORDS)
    token = changes.preview(Thing("x"), "dueño")

    async def lost(token, entry):
        entry.state = "unknown"
        return "sin respuesta"

    assert run(changes.confirm(token, lost)) == "sin respuesta"
    with pytest.raises(Refused) as refused:
        run(changes.confirm(token, lost))
    assert refused.value.status == 409 and refused.value.kind == "unknown"


def test_dos_cambios_de_lo_mismo_a_la_vez_y_la_misma_ficha_dos_veces():
    changes: PendingChanges[Thing] = PendingChanges(WORDS)
    first, second = changes.preview(Thing("tarea:t1"), "d"), changes.preview(Thing("tarea:t1"), "d")
    gate = asyncio.Event()
    calls = []

    async def slow(token, entry):
        calls.append(token)
        await gate.wait()
        entry.state, entry.result = "done", {"done": True}
        return entry.result

    async def scenario():
        running = asyncio.create_task(changes.confirm(first, slow))
        await asyncio.sleep(0)
        answers = []
        for token in (first, second):
            with pytest.raises(Refused) as refused:
                await changes.confirm(token, slow)
            answers.append((refused.value.kind, str(refused.value)))
        gate.set()
        return await running, answers

    done, answers = run(scenario())
    assert done == {"done": True} and calls == [first]
    assert answers == [("repeated", "enviándose"), ("repeated", "otro en curso")]


def test_un_fallo_inesperado_obliga_a_revisar_otra_vez():
    changes: PendingChanges[Thing] = PendingChanges(WORDS)
    token = changes.preview(Thing("x"), "d")

    async def broken(token, entry):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        run(changes.confirm(token, broken))
    with pytest.raises(Refused) as refused:
        run(changes.confirm(token, broken))
    assert refused.value.status == 410


def test_tope_de_fichas():
    changes: PendingChanges[Thing] = PendingChanges(WORDS, limit=3)
    tokens = [changes.preview(Thing(str(n)), "d") for n in range(5)]
    with pytest.raises(Refused):
        run(changes.confirm(tokens[0], lambda *_: None))
    assert len(changes._items) == 3
