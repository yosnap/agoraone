"""Claude Code and Codex sessions of this Mac: metadata only, read incrementally, never the conversation."""

import json
import os
import time

from agora_core import coding_sessions as c

NOW = time.time()


def iso(seconds_ago: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(NOW - seconds_ago))


def write(path, lines, mtime=NOW):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        for line in lines:
            handle.write(json.dumps(line) + "\n")
    os.utime(path, (mtime, mtime))


def claude_answer(seconds_ago, message_id, stop, out=10):
    return {"type": "assistant", "timestamp": iso(seconds_ago), "cwd": "/Users/x/Proyectos/agoraone", "gitBranch": "feat/x",
            "message": {"id": message_id, "model": "claude-opus-5-5", "stop_reason": stop, "content": [{"type": "text", "text": "CANARIO-respuesta"}],
                        "usage": {"input_tokens": 5, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 9999, "output_tokens": out}}}


def test_claude_code_estado_tokens_sin_contenido(tmp_path, monkeypatch):
    monkeypatch.setattr(c, "_cache", {})
    file = tmp_path / ".claude" / "projects" / "-Users-x-agoraone" / "s1.jsonl"
    write(file, [{"type": "user", "timestamp": iso(60), "cwd": "/Users/x/Proyectos/agoraone", "message": {"content": "CANARIO-pregunta"}},
                 claude_answer(50, "m1", "tool_use"), claude_answer(50, "m1", "tool_use"),  # the same message, written twice as it streamed
                 {"type": "user", "timestamp": iso(40), "cwd": "/Users/x/Proyectos/agoraone/core", "message": {"content": [{"type": "tool_result", "content": "CANARIO-herramienta"}]}}])
    found = c.sessions(NOW, tmp_path)
    assert len(found) == 1
    session = found[0]
    assert session["tool"] == "claude" and session["project"] == "agoraone", "la carpeta donde empezó, no la de un cd posterior"
    assert session["state"] == "working" and session["branch"] == "feat/x" and session["model"] == "claude-opus-5-5"
    assert session["tokens"] == {"input": 105, "output": 10} and session["turns"] == 1, "un mensaje repetido cuenta una vez; sin lecturas de caché"
    assert "CANARIO" not in json.dumps(found) and "/Users" not in json.dumps(found)
    # Appended later: only the new part is read, and a finished answer means it waits for the user.
    write(file, [claude_answer(5, "m2", "end_turn", out=7)])
    session = c.sessions(NOW, tmp_path)[0]
    assert session["state"] == "waiting" and session["tokens"]["output"] == 17 and session["turns"] == 2


def test_codex_turnos_y_tokens(tmp_path, monkeypatch):
    monkeypatch.setattr(c, "_cache", {})
    day = time.strftime("%Y/%m/%d", time.gmtime(NOW))
    file = tmp_path / ".codex" / "sessions" / day / "rollout-1.jsonl"
    write(file, [{"type": "session_meta", "timestamp": iso(90), "payload": {"cwd": "/Users/x/web", "base_instructions": "CANARIO"}},
                 {"type": "turn_context", "timestamp": iso(80), "payload": {"model": "gpt-6", "cwd": "/Users/x/web"}},
                 {"type": "event_msg", "timestamp": iso(80), "payload": {"type": "task_started"}},
                 {"type": "event_msg", "timestamp": iso(30), "payload": {"type": "token_count", "info": {"last_token_usage": {"input_tokens": 1000, "cached_input_tokens": 400, "output_tokens": 50}}}}])
    session = c.sessions(NOW, tmp_path)[0]
    assert (session["tool"], session["project"], session["model"], session["state"]) == ("codex", "web", "gpt-6", "working")
    assert session["tokens"] == {"input": 600, "output": 50}
    write(file, [{"type": "event_msg", "timestamp": iso(10), "payload": {"type": "task_complete", "last_agent_message": "CANARIO"}}])
    assert c.sessions(NOW, tmp_path)[0]["state"] == "waiting"
    assert "CANARIO" not in json.dumps(c.sessions(NOW, tmp_path))


def test_lo_viejo_los_enlaces_y_lo_a_medias_no_cuentan(tmp_path, monkeypatch):
    monkeypatch.setattr(c, "_cache", {})
    folder = tmp_path / ".claude" / "projects" / "p"
    write(folder / "viejo.jsonl", [claude_answer(3 * 86400, "a", "end_turn")], mtime=NOW - 3 * 86400)
    outside = tmp_path / "fuera.jsonl"
    write(outside, [claude_answer(5, "b", "end_turn")])
    (folder / "enlace.jsonl").symlink_to(outside)
    half = folder / "medias.jsonl"
    half.write_text(json.dumps(claude_answer(5, "c", "end_turn"))[:-5])  # a line still being written
    assert c.sessions(NOW, tmp_path) == []
    with half.open("a") as handle:
        handle.write(json.dumps(claude_answer(5, "c", "end_turn"))[-5:] + "\n")
    found = c.sessions(NOW, tmp_path)
    assert len(found) == 1 and found[0]["turns"] == 1, "la línea a medias se lee entera en cuanto se termina"


