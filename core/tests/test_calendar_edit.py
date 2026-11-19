"""Seeing an event whole and changing the user's own: only events they organise in a calendar that allows it, only
as they saw it, with the previous version kept first, warning of clashes, never deleting."""

import json

from fastapi.testclient import TestClient

from agora_core import calendar_edit
from agora_core.app import SECRET_HEADER, create_app
from agora_core.db import DB_NAME, connect
from agora_core.keystore import MemoryStore
from agora_core.settings import load_settings

from test_calendar import OWNER, SECRET, at, store


def test_enlaces_de_reunion_primero():
    found = calendar_edit.links({"url": "https://acme.com/agenda", "location": "Sala 2 · https://meet.google.com/abc-defg-hij",
                                 "notes": "Unirse: https://us02web.zoom.us/j/123?pwd=x. Otra vez https://acme.com/agenda"})
    assert [(f["meeting"], f["url"]) for f in found] == [("Google Meet", "https://meet.google.com/abc-defg-hij"),
                                                         ("Zoom", "https://us02web.zoom.us/j/123?pwd=x"), (None, "https://acme.com/agenda")]
    for trick in ("https://evil.com\\.meet.google.com/abc", "https://meet.google.com@evil.com/abc", "https://evil.com/?meet.google.com"):
        assert all(f["meeting"] is None for f in calendar_edit.links({"notes": trick})), trick


def test_una_invitacion_ajena_o_un_calendario_de_lectura_no_se_cambian():
    other = {"name": "Ana", "email": "ana@acme.com", "me": False}
    assert "Ana" in calendar_edit.why_not({"writable": True, "attendees": [{"me": True}], "organizer": other})
    assert calendar_edit.why_not({"writable": True, "attendees": [{"me": False}], "organizer": {"me": True}}) is None
    assert "Ana" in calendar_edit.why_not({"writable": True, "attendees": [], "organizer": other}), "aunque la cuenta oculte los invitados"
    assert "solo lectura" in calendar_edit.why_not({"writable": False, "attendees": []})


def test_ver_y_cambiar_un_evento(tmp_path):
    fake = store()
    fake.events_list[2].update({"notes": "Llevar informe https://meet.google.com/xyz", "url": None})
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    with TestClient(create_app(settings, MemoryStore(), scheduler=False, embedder=None, calendar=fake), base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}
        seen = client.get("/calendar/event", params={"id": "e3"}, headers=headers).json()
        assert seen["editable"] and seen["links"][0]["meeting"] == "Google Meet"
        body = {"id": "e3", "revision": seen["revision"], "title": "Dentista (cambiado)", "start": at(9.25), "end": at(9.75), "notes": "Nuevo"}
        clash = client.put("/calendar/event", json=body, headers=headers)
        assert clash.status_code == 409 and {c["title"] for c in clash.json()["clashes"]} == {"Reunión con Artilabs", "Llamada"}
        assert fake.events_list[2]["title"] == "Dentista", "sin confirmar el solape no se cambia nada"
        moved = client.put("/calendar/event", json={**body, "overlapOk": True}, headers=headers)
        assert moved.status_code == 200 and fake.events_list[2]["title"] == "Dentista (cambiado)" and fake.events_list[2]["notes"] == "Nuevo"
        stale = client.put("/calendar/event", json={**body, "overlapOk": True, "title": "Otra vez"}, headers=headers)
        assert stale.status_code == 409 and "ha cambiado" in stale.json()["error"] and fake.events_list[2]["title"] == "Dentista (cambiado)"
        connection = connect(settings.data_dir / DB_NAME)
        kept = connection.execute("SELECT before, after, applied FROM calendar_change").fetchall()
        connection.execute("INSERT INTO calendar_setting (calendar_id, confidentiality, hidden) VALUES ('medico', 'normal', 1)")
        connection.commit()
        connection.close()
        assert kept[0]["applied"] == 1
        assert len(kept) == 1 and json.loads(kept[0]["before"])["title"] == "Dentista" and json.loads(kept[0]["after"])["title"] == "Dentista (cambiado)"
        fake.events_list[0].update({"attendees": [{"name": "Yo", "me": True}], "organizer": {"name": "Ana", "email": "ana@acme.com", "me": False}})
        invited = client.get("/calendar/event", params={"id": "e1"}, headers=headers).json()
        assert not invited["editable"] and "Ana" in invited["why"]
        refused = client.put("/calendar/event", json={**body, "id": "e1", "revision": invited["revision"], "start": at(20), "end": at(21)}, headers=headers)
        assert refused.status_code == 422 and fake.events_list[0]["title"] == "Reunión con Artilabs"
        assert client.get("/calendar/event", params={"id": "nada"}, headers=headers).status_code == 404


def test_un_cambio_que_macos_no_guarda_queda_como_no_aplicado(tmp_path):
    fake = store()
    fake.fail_update = True
    settings = load_settings({"AGORA_CORE_SECRET": SECRET, "AGORA_CORE_DATA": str(tmp_path / "data")})
    with TestClient(create_app(settings, MemoryStore(), scheduler=False, embedder=None, calendar=fake), base_url=f"http://{settings.authority}") as client:
        headers = {SECRET_HEADER: SECRET, "x-agora-owner": OWNER}
        seen = client.get("/calendar/event", params={"id": "e3"}, headers=headers).json()
        failed = client.put("/calendar/event", json={"id": "e3", "revision": seen["revision"], "title": "X", "start": at(20), "end": at(21)}, headers=headers)
        assert failed.status_code == 422 and fake.events_list[2]["title"] == "Dentista"
        connection = connect(settings.data_dir / DB_NAME)
        assert [r["applied"] for r in connection.execute("SELECT applied FROM calendar_change")] == [0]
        connection.close()
