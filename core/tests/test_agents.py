"""The «Agentes» section: Watson's activity shows who did what and how it ended, never the details."""

import json
from datetime import UTC, datetime, timedelta

from agora_core import routes_agents
from agora_core.db import DB_NAME, connect, migrate
from agora_core.routes_assistant import ANSWERING


def test_actividad_de_watson_sin_detalles(tmp_path):
    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    now = datetime(2026, 11, 16, 22, 0, tzinfo=UTC)
    stamp = lambda hours: (now - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    rows = [(stamp(1), "watson", "buscar", "done", json.dumps({"query": "CANARIO-secreto"})),
            (stamp(2), "user", "mail.send", "done", json.dumps({"to": "ana@ejemplo.com"})),
            (stamp(3), "watson", "Algo raro; DROP", "done", None),
            (stamp(30), "watson", "leer", "done", None)]
    connection.executemany("INSERT INTO action_log (occurred_at, actor, action, outcome, detail) VALUES (?, ?, ?, ?, ?)", rows)
    connection.commit()
    view = routes_agents.watson_activity(connection, now)
    assert [e["action"] for e in view["events"]] == ["buscar", "mail.send"], "solo 24 h y solo nombres del propio registro"
    assert view["events"][1]["actor"] == "user" and view["lastAt"] == stamp(1)
    assert "CANARIO" not in json.dumps(view) and "ana@" not in json.dumps(view)
    connection.close()


def test_dice_cuando_esta_respondiendo(tmp_path, monkeypatch):
    connection = connect(tmp_path / DB_NAME)
    migrate(connection)
    monkeypatch.setitem(ANSWERING, "now", 1)
    monkeypatch.setitem(ANSWERING, "since", "2026-11-16T22:00:00Z")
    view = routes_agents.watson_activity(connection)
    assert view["answering"] == 1 and view["since"] == "2026-11-16T22:00:00Z" and view["events"] == []
    connection.close()