def test_permiso_interrupcion_y_comandos_locales(tmp_path, monkeypatch):
    monkeypatch.setattr(c, "_cache", {})
    file = tmp_path / ".claude" / "projects" / "p" / "s.jsonl"
    write(file, [claude_answer(600, "m1", "tool_use")], mtime=NOW - 600)  # asked for a tool ten minutes ago, nothing since
    assert c.sessions(NOW, tmp_path)[0]["state"] == "tool", "herramienta larga o esperando tu permiso"
    write(file, [{"type": "user", "timestamp": iso(500), "message": {"content": [{"type": "text", "text": "[Request interrupted by user]"}]}}])
    assert c.sessions(NOW, tmp_path)[0]["state"] == "waiting", "interrumpida con Esc: te espera"
    write(file, [{"type": "user", "isMeta": True, "timestamp": iso(400), "message": {"content": "CANARIO"}},
                 {"type": "user", "timestamp": iso(30), "message": {"content": "<local-command-stdout>CANARIO</local-command-stdout>"}}])
    assert c.sessions(NOW, tmp_path)[0]["state"] == "waiting", "un comando local no la pone a trabajar"
    write(file, [{"type": "assistant", "timestamp": iso(20), "message": {"model": "<synthetic>", "stop_reason": "end_turn"}}])
    assert c.sessions(NOW, tmp_path)[0]["model"] == "claude-opus-5-5"


def test_no_relee_un_archivo_con_contenido_antiguo_y_fecha_reciente(tmp_path, monkeypatch):
    monkeypatch.setattr(c, "_cache", {})
    file = tmp_path / ".claude" / "projects" / "p" / "s.jsonl"
    write(file, [claude_answer(30 * 3600, "m1", "end_turn"), {"type": "ai-title", "title": "x"}])  # old content, file touched now
    c.sessions(NOW, tmp_path)
    assert str(file) in c._cache
    reads = []
    original = c._Record.read
    monkeypatch.setattr(c._Record, "read", lambda self, line: reads.append(1) or original(self, line))
    c.sessions(NOW, tmp_path)
    assert reads == [], "en caché: nada que volver a leer"


def test_codex_sin_eventos_repetidos_ni_valores_raros(tmp_path, monkeypatch):
    monkeypatch.setattr(c, "_cache", {})
    day = time.strftime("%Y/%m/%d", time.gmtime(NOW))
    count = {"type": "event_msg", "timestamp": iso(30), "payload": {"type": "token_count", "info": {
        "total_token_usage": {"total_tokens": 700}, "last_token_usage": {"input_tokens": 600, "output_tokens": 100}}}}
    write(tmp_path / ".codex" / "sessions" / day / "r.jsonl", [
        {"type": "session_meta", "timestamp": iso(90), "payload": {"cwd": 42}},
        {"type": "event_msg", "timestamp": iso(80), "payload": {"type": "task_started"}}, count, count,
        {"type": "event_msg", "timestamp": iso(20), "payload": {"type": "token_count", "info": {"last_token_usage": {"input_tokens": "mucho"}}}},
        {"type": "event_msg", "timestamp": iso(10), "payload": {"type": "turn_aborted"}}])
    session = c.sessions(NOW, tmp_path)[0]
    assert session["tokens"] == {"input": 600, "output": 100} and session["project"] is None and session["state"] == "waiting"


def test_un_archivo_que_desaparece_no_tumba_la_lista(tmp_path, monkeypatch):
    monkeypatch.setattr(c, "_cache", {})
    write(tmp_path / ".claude" / "projects" / "p" / "bueno.jsonl", [claude_answer(5, "a", "end_turn")])
    write(tmp_path / ".claude" / "projects" / "p" / "roto.jsonl", [claude_answer(5, "b", "end_turn")])
    real_open = c.Path.open
    monkeypatch.setattr(c.Path, "open", lambda self, *a, **k: (_ for _ in ()).throw(FileNotFoundError()) if self.name == "roto.jsonl" else real_open(self, *a, **k))
    assert len(c.sessions(NOW, tmp_path)) == 1
