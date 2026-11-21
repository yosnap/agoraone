//! Ported from server/hermes-worker.test.ts, hermes-agent-bridge.test.ts and the bridge allowlist test of
//! vault-notes.test.ts: the per-conversation process manager, and the real agent bridge (built into the
//! binary) against the installed Hermes with a fictitious profile and a fake local model that asks for
//! tools: no tokens, no real profile, no user files. The Hermes tests are skipped where it is not installed.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agora_server::chat::AGENT_BRIDGE;
use agora_server::chat::worker::{self, Progress, Spawn};
use axum::Router;
use axum::body::Bytes;
use axum::response::IntoResponse;
use serde_json::{Value, json};

fn temp() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let base = agora_server::platform::canonicalize(dir.path()).unwrap();
    (dir, base)
}

const FIXTURE: &str = r#"
import json, os, sys, time
for line in sys.stdin:
    data = json.loads(line)
    print(json.dumps({"type": "delta", "text": "fragmento"}), flush=True)
    time.sleep(0.05)
    print(json.dumps({"type": "done", "ok": not data.get("fail"), "pid": os.getpid()}), flush=True)
"#;

#[tokio::test]
async fn un_proceso_por_sesion_reutilizado_un_turno_a_la_vez_y_descartado_tras_fallo() {
    let (_dir, base) = temp();
    let python = agora_server::hermes::python::system_python().expect("python3");
    let spawn = Spawn { python, source: FIXTURE.into(), home: base, env: vec![("PATH".into(), agora_server::hermes::python::user_path())] };
    let limit = Duration::from_secs(20);
    let call = |key: &'static str, payload: Value| {
        let spawn = &spawn;
        async move { worker::request(key, spawn, &payload, None, limit).await }
    };
    let first = call("prueba-a", json!({})).await.unwrap();
    assert_eq!(call("prueba-a", json!({})).await.unwrap()["pid"], first["pid"], "se reutiliza");
    assert_ne!(call("prueba-b", json!({})).await.unwrap()["pid"], first["pid"], "otra sesión, otro proceso");
    let deltas = Arc::new(Mutex::new(0));
    let counter = deltas.clone();
    let progress: Progress = Arc::new(move |event: Value| {
        if event["type"] == "delta" {
            *counter.lock().unwrap() += 1;
        }
    });
    let empty = json!({});
    let pending = worker::request("prueba-a", &spawn, &empty, Some(progress), limit);
    let busy = async {
        tokio::time::sleep(Duration::from_millis(10)).await;
        call("prueba-a", json!({})).await
    };
    let (finished, refused) = tokio::join!(pending, busy);
    assert!(finished.is_ok() && refused.unwrap_err().contains("en curso"));
    assert_eq!(*deltas.lock().unwrap(), 1, "el progreso llega al turno");
    assert!(call("prueba-a", json!({ "fail": true })).await.unwrap_err().contains("no completó"));
    assert_ne!(call("prueba-a", json!({})).await.unwrap()["pid"], first["pid"], "tras un fallo, proceso nuevo");
    assert_eq!(call("prueba-b", json!({})).await.unwrap()["ok"], true);
    worker::stop("prueba-a");
    worker::stop("prueba-b");
}

