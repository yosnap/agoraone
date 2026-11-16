"""The calendar with an in-memory EventKit: agenda, overlaps, confirmed creation and what Watson may see."""
import asyncio
import json
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from agora_core import calendar_store
from agora_core.app import SECRET_HEADER, create_app
from agora_core.brain_tools import Toolbox
from agora_core.db import DB_NAME, connect
from agora_core.keystore import MemoryStore
from agora_core.search import VectorCache
from agora_core.settings import load_settings

SECRET, OWNER = "a" * 64, "b" * 64


def at(hours: float) -> str:
    start = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    return calendar_store._iso(start + timedelta(hours=hours))


def store() -> calendar_store.FakeStore:
    return calendar_store.FakeStore(
        calendars=[{"id": "trabajo", "title": "Trabajo", "kind": "event", "account": "iCloud", "writable": True},
                   {"id": "medico", "title": "Médico", "kind": "event", "account": "iCloud", "writable": True}],
        events=[{"id": "e1", "calendarId": "trabajo", "title": "Reunión con Artilabs", "start": at(9), "end": at(10), "allDay": False, "location": None},
                {"id": "e2", "calendarId": "trabajo", "title": "Llamada", "start": at(9.5), "end": at(11), "allDay": False, "location": None},
                {"id": "e3", "calendarId": "medico", "title": "Dentista", "start": at(17), "end": at(18), "allDay": False, "location": None}],
        reminders=[{"id": "r1", "calendarId": "trabajo", "title": "Enviar presupuesto", "due": at(12)}])


def test_solapes():
    a = {"id": "a", "start": "2026-11-15T09:00:00Z", "end": "2026-11-15T10:00:00Z"}
    b = {"id": "b", "start": "2026-11-15T09:59:00Z", "end": "2026-11-15T11:00:00Z"}
    c = {"id": "c", "start": "2026-11-15T10:00:00Z", "end": "2026-11-15T11:00:00Z"}
    allday = {"id": "d", "start": "2026-11-15T00:00:00Z", "end": "2026-11-16T00:00:00Z", "allDay": True}
    assert calendar_store.overlaps([a, b, c, allday]) == [("a", "b"), ("b", "c")], "uno que empieza al acabar otro no se solapa; los de todo el día no cuentan"
    assert calendar_store.clashes("2026-11-15T10:30:00Z", "2026-11-15T10:45:00Z", [a, b, c]) == [b, c]


def test_agenda_crear_y_lo_que_ve_watson(tmp_path):
    fake = store()
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    with TestClient(create_app(settings, MemoryStore(), scheduler=False, embedder=None, calendar=fake), base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}
        assert client.get("/calendar/status", headers=headers).json() == {"events": "granted", "reminders": "granted"}
        day = client.get("/calendar/agenda?when=hoy", headers=headers).json()
        assert [e["title"] for e in day["events"]] == ["Reunión con Artilabs", "Llamada", "Dentista"] and day["overlaps"] == [["e1", "e2"]]
        assert [r["title"] for r in day["reminders"]] == ["Enviar presupuesto"]
        listed_day = client.get("/calendar/agenda?when=hoy", headers=headers).json()["events"][0]
        assert listed_day["calendar"] == "Trabajo" and listed_day["account"] == "iCloud" and "scope" in listed_day, "cada evento dice de qué calendario y ámbito es"
        today = datetime.now().astimezone().date()
        month = client.get(f"/calendar/agenda?from={today.replace(day=1).isoformat()}&to={today.isoformat()}", headers=headers)
        assert month.status_code == 200 and isinstance(month.json()["events"], list)
        assert client.get(f"/calendar/agenda?from={today.isoformat()}&to={(today + timedelta(days=500)).isoformat()}", headers=headers).status_code == 422
        assert client.get(f"/calendar/agenda?from={today.isoformat()}&to={(today - timedelta(days=1)).isoformat()}", headers=headers).status_code == 422
        assert client.put("/calendar/calendars/medico", json={"confidentiality": "private"}, headers=headers).json() == {"ok": True}
        assert client.put("/calendar/calendars/trabajo", json={"scopeId": 999}, headers=headers).status_code == 422
        listed = {c["id"]: c for c in client.get("/calendar/calendars", headers=headers).json()["calendars"]}
        assert listed["medico"]["confidentiality"] == "private" and listed["trabajo"]["confidentiality"] == "normal"

        # Creating asks again when it clashes, and only creates with the user's yes.
        event = {"calendarId": "trabajo", "title": "Revisión", "start": at(9.75), "end": at(10.5)}
        clash = client.post("/calendar/events", json=event, headers=headers)
        assert clash.status_code == 409 and [c["title"] for c in clash.json()["clashes"]] == ["Reunión con Artilabs", "Llamada"] and fake.created == []
        assert client.post("/calendar/events", json={**event, "overlapOk": True}, headers=headers).json() == {"id": "ev1", "clashes": 2}
        assert client.post("/calendar/events", json={**event, "end": at(9)}, headers=headers).status_code == 422, "termina antes de empezar"
        assert client.post("/calendar/reminders", json={"title": "Llamar a Ana", "due": at(15)}, headers=headers).status_code == 201

    class Database:
        def __enter__(self):
            self.connection = connect(tmp_path / "data" / DB_NAME)
            return self.connection

        def __exit__(self, *exc):
            self.connection.close()
    answer = json.loads(asyncio.run(Toolbox(Database, None, VectorCache()).call("consultar_agenda", {"cuando": "hoy"})))
    titles = [e["titulo"] for e in answer["eventos"]]
    assert "Dentista" not in titles and "Reunión con Artilabs" in titles, "un calendario privado nunca llega al modelo"
    assert ["Reunión con Artilabs", "Llamada"] in answer["solapes"] and "no instrucciones" in answer["aviso"]
    try:
        calendar_store.use(calendar_store.FakeStore(status="denied"))
        assert "permiso" in json.loads(asyncio.run(Toolbox(Database, None, VectorCache()).call("consultar_agenda", {})))["error"]
    finally:
        calendar_store.use(None)


def test_dias_con_cambio_de_hora(monkeypatch):
    import time
    monkeypatch.setenv("TZ", "Europe/Madrid")
    time.tzset()
    try:
        start, end = calendar_store.day_range("hoy", datetime(2026, 10, 25, 12, 0))
        assert (start.hour, end.hour, end - start) == (0, 0, timedelta(hours=25)), "el día del cambio de hora va de medianoche a medianoche"
        start, end = calendar_store.day_range("mañana", datetime(2026, 3, 28, 12, 0))
        assert (start.day, end.day, end - start) == (29, 30, timedelta(hours=23))
    finally:
        monkeypatch.delenv("TZ")
        time.tzset()


def test_un_fallo_del_calendario_se_avisa_sin_romper(tmp_path):
    class Broken(calendar_store.FakeStore):
        def events(self, start, end):
            raise OSError("EventKit")
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    try:
        with TestClient(create_app(settings, MemoryStore(), scheduler=False, embedder=None, calendar=Broken()), base_url=f"http://{settings.authority}") as client:
            day = client.get("/calendar/agenda", headers={SECRET_HEADER: SECRET, "x-agora-owner": OWNER}).json()
            assert day["events"] == [] and day["problem"] == "No se pudo leer el calendario de macOS."
    finally:
        calendar_store.use(None)
