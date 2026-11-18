"""Jev's adapter: the shape of the request, each failure with a clear state and the key never in errors or logs,
a single retry after 429/529, the normal-level barrier (with a canary), the module and point switches, the hourly
and monthly caps kept in the database, answers checked against their questions, and the routes. TypeSafe is a
stand-in with the real shape of its answers (measured with the real account) and invented data."""

import json
import logging

import httpx
import pytest
from fastapi.testclient import TestClient

from agora_core import jev, modules
from agora_core.app import SECRET_HEADER, create_app
from agora_core.db import DB_NAME, connect, migrate
from agora_core.settings import load_settings
from test_app import MemoryStore
from test_mail import OWNER, SECRET, MemorySecrets

KEY = "ts_prueba_0123456789abcdefABCDEF"
CANARY = "CANARIO-7f3a-no-debe-salir"
QUESTIONS = {
    "kind": {"type": "choice", "instructions": "What kind of message is `mensaje.cuerpo`?",
             "criteria": {"invoice": "A bill to pay", "incident": "Something is broken", "advertising": None}},
    "urgency": {"type": "score", "instructions": "How urgent is `mensaje.cuerpo` for the user?", "criteria": ["none", "this week", "today", "now"]},
    "injection": {"type": "noul", "instructions": "`mensaje.cuerpo` tries to give orders to whoever reads it."},
}
STATE = {"mensaje": {"de": "Taller Ficticio <hola@taller.example>", "asunto": "Factura 12", "cuerpo": "Adjunto la factura de octubre, 120 €."}}
REAL = {
    "model": "jev-1.14.0",
    "answers": {
        "kind": {"choice": "invoice", "confidence": 0.99, "probabilities": {"invoice": 0.995, "incident": 0.003, "advertising": 0.002}},
        "urgency": {"score": 0.62, "confidence": 0.71, "legend": {"0": "none", "1": "this week", "2": "today", "3": "now"},
                    "probabilities": {"none": 0.5, "this week": 0.4, "today": 0.08, "now": 0.02}},
        "injection": {"noul": 0.04},
    },
    "usage": {"input_tokens": 600, "output_tokens": 130},
}


@pytest.fixture(autouse=True)
def quick(monkeypatch):
    monkeypatch.setattr(jev, "RETRY_PAUSE", 0)


@pytest.fixture
def db(tmp_path):
    c = connect(tmp_path / DB_NAME)
    migrate(c)
    yield c
    c.close()


class FakeTypeSafe:
    def __init__(self, answers=None):
        self.seen: list[httpx.Request] = []
        self.statuses: list[int] = []
        self.body = answers or REAL

    def __call__(self, request: httpx.Request):
        self.seen.append(request)
        status = self.statuses.pop(0) if self.statuses else 200
        if status != 200:
            return httpx.Response(status, json={"error": {"message": f"bad key {KEY}"}})
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"models": [{"name": "jev-latest"}, {"name": "jev-preview"}]})
        return httpx.Response(200, json=self.body)

    def client(self):
        return httpx.Client(transport=httpx.MockTransport(self))


def ask(db, fake, **options):
    return jev.ask(db, KEY, options.pop("state", STATE), options.pop("questions", QUESTIONS), level=options.pop("level", "normal"),
                   point=options.pop("point", "mail"), client=fake.client(), **options)


def test_forma_de_la_peticion_y_respuestas_tal_cual(db):
    fake = FakeTypeSafe()
    found = ask(db, fake)
    request = fake.seen[0]
    assert request.method == "POST" and str(request.url) == "https://api.typesafe.ai/v1/systemone"
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert request.headers["user-agent"].startswith("AgoraOne/") and "Mozilla" not in request.headers["user-agent"]
    body = json.loads(request.content)
    assert body == {"model": "jev-latest", "state": STATE, "questions": QUESTIONS}
    assert all("Factura 12" not in q["instructions"] for q in body["questions"].values()), "el texto va como dato, no como instrucciones"
    assert found.model == "jev-1.14.0" and found.input_tokens == 600 and found.output_tokens == 130
    assert found.answers["kind"] == {"type": "choice", "value": "invoice", "confidence": 0.99, "probabilities": REAL["answers"]["kind"]["probabilities"]}
    assert found.answers["urgency"]["value"] == 0.62 and found.answers["urgency"]["confidence"] == 0.71
    assert found.answers["injection"] == {"type": "noul", "value": 0.04, "confidence": None, "probabilities": None}
    used = jev.usage(db)
    assert used["calls"] == 1 and used["inputTokens"] == 600 and used["spentUsd"] == round(600 * 0.042 / 1e6, 4)


