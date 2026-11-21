"""Calls and reminders: a synthetic CallHistory, missed calls not returned, quiet hours, each notification
once, the morning summary and what Watson's model may see."""
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from agora_core import alerts, calendar_store, calls, mail_summarizer
from agora_core.db import DB_NAME, connect, migrate
from tests.test_mail_inbox import FakeEngine, account, add, asker


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "data" / DB_NAME)
    migrate(connection)
    yield connection
    connection.close()


def history(path, rows):
    """A CallHistory database with the columns macOS uses (dates in seconds from 2001)."""
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE ZCALLRECORD (Z_PK INTEGER PRIMARY KEY, ZDATE TIMESTAMP, ZDURATION FLOAT, ZADDRESS VARCHAR, "
                       "ZORIGINATED INTEGER, ZANSWERED INTEGER, ZNAME VARCHAR, ZUNIQUE_ID VARCHAR)")
    for n, (hours_ago, address, outgoing, answered) in enumerate(rows, 1):
        stamp = (datetime.now(timezone.utc) - timedelta(hours=hours_ago) - calls.APPLE_EPOCH).total_seconds()
        connection.execute("INSERT INTO ZCALLRECORD VALUES (?, ?, ?, ?, ?, ?, NULL, ?)", (n, stamp, 0 if not answered else 60, address, outgoing, answered, f"u{n}"))
    connection.commit()
    connection.close()


def test_historial_de_llamadas_en_copia_y_perdidas_sin_devolver(tmp_path):
    db_file = tmp_path / "CallHistory.storedata"
    history(db_file, [(5, "+34 600 111 222", 0, 0), (4, "600111222", 1, 0), (3, "+34 699 000 000", 0, 0),
                      (2, b"+34699000000", 0, 0), (200, "+34 611 222 333", 0, 0)])
    found = calls.read_calls(days=7, db=db_file)
    assert [c["address"] for c in found] == ["+34699000000", "+34 699 000 000", "600111222", "+34 600 111 222"], "solo los últimos 7 días, las direcciones en bytes también"
    assert [c["id"] for c in calls.missed_not_returned(found)] == ["u4"], "la devuelta no cuenta, y cada número una vez"
    with pytest.raises(calls.CallsUnavailable) as missing:
        calls.read_calls(db=tmp_path / "no-existe")
    assert missing.value.code == "missing", "no pide «Acceso total al disco» si el permiso no es el problema"
    db_file.write_bytes(b"no es sqlite")
    with pytest.raises(calls.CallsUnavailable) as broken:
        calls.read_calls(db=db_file)
    assert broken.value.code == "unreadable"
    hidden = [{"id": "h1", "at": "2026-11-14T10:00:00+00:00", "address": None, "outgoing": False, "answered": False, "duration": 0, "name": None}]
    assert calls.missed_not_returned(hidden) == hidden, "un número oculto también avisa"


def test_silencio_que_cruza_la_medianoche():
    chosen = {"quietFrom": "22:00", "quietTo": "08:00"}
    at = lambda h, m=0: datetime(2026, 11, 15, h, m)  # noqa: E731
    assert alerts.quiet(at(23), chosen) and alerts.quiet(at(7, 59), chosen) and not alerts.quiet(at(8), chosen) and not alerts.quiet(at(15), chosen)
    assert alerts.quiet(at(13), {"quietFrom": "13:00", "quietTo": "15:00"}) and not alerts.quiet(at(16), {"quietFrom": "13:00", "quietTo": "15:00"})


