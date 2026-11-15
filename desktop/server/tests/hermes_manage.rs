//! Ported from server/hermes-manage.test.ts and mcp-call.test.ts: Hermes' real functions on fictitious
//! profiles (the user's tasks, board, profiles and services are never touched). Skipped where Hermes is not
//! installed.

use std::fs;
use std::path::{Path, PathBuf};

use agora_server::hermes::activity::read_activity;
use agora_server::hermes::catalog::{HermesDiscovery, ProfileTarget};
use agora_server::hermes::location::HermesLocation;
use agora_server::hermes::manage::{job_detail, manage_card, manage_job};
use agora_server::hermes::mcp_call::call_mcp_tool;
use agora_server::hermes::mcp_tools::mcp_fingerprint;
use agora_server::js::now_ms;
use agora_server::security::Failure;
use serde_json::{Map, Value, json};

fn installation() -> Option<PathBuf> {
    let installation = PathBuf::from(std::env::var("HOME").ok()?).join(".hermes/hermes-agent");
    installation.join("run_agent.py").exists().then_some(installation)
}

fn discovery(root: &Path, installation: &Path) -> HermesDiscovery {
    HermesDiscovery::new(HermesLocation { root: root.into(), installation: installation.into(), python: agora_server::hermes::location::from_env().python, source: "test".into() })
}