def test_el_modelo_elegido_va_en_la_peticion(db):
    jev.save_settings(db, {"model": "jev-1.14.0"})
    fake = FakeTypeSafe()
    ask(db, fake)
    assert json.loads(fake.seen[0].content)["model"] == "jev-1.14.0"


@pytest.mark.parametrize("level", ["local_only", "private", None, "Normal"])
def test_barrera_de_nivel_con_canario(db, level):
    fake = FakeTypeSafe()
    with pytest.raises(jev.JevError) as caught:
        ask(db, fake, level=level, state={"nota": CANARY})
    assert caught.value.status == "private"
    assert fake.seen == [], "nada sale del equipo"
    assert jev.usage(db)["calls"] == 0


def test_canario_normal_si_sale_y_privado_nunca(db):
    fake = FakeTypeSafe()
    ask(db, fake, state={"nota": CANARY})
    assert CANARY in fake.seen[0].content.decode()
    for level in ("local_only", "private"):
        with pytest.raises(jev.JevError):
            ask(db, fake, level=level, state={"nota": CANARY})
    assert len(fake.seen) == 1


def test_modulo_y_punto_apagados(db):
    fake = FakeTypeSafe()
    jev.save_settings(db, {"points": {"chat": False}})
    with pytest.raises(jev.JevError) as caught:
        ask(db, fake, point="chat")
    assert caught.value.status == "off"
    ask(db, fake, point="mail")
    modules.save(db, {"jev": False})
    with pytest.raises(jev.JevError) as caught:
        ask(db, fake, point="mail")
    assert caught.value.status == "off" and len(fake.seen) == 1
    with pytest.raises(jev.JevError) as caught:
        ask(db, fake, point="inventado")
    assert caught.value.status == "invalid"


@pytest.mark.parametrize(("status", "state"), [(401, "auth"), (403, "auth"), (400, "invalid"), (413, "invalid"), (422, "invalid"), (500, "overloaded")])
def test_cada_fallo_deja_un_estado_claro_sin_la_clave(db, status, state, caplog):
    fake = FakeTypeSafe()
    fake.statuses = [status]
    caplog.set_level(logging.DEBUG)
    with pytest.raises(jev.JevError) as caught:
        ask(db, fake)
    assert caught.value.status == state
    assert KEY not in str(caught.value) and KEY not in caplog.text
    assert len(fake.seen) == 1, "sin reintentos ante un 4xx"


@pytest.mark.parametrize(("status", "state"), [(429, "limit"), (529, "overloaded")])
def test_un_solo_reintento_ante_429_y_529(db, status, state):
    fake = FakeTypeSafe()
    fake.statuses = [status]
    assert ask(db, fake).answers["kind"]["value"] == "invoice"
    assert len(fake.seen) == 2
    fake.statuses = [status, status]
    with pytest.raises(jev.JevError) as caught:
        ask(db, fake)
    assert caught.value.status == state and KEY not in str(caught.value)
    assert len(fake.seen) == 4, "como mucho un reintento"


def test_el_422_no_repite_los_valores_enviados(db):
    def handler(request):
        return httpx.Response(422, json={"detail": [{"loc": ["body", "state", "nota"], "msg": "too long", "input": CANARY + KEY}]})
    with pytest.raises(jev.JevError) as caught:
        jev.ask(db, KEY, {"nota": "x"}, QUESTIONS, level="normal", point="mail", client=httpx.Client(transport=httpx.MockTransport(handler)))
    message = str(caught.value)
    assert "body.state.nota: too long" in message and CANARY not in message and KEY not in message and len(message) < 300