def test_avisos_una_vez_resumen_y_lo_que_ve_watson(db):
    now = datetime.now().astimezone().replace(hour=10, minute=0, second=0, microsecond=0)
    soon = now + timedelta(minutes=10)
    store = calendar_store.FakeStore(events=[{"id": "e1", "calendarId": "cal", "title": "Llamada con Artilabs", "start": calendar_store._iso(soon),
                                              "end": calendar_store._iso(soon + timedelta(hours=1)), "allDay": False, "location": "Meet"}])
    normal = account(db, "yo@gmail.com")
    add(db, normal, "ana@cliente.es", "Entrega del logo", "Para mañana")
    tomorrow = (now.date() + timedelta(days=1)).isoformat()
    ask, _ = asker(lambda messages: json.dumps({"correos": [{"n": 1, "tipo": "cliente", "resumen": "Quiere el logo.", "fechas": [tomorrow]}]}))
    mail_summarizer.summarize_once(db, [FakeEngine()], ask)
    missed = [{"id": "c1", "at": (now - timedelta(hours=2)).isoformat(), "address": "+34 600 111 222", "outgoing": False, "answered": False, "duration": 0, "name": None}]
    sources = {"store": store, "call_reader": lambda: missed, "contacts": calls.FakeContacts({"600111222": "Ana Pérez"})}

    shown = alerts.due(db, now, **sources)
    assert [a["title"] for a in shown] == ["Llamada perdida de Ana Pérez", f"A las {soon.strftime('%H:%M')}: Llamada con Artilabs",
                                           "Mañana: Entrega del logo", "Tu día en AgoraOne"]
    assert shown[-1]["body"] == "1 en la agenda · 0 recordatorios · 1 en la Bandeja · 1 llamada sin devolver."
    assert len(alerts.due(db, now, **sources)) == 4, "lo que no se llegó a mostrar vuelve"
    alerts.ack(db, [a["key"] for a in shown[:2]], now)
    assert [a["title"] for a in alerts.due(db, now, **sources)] == ["Mañana: Entrega del logo", "Tu día en AgoraOne"], "cada aviso una sola vez"
    alerts.save_settings(db, {"quietFrom": "09:00", "quietTo": "11:00"})
    assert alerts.due(db, now, **sources) == [], "nada en horas de silencio"
    alerts.save_settings(db, {"quietFrom": "22:00", "quietTo": "08:00", "callsLevel": "private", "summary": False})
    db.execute("DELETE FROM alert_delivered")
    private = alerts.due(db, now, **sources)
    assert private[0]["title"] == "Llamada perdida" and all("Ana" not in a["title"] for a in private), "lo privado sale sin nombres"
    assert all(a["kind"] != "summary" for a in private)
    watson = alerts.collect(db, now, audience="owner", respect=False, **sources)
    assert watson["morning"] is not None, "Watson tiene el resumen aunque las notificaciones del resumen estén apagadas"
    alerts.save_settings(db, {"callsLevel": "local_only", "summary": True})

    outside = alerts.collect(db, now, audience="external", **sources)
    assert outside["missed"] == [] and "llamada" not in outside["morning"]["body"], "las llamadas son solo de este Mac por defecto"
    alerts.save_settings(db, {"callsLevel": "normal"})
    assert alerts.collect(db, now, audience="external", **sources)["missed"], "salvo que el usuario las marque normales"
    early = now.replace(hour=7)
    assert alerts.collect(db, early, **sources)["morning"] is None, "el resumen llega a su hora"


def test_lo_que_no_existe_en_este_sistema_no_es_un_aviso(db):
    """No call history on this system is said in Ajustes (callsProblem), not as a notice; a missing permission is one."""
    now = datetime.now().astimezone().replace(hour=10, minute=0, second=0, microsecond=0)

    def reader(code):
        def read():
            raise calls.CallsUnavailable("El historial de llamadas no se puede leer.", code)
        return read

    absent = alerts.collect(db, now, store=calendar_store.FakeStore(events=[]), call_reader=reader("unavailable"), contacts=None)
    assert absent["problems"] == [] and absent["callsProblem"] == "unavailable"
    blocked = alerts.collect(db, now, store=calendar_store.FakeStore(events=[]), call_reader=reader("permission"), contacts=None)
    assert blocked["problems"] == ["El historial de llamadas no se puede leer."] and blocked["callsProblem"] == "permission"