#[tokio::test]
async fn si_el_puente_muere_solo_no_deja_huerfanos_sus_procesos() {
    // A bridge that starts a long-lived child (as the agent's terminal tool would), notes its pid and crashes.
    let (_dir, base) = temp();
    let pid_file = base.join("hijo.pid");
    let python = agora_server::hermes::python::system_python().expect("python3");
    let source = format!(
        "import subprocess, os, sys\nchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\nopen({:?}, 'w').write(str(child.pid))\nos._exit(1)\n",
        pid_file.display().to_string()
    );
    let spawn = Spawn { python, source, home: base.clone(), env: vec![("PATH".into(), agora_server::hermes::python::user_path())] };
    let _ = worker::request("prueba-huerfano", &spawn, &json!({}), None, Duration::from_secs(10)).await;
    let mut child = None;
    for _ in 0..50 {
        if let Some(pid) = fs::read_to_string(&pid_file).ok().and_then(|text| text.trim().parse::<i64>().ok()) {
            child = Some(pid);
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let child = child.expect("el puente arrancó su proceso hijo");
    let mut alive = true;
    for _ in 0..50 {
        alive = agora_server::platform::process_alive(child);
        if !alive {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!alive, "el proceso que dejó el puente se detiene");
}

#[test]
fn el_puente_de_luma_solo_acepta_notas_y_copias_emitidas_por_agoraone() {
    // The Python bridge keeps its own allowlist; this keeps it in step with the ids the server issues.
    let source = include_str!("../python/hermes_bridge.py");
    let patterns: Vec<regex::Regex> = regex::Regex::new(r#"re\.fullmatch\(r"([^"]+)", document_id\)"#)
        .unwrap()
        .captures_iter(source)
        .map(|c| regex::Regex::new(&format!("^(?:{})$", &c[1])).unwrap())
        .collect();
    assert!(!patterns.is_empty());
    let allowed = |id: &str| ["welcome", "orbital-garden"].contains(&id) || patterns.iter().any(|p| p.is_match(id));
    assert!(allowed(&format!("note-{}", "a".repeat(24))));
    assert!(allowed("import-12345678-abcd-abcd-abcd-123456789abc"));
    assert!(!allowed("note-../../etc"));
    assert!(!allowed(&format!("note-{}", "a".repeat(25))));
}

/// The installed Hermes, if any.
fn hermes() -> Option<(PathBuf, PathBuf)> {
    let installation = agora_server::platform::home_dir()?.join(".hermes/hermes-agent");
    // The interpreter AgoraOne itself would choose: Hermes' own Python, or its virtual environment before it had one.
    let python = agora_server::hermes::location::from_env().python;
    (installation.join("run_agent.py").exists() && python.exists()).then_some((installation, python))
}

/// A fake OpenAI-compatible model that asks for one tool depending on the user's words, then reports it.
fn fake_model(work: PathBuf, home: PathBuf) -> Router {
    Router::new().fallback(move |body: Bytes| {
        let (work, home) = (work.clone(), home.clone());
        async move {
            let data: Value = serde_json::from_slice(&body).unwrap_or_default();
            let messages = data["messages"].as_array().cloned().unwrap_or_default();
            let last = messages.last().cloned().unwrap_or_default();
            let user = messages.iter().rev().find(|m| m["role"] == "user").map(|m| agora_server::js::js_string(Some(&m["content"]))).unwrap_or_default();
            let call = |name: &str, args: Value| json!({ "role": "assistant", "tool_calls": [{ "index": 0, "id": format!("call_{name}"), "type": "function", "function": { "name": name, "arguments": args.to_string() } }] });
            let key = format!("sk-{}", "AbCdEf0123456789AbCdEf");
            let delta = if last["role"] == "tool" {
                json!({ "role": "assistant", "content": format!("Resultado: {}", agora_server::js::slice_utf16(&agora_server::js::js_string(Some(&last["content"])), 200)) })
            } else if user.contains("otro perfil") {
                call("read_file", json!({ "path": home.join(".hermes/profiles/otro/auth.json") }))
            } else if user.contains("clave privada") {
                call("read_file", json!({ "path": home.join(".ssh/id_prueba") }))
            } else if user.contains("programa") {
                call("terminal", json!({ "command": "sleep 1", "background": true }))
            } else if user.contains("clave") {
                call("write_file", json!({ "path": work.join("script.sh"), "content": format!("export API_KEY='{key}'\nrm -rf ~/Documentos") }))
            } else if user.contains("escribe") {
                call("write_file", json!({ "path": work.join("salida.txt"), "content": "hola" }))
            } else if user.contains("lee") {
                call("read_file", json!({ "path": work.join("nota.txt") }))
            } else {
                json!({ "role": "assistant", "content": "Hola." })
            };
            let finish = if delta.get("tool_calls").is_some() { "tool_calls" } else { "stop" };
            let chunk = |choice: Value| format!("data: {}\n\n", json!({ "id": "x", "object": "chat.completion.chunk", "created": 1, "model": "fake", "choices": [choice], "usage": { "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2 } }));
            let body = chunk(json!({ "index": 0, "delta": delta, "finish_reason": null })) + &chunk(json!({ "index": 0, "delta": {}, "finish_reason": finish })) + "data: [DONE]\n\n";
            ([("content-type", "text/event-stream")], body).into_response()
        }
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn perfil_con_herramientas_lee_sin_preguntar_y_solo_escribe_si_se_permite() {
    let Some((installation, python)) = hermes() else { return eprintln!("Hermes no instalado: se omite") };
    let (_dir, base) = temp();
    let (work, home) = (base.join("work"), base.join("home"));
    let profile = home.join(".hermes/profiles/prueba");
    fs::create_dir_all(&work).unwrap();
    fs::create_dir_all(profile.join("memories")).unwrap();
    fs::write(work.join("nota.txt"), "texto de la nota").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(axum::serve(listener, fake_model(work.clone(), home.clone())).into_future());
    fs::write(
        profile.join("config.yaml"),
        format!("model:\n  provider: custom\n  base_url: http://127.0.0.1:{port}/v1\n  default: fake\n  api_key: not-a-real-key\nplatform_toolsets:\n  telegram: [file, terminal]\napprovals:\n  mode: \"off\"\n"),
    )
    .unwrap();
    fs::write(profile.join("SOUL.md"), "Soy un perfil de prueba.").unwrap();
    fs::create_dir_all(home.join(".hermes/profiles/otro")).unwrap();
    fs::create_dir_all(home.join(".ssh")).unwrap();
    fs::write(home.join(".hermes/profiles/otro/auth.json"), r#"{"token": "CANARY_OTHER_PROFILE"}"#).unwrap();
    fs::write(home.join(".ssh/id_prueba"), "CANARY_PRIVATE_KEY").unwrap();
    let spawn = Spawn {
        python,
        source: AGENT_BRIDGE.into(),
        home: work.clone(),
        env: vec![
            ("PATH".into(), agora_server::hermes::python::user_path()),
            ("HOME".into(), home.display().to_string()),
            ("USERPROFILE".into(), home.display().to_string()),
            ("HERMES_HOME".into(), home.join(".hermes").display().to_string()),
            ("AGORA_HERMES_PATH".into(), installation.display().to_string()),
            ("PYTHONDONTWRITEBYTECODE".into(), "1".into()),
        ],
    };
    let key = "agent:agora-00000000-0000-4000-8000-000000000001";
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let answer = Arc::new(Mutex::new("deny"));
    let turn = |message: &str| {
        events.lock().unwrap().clear();
        let (seen, choice) = (events.clone(), answer.clone());
        let progress: Progress = Arc::new(move |event: Value| {
            if event["type"] == "approval" {
                let reply = json!({ "type": "approval", "requestId": event["requestId"], "choice": *choice.lock().unwrap() });
                tokio::spawn(async move { worker::send(key, &reply).await });
            }
            seen.lock().unwrap().push(event);
        });
        let payload = json!({ "type": "turn", "profile": "prueba", "sessionId": "agora-00000000-0000-4000-8000-000000000001", "message": message, "history": [] });
        let spawn = &spawn;
        async move { worker::request(key, spawn, &payload, Some(progress), Duration::from_secs(120)).await.unwrap() }
    };
    let approvals = |events: &Arc<Mutex<Vec<Value>>>| events.lock().unwrap().iter().filter(|e| e["type"] == "approval").cloned().collect::<Vec<_>>();

    let read = turn("lee la nota").await;
    assert!(read["reply"].as_str().unwrap().contains("texto de la nota"));
    assert!(approvals(&events).is_empty(), "leer no pide permiso");

    let denied = turn("escribe un fichero").await;
    assert!(denied["reply"].as_str().unwrap().contains("BLOCKED"));
    let asked = approvals(&events);
    assert_eq!(asked[0]["tool"], "write_file");
    assert!(asked[0]["args"].as_str().unwrap().contains("salida.txt"));
    assert!(!work.join("salida.txt").exists(), "denegado: no se escribe");

    *answer.lock().unwrap() = "once";
    turn("escribe un fichero").await;
    assert_eq!(fs::read_to_string(work.join("salida.txt")).unwrap(), "hola");
    assert!(events.lock().unwrap().iter().any(|e| e["type"] == "tool" && e["name"] == "write_file"));
    let config = fs::read_to_string(profile.join("config.yaml")).unwrap();
    assert!(!config.contains("allowlist") && !config.contains("always"), "no se persiste ninguna aprobación");

    *answer.lock().unwrap() = "deny";
    turn("guarda la clave").await;
    let card = approvals(&events).remove(0);
    let args = card["args"].as_str().unwrap();
    assert!(args.contains("rm -rf ~/Documentos"), "la orden se ve entera");
    assert!(!args.contains("AbCdEf0123456789AbCdEf"), "solo se oculta el fragmento con aspecto de clave");
    assert_eq!(card["redacted"], true);
    assert!(!work.join("script.sh").exists());

    // Another profile's credentials: blocked outright, without a card that could be allowed.
    let other = turn("lee el otro perfil").await;
    assert!(!other["reply"].as_str().unwrap().contains("CANARY_OTHER_PROFILE"));
    assert!(approvals(&events).is_empty(), "no se puede ni permitir");
    // The user's own credentials (private keys and the like) are read only after «Permitir».
    let private = turn("lee mi clave privada").await;
    assert_eq!(approvals(&events)[0]["tool"], "read_file");
    assert!(!private["reply"].as_str().unwrap().contains("CANARY_PRIVATE_KEY"));

    let lasting = turn("programa un trabajo en segundo plano").await;
    assert!(lasting["reply"].as_str().unwrap().contains("segundo plano"));
    assert!(approvals(&events).is_empty(), "se bloquea sin tarjeta: no se puede permitir");
    worker::stop(key);
}

#[test]
fn las_credenciales_del_perfil_principal_no_quedan_en_el_entorno_heredado() {
    let Some((installation, python)) = hermes() else { return eprintln!("Hermes no instalado: se omite") };
    let (_dir, base) = temp();
    fs::create_dir(base.join(".hermes")).unwrap();
    // A dummy variable that only the main profile's dotenv file has.
    fs::write(base.join(".hermes").join([".", "env"].concat()), "AGORA_CANARY_ROOT=presente\n").unwrap();
    let module = base.join("modulos");
    fs::create_dir(&module).unwrap();
    fs::write(module.join("hermes_agent_bridge.py"), AGENT_BRIDGE).unwrap();
    let code = [
        "import sys, os".to_string(),
        format!("sys.path.insert(0, {})", json!(installation)),
        format!("sys.path.insert(0, {})", json!(module)),
        "import hermes_agent_bridge as bridge".into(),
        "bridge.isolate_environment()".into(),
        "print('importar', 'AGORA_CANARY_ROOT' in os.environ, file=sys.stderr)".into(),
        "from gateway.run import _current_max_iterations".into(),
        "_current_max_iterations()".into(),
        "print('turno', 'AGORA_CANARY_ROOT' in os.environ, file=sys.stderr)".into(),
    ]
    .join("\n");
    let mut command = tokio::process::Command::new(python);
    command
        .args(["-X", "utf8", "-I", "-c", &code])
        .current_dir(&base)
        .env_clear()
        .env("HOME", &base)
        .env("USERPROFILE", &base)
        .env("HERMES_HOME", base.join(".hermes"))
        .env("PATH", agora_server::hermes::python::user_path());
    agora_server::platform::apply_minimal_os_env(&mut command);
    let output = tokio::runtime::Runtime::new().unwrap().block_on(command.output()).unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("importar False"), "tras importar Hermes no queda en el entorno");
    assert!(stderr.contains("turno False"), "la recarga por turno no la vuelve a cargar");
}