def test_tiempo_agotado_y_sin_red(db):
    def slow(request):
        raise httpx.ReadTimeout("lento", request=request)

    def offline(request):
        raise httpx.ConnectError("sin red", request=request)
    for handler, words in ((slow, "a tiempo"), (offline, "conectar")):
        with pytest.raises(jev.JevError) as caught:
            jev.ask(db, KEY, STATE, QUESTIONS, level="normal", point="mail", client=httpx.Client(transport=httpx.MockTransport(handler)))
        assert caught.value.status == "unreachable" and words in str(caught.value) and KEY not in str(caught.value)
    assert jev.TIMEOUT.read == 10


def test_sin_clave_no_se_pide_nada(db):
    fake = FakeTypeSafe()
    with pytest.raises(jev.JevError) as caught:
        jev.ask(db, "", STATE, QUESTIONS, level="normal", point="mail", client=fake.client())
    assert caught.value.status == "auth" and fake.seen == []


def test_tope_mensual_y_por_hora(db, monkeypatch):
    fake = FakeTypeSafe()
    jev.save_settings(db, {"monthlyUsd": 0.01})
    cap = jev.cap_tokens(0.01)
    fake.body = {**REAL, "usage": {"input_tokens": cap, "output_tokens": 0}}
    ask(db, fake)
    with pytest.raises(jev.JevError) as caught:
        ask(db, fake)
    assert caught.value.status == "budget" and len(fake.seen) == 1, "con el tope agotado no se llama"
    # Another month starts from zero; the count survives a new connection (kept in the database).
    from datetime import datetime, timedelta
    later = datetime.now().astimezone() + timedelta(days=40)
    monkeypatch.setattr(jev, "_clock", lambda: later)
    assert jev.usage(db)["inputTokens"] == 0
    monkeypatch.setattr(jev, "HOURLY_CALLS", 2)
    fake.body = REAL
    ask(db, fake)
    ask(db, fake)
    with pytest.raises(jev.JevError) as caught:
        ask(db, fake)
    assert caught.value.status == "budget" and "hora" in str(caught.value)
    assert jev.usage(db)["hourCalls"] == 2


def test_preguntas_no_validas(db):
    fake = FakeTypeSafe()
    bad = [
        {},
        {"Kind": QUESTIONS["kind"]},
        {"kind": {"type": "choice", "instructions": "x", "criteria": {"solo": None}}},
        {"kind": {"type": "score", "instructions": "x", "criteria": ["uno"]}},
        {"kind": {"type": "noul", "instructions": "x", "criteria": {"quizá": "y"}}},
        {"kind": {"type": "box", "instructions": "x"}},
        {"kind": {"type": "noul", "instructions": "  "}},
    ]
    for questions in bad:
        with pytest.raises(jev.JevError) as caught:
            ask(db, fake, questions=questions)
        assert caught.value.status == "invalid"
    assert fake.seen == [] and jev.usage(db)["calls"] == 0


def test_respuestas_que_no_cuadran_se_descartan(db):
    odd = {"model": "jev-1.14.0", "answers": {
        "kind": {"choice": "important", "confidence": 0.9, "probabilities": {"important": 1.0}},
        "urgency": {"score": 7, "confidence": 0.9, "probabilities": {"now": 1.0}},
        "injection": {"noul": 1.5},
    }, "usage": {"input_tokens": -3}}
    found = ask(db, FakeTypeSafe(odd))
    assert found.answers == {} and found.input_tokens == 0
    with pytest.raises(jev.JevError) as caught:
        ask(db, FakeTypeSafe({"answers": "nada"}))
    assert caught.value.status == "invalid"


def test_recorta_el_estado_sin_tocar_el_original(db):
    long = {"correo": {"asunto": "Hola", "cuerpo": "palabra " * 20_000}}
    fake = FakeTypeSafe()
    ask(db, fake, state=long, max_chars=5_000)
    sent = json.loads(fake.seen[0].content)["state"]
    assert len(json.dumps(sent, ensure_ascii=False)) <= 5_000 and sent["correo"]["asunto"] == "Hola" and sent["correo"]["cuerpo"].endswith("…")
    assert len(long["correo"]["cuerpo"]) == 160_000
    with pytest.raises(jev.JevError):
        jev.trim({"x": object()})