fn map(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

fn status<T: std::fmt::Debug>(result: Result<T, Failure>) -> u16 {
    result.unwrap_err().status.as_u16()
}

#[tokio::test]
async fn tasks_and_kanban_through_hermes_only_for_their_profile_keeping_hidden_lines() {
    let Some(installation) = installation() else { return eprintln!("Hermes no instalado") };
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    for name in ["alpha", "beta"] {
        fs::create_dir_all(root.join("profiles").join(name)).unwrap();
        fs::write(root.join("profiles").join(name).join("SOUL.md"), format!("Soy {name}.")).unwrap();
    }
    let d = discovery(&root, &installation);
    let profiles = d.scan(false).profiles;
    let alpha = profiles.iter().find(|p| p.name == "alpha").unwrap().id.clone();
    let beta = profiles.iter().find(|p| p.name == "beta").unwrap().id.clone();
    let target = vec![ProfileTarget { id: alpha.clone(), name: "alpha".into(), home: root.join("profiles/alpha"), mcp: vec![] }];
    let activity = || read_activity(&root, &target, now_ms())["profiles"][&alpha].clone();

    let created = manage_job(&d, &alpha, None, map(json!({ "name": "Resumen", "schedule": "every 2h", "prompt": "Resume mis notas\napi_key: CANARY_JOB_KEY" }))).await.unwrap();
    let job = created["job"].as_str().unwrap().to_string();
    assert!(root.join("profiles/alpha/cron/jobs.json").exists(), "en el almacén del propio perfil");
    assert!(!root.join("profiles/beta/cron/jobs.json").exists());
    let detail = job_detail(&d, &alpha, &job).await.unwrap();
    assert!(!detail["prompt"].as_str().unwrap().contains("CANARY"));
    assert_eq!(detail["hidden"], 1);
    let prompt = detail["prompt"].as_str().unwrap().replace("Resume", "Ordena");
    manage_job(&d, &alpha, Some(&job), map(json!({ "action": "update", "prompt": prompt, "revision": detail["revision"] }))).await.unwrap();
    // Instructions changed since they were opened: the old revision no longer saves.
    let stale = manage_job(&d, &alpha, Some(&job), map(json!({ "action": "update", "prompt": "pisado", "revision": detail["revision"] }))).await;
    assert_eq!(status(stale), 409);
    let stored = fs::read_to_string(root.join("profiles/alpha/cron/jobs.json")).unwrap();
    assert!(stored.contains("Ordena mis notas") && stored.contains("CANARY_JOB_KEY"), "la línea oculta vuelve del almacén");
    manage_job(&d, &alpha, Some(&job), map(json!({ "action": "pause" }))).await.unwrap();
    assert_eq!(activity()["jobs"][0]["id"], Value::String(job.clone()));
    assert_eq!(activity()["jobs"][0]["enabled"], false);
    manage_job(&d, &alpha, Some(&job), map(json!({ "action": "resume" }))).await.unwrap();
    manage_job(&d, &alpha, Some(&job), map(json!({ "action": "run" }))).await.unwrap();
    // «Run now» only marks it for the gateway: nothing runs here, and nothing is written outside the profile.
    let marked: Value = serde_json::from_str(&fs::read_to_string(root.join("profiles/alpha/cron/jobs.json")).unwrap()).unwrap();
    let list = marked.get("jobs").unwrap_or(&marked).as_array().unwrap();
    let record = list.iter().find(|j| j["id"] == Value::String(job.clone())).unwrap();
    assert!(record.get("last_run_at").is_none_or(Value::is_null), "no se ha ejecutado");
    assert!(record.get("manual_run_at").is_some_and(|v| !v.is_null()), "queda marcada para el siguiente ciclo");
    assert!(!root.join("state.db").exists(), "sin sesión de agente");
    let runs = fs::read_dir(root.join("cron")).map(|e| e.flatten().filter(|f| f.file_name().to_string_lossy().contains("executions") || f.file_name() == "jobs.json").count()).unwrap_or(0);
    assert_eq!(runs, 0, "sin ejecuciones");
    let once = manage_job(&d, &alpha, None, map(json!({ "name": "Recordatorio", "schedule": "in 30m", "prompt": "Recuérdamelo" }))).await.unwrap()["job"].as_str().unwrap().to_string();
    assert_eq!(job_detail(&d, &alpha, &once).await.unwrap()["once"], true);
    manage_job(&d, &alpha, Some(&once), map(json!({ "action": "update", "name": "Recordatorio editado" }))).await.unwrap();
    manage_job(&d, &alpha, Some(&once), map(json!({ "action": "remove" }))).await.unwrap();
    assert_eq!(status(manage_job(&d, &beta, Some(&job), map(json!({ "action": "remove" }))).await), 404);
    manage_job(&d, &alpha, Some(&job), map(json!({ "action": "remove" }))).await.unwrap();
    assert_eq!(activity()["jobs"][0], Value::Null);
    let bad = manage_job(&d, &alpha, None, map(json!({ "name": "Mala", "schedule": "cuando quieras", "prompt": "x" }))).await.unwrap_err();
    assert_eq!(bad.status.as_u16(), 400);
    assert!(bad.message.contains("no reconoce ese horario"), "el error llega en castellano");

    let card = manage_card(&d, &alpha, None, map(json!({ "title": "Revisar presupuesto", "body": "detalle" }))).await.unwrap()["card"].as_str().unwrap().to_string();
    assert_eq!(activity()["board"]["open"][0]["id"], Value::String(card.clone()));
    assert_eq!(status(manage_card(&d, &beta, Some(&card), map(json!({ "action": "archive" }))).await), 404);
    for change in [json!({ "action": "comment", "body": "Desde la prueba" }), json!({ "action": "block", "reason": "Esperando datos" }), json!({ "action": "unblock" }), json!({ "action": "complete" })] {
        manage_card(&d, &alpha, Some(&card), map(change)).await.unwrap();
    }
    assert_eq!(activity()["board"]["open"].as_array().unwrap().len(), 0);
    assert_eq!(status(manage_card(&d, &alpha, Some("no-existe"), map(json!({ "action": "complete" }))).await), 404);
    let unknown = format!("profile-{}", "0".repeat(24));
    assert_eq!(status(manage_job(&d, &unknown, None, map(json!({ "name": "x", "schedule": "every 1h", "prompt": "x" }))).await), 404);
}

const ECHO_SERVER: &str = r#"import os
from mcp.server.mcpserver import MCPServer
app = MCPServer("eco")

@app.tool()
def eco(texto: str, veces: int = 1) -> str:
    "Devuelve el texto repetido."
    return " ".join([texto] * veces) + "\napi_key: CANARY_MCP_RESULT"

@app.tool()
def entorno() -> str:
    "Dice si ve la variable que solo tiene el perfil principal."
    return os.environ.get("AGORA_CANARY_ROOT", "ausente")

if __name__ == "__main__":
    app.run()
"#;

#[tokio::test]
async fn mcp_by_hand_calls_the_catalogue_tool_with_the_profile_credentials_and_leaves_no_process() {
    let Some(installation) = installation() else { return eprintln!("Hermes no instalado") };
    let python = installation.join("venv/bin/python");
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let home = root.join("profiles/alpha");
    let server = root.join("eco_server.py");
    fs::create_dir_all(home.join("cache")).unwrap();
    fs::write(home.join("SOUL.md"), "Soy alpha.").unwrap();
    fs::write(&server, ECHO_SERVER).unwrap();
    // «untrusted»: Hermes would ask a human for any non-read tool; the user's confirmation in AgoraOne is that human.
    let (p, s) = (python.display(), server.display());
    let config = format!("model:\n  default: x\nmcp_servers:\n  eco:\n    command: {p}\n    args: [\"{s}\"]\n    trust: untrusted\n  apagado:\n    command: {p}\n    args: [\"{s}\"]\n    enabled: false\n");
    fs::write(home.join("config.yaml"), config).unwrap();
    // A credential only the main profile has: the MCP server of another profile must not see it.
    fs::write(root.join(".env"), "AGORA_CANARY_ROOT=presente\n").unwrap();
    let fingerprint = mcp_fingerprint(&map(json!({ "command": python, "args": [server] })));
    let tools = json!([
        { "name": "eco", "description": "Devuelve el texto repetido.", "inputSchema": { "type": "object", "properties": { "texto": { "type": "string" }, "veces": { "type": "integer" } }, "required": ["texto"] } },
        { "name": "entorno", "description": "Variable del perfil principal.", "inputSchema": { "type": "object", "properties": {} } },
    ]);
    let now = now_ms() as f64 / 1000.0;
    let cache = json!({ "eco": { "fingerprint": fingerprint, "written_at": now, "tools": tools }, "apagado": { "fingerprint": fingerprint, "written_at": now, "tools": tools } });
    fs::write(home.join("cache/mcp_schema_cache.json"), cache.to_string()).unwrap();
    let d = discovery(&root, &installation);
    let profile = d.scan(false).profiles.into_iter().find(|p| p.name == "alpha").unwrap();
    let server_id = profile.mcp.iter().find(|m| m.name == "eco").unwrap().id.clone();
    let disabled = profile.mcp.iter().find(|m| m.name == "apagado").unwrap().id.clone();
    let call = |server: String, tool: &'static str, args: Value| {
        let d = &d;
        let id = profile.id.clone();
        async move { call_mcp_tool(d, &id, &server, tool, map(args)).await }
    };
    let answer = call(server_id.clone(), "eco", json!({ "texto": "hola", "veces": 2 })).await.unwrap();
    assert!(answer["result"].as_str().unwrap().contains("hola hola"));
    assert!(!answer["result"].as_str().unwrap().contains("CANARY"), "las líneas con aspecto de clave se ocultan");
    assert_eq!(answer["hidden"], 1);
    assert_eq!(call(server_id.clone(), "entorno", json!({})).await.unwrap()["result"], "ausente", "sin credenciales del perfil principal");
    assert_eq!(status(call(server_id.clone(), "borrar_todo", json!({})).await), 404);
    assert_eq!(status(call("mcp-desconocido".into(), "eco", json!({})).await), 404);
    assert_eq!(status(call(server_id.clone(), "eco", json!({ "veces": 2 })).await), 400);
    assert_eq!(status(call(server_id.clone(), "eco", json!({ "texto": "x", "ruta": "/etc" })).await), 400);
    assert_eq!(status(call(disabled, "eco", json!({ "texto": "x" })).await), 409);
    let ps = std::process::Command::new("/bin/ps").args(["-axo", "command"]).output().unwrap();
    let left = String::from_utf8_lossy(&ps.stdout).lines().filter(|l| l.contains(&server.display().to_string())).count();
    assert_eq!(left, 0, "el servidor MCP se cierra al terminar");
}