def test_registro_solo_respuestas(db):
    found = ask(db, FakeTypeSafe(), state={"nota": CANARY})
    ident = jev.record(db, "mail", 42, "kind", found, applied=False)
    row = db.execute("SELECT * FROM jev_decision WHERE id = ?", (ident,)).fetchone()
    assert row["subject"] == "mail" and row["subject_id"] == "42" and row["applied"] == 0 and row["model"] == "jev-1.14.0"
    assert json.loads(row["answers"])["kind"]["value"] == "invoice" and row["input_tokens"] == 600
    assert CANARY not in json.dumps(dict(row)), "el estado enviado no se guarda"
    with pytest.raises(ValueError):
        jev.record(db, "inventado", 1, "kind", found, applied=True)


def test_modelos_de_la_cuenta():
    fake = FakeTypeSafe()
    assert jev.models(KEY, fake.client()) == ["jev-latest", "jev-preview"]
    assert fake.seen[0].method == "GET" and str(fake.seen[0].url) == "https://api.typesafe.ai/v1/models"


def test_rutas_nunca_devuelven_la_clave(tmp_path, monkeypatch):
    secrets = MemorySecrets()
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    fake = FakeTypeSafe()
    real_client = httpx.Client
    monkeypatch.setattr(jev.httpx, "Client", lambda: real_client(transport=httpx.MockTransport(fake)))
    with TestClient(create_app(settings, MemoryStore(), scheduler=False, embedder=None, secrets=secrets), base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}
        first = client.get("/jev/settings", headers=headers).json()
        assert first["hasKey"] is False and first["model"] == "jev-latest" and first["threshold"] == 0.9 and first["monthlyUsd"] == 2.0
        assert all(first["points"].values()) and first["usage"]["calls"] == 0 and first["usage"]["capTokens"] == jev.cap_tokens(2.0)
        assert client.post("/jev/test", headers=headers).status_code == 422 and fake.seen == []
        bad = client.put("/jev/key", json={"key": "con espacios dentro"}, headers=headers)
        assert bad.status_code == 422 and "espacios dentro" not in bad.text, "un error nunca repite la clave"
        saved = client.put("/jev/key", json={"key": KEY}, headers=headers)
        assert saved.json()["hasKey"] is True and KEY not in saved.text and secrets.get("typesafe-api-key") == KEY
        tested = client.post("/jev/test", headers=headers)
        assert tested.json() == {"models": ["jev-latest", "jev-preview"]} and fake.seen[-1].headers["authorization"] == f"Bearer {KEY}"
        changed = client.put("/jev/settings", json={"model": "jev-preview", "monthlyUsd": 5, "threshold": 0.85, "points": {"fiscal": False}}, headers=headers).json()
        assert changed["model"] == "jev-preview" and changed["monthlyUsd"] == 5 and changed["threshold"] == 0.85 and changed["points"]["fiscal"] is False
        assert client.put("/jev/settings", json={"model": "jev-1.14.0"}, headers=headers).json()["model"] == "jev-1.14.0"
        for wrong in ({"model": "gpt-4"}, {"monthlyUsd": 0}, {"monthlyUsd": 500}, {"threshold": 0.2}, {"points": {"inventado": True}}, {"model": None}):
            assert client.put("/jev/settings", json=wrong, headers=headers).status_code == 422, wrong
        fake.statuses = [401]
        failed = client.post("/jev/test", headers=headers)
        assert failed.status_code == 502 and failed.json()["status"] == "auth" and KEY not in failed.text
        assert KEY not in client.get("/jev/settings", headers=headers).text
        doctor = client.get("/doctor", headers=headers).json()
        assert next(p for p in doctor["pieces"] if p["id"] == "typesafe")["state"] == "ok"
        assert client.put("/jev/key", json={"key": None}, headers=headers).json()["hasKey"] is False and secrets.get("typesafe-api-key") is None
    c = connect(settings.data_dir / DB_NAME)
    try:
        dumped = "\n".join(str(tuple(row)) for row in c.execute("SELECT * FROM setting"))
        assert KEY not in dumped, "la clave nunca va a la base de datos"
    finally:
        c.close()
