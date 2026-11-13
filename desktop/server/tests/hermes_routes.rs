//! /api/hermes reads through the router: CSRF on GET too, opaque ids only, and the catalog with its vaults.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use agora_server::access::proof;
use agora_server::hermes::location::HermesLocation;
use agora_server::{AppState, Config, router};
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const TOKEN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HOST: &str = "127.0.0.1:4317";

fn state() -> (tempfile::TempDir, Arc<AppState>) {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::create_dir_all(root.join("memories")).unwrap();
    fs::write(root.join("SOUL.md"), "# Hermes de prueba\napi_key: CANARY").unwrap();
    let vault = root.join("Notas");
    fs::create_dir(&vault).unwrap();
    fs::write(root.join("obsidian.json"), json!({ "vaults": { "a": { "path": vault } } }).to_string()).unwrap();
    let hermes = HermesLocation { root: root.clone(), installation: root.join("hermes-agent"), python: root.join("python"), source: "test".into() };
    let config = Config { data: root.clone(), web: root.clone(), hosts: vec![HOST.into()], hermes, obsidian_registry: Some(root.join("obsidian.json")), examples: PathBuf::from("/no-examples"), extractor: None };
    (dir, AppState::new(config, TOKEN, None))
}

async fn get(state: &Arc<AppState>, path: &str, csrf: Option<&str>) -> (StatusCode, Value) {
    let mut request = Request::get(path).header(header::HOST, HOST).header(header::COOKIE, format!("agora_access={}", proof(TOKEN)));
    if let Some(csrf) = csrf {
        request = request.header("x-agora-csrf", csrf);
    }
    let response = router(state.clone()).oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

#[tokio::test]
async fn hermes_reads_need_csrf_and_only_take_opaque_ids() {
    let (_dir, state) = state();
    let (status, _) = get(&state, "/api/hermes/catalog", None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let csrf = state.csrf.clone();
    let (status, catalog) = get(&state, "/api/hermes/catalog", Some(&csrf)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(catalog["profiles"][0]["label"], "Hermes de prueba");
    assert_eq!(catalog["vaults"][0]["name"], "Notas");
    assert!(!catalog.to_string().contains("CANARY"));
    let id = catalog["profiles"][0]["id"].as_str().unwrap().to_string();
    let (status, detail) = get(&state, &format!("/api/hermes/profiles/{id}"), Some(&csrf)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["files"][0]["hidden"], 1);
    let (status, body) = get(&state, "/api/hermes/profiles/..%2F.env", Some(&csrf)).await;
    assert_eq!((status, body), (StatusCode::NOT_FOUND, json!({ "error": "Perfil no disponible para lectura." })));
    let (status, _) = get(&state, &format!("/api/hermes/profiles/{id}/mcp/mcp-000/tools"), Some(&csrf)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, activity) = get(&state, "/api/hermes/activity", Some(&csrf)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(activity["gateway"]["state"], "missing");
    let (status, summary) = get(&state, "/api/hermes/summary", Some(&csrf)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(summary["days"], 30);
}

async fn send(state: &Arc<AppState>, method: &str, path: &str, csrf: bool, body: &str) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, HOST)
        .header(header::ORIGIN, format!("http://{HOST}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, format!("agora_access={}", proof(TOKEN)));
    if csrf {
        request = request.header("x-agora-csrf", state.csrf.clone());
    }
    let response = router(state.clone()).oneshot(request.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn hermes_writes_need_csrf_and_strict_bodies() {
    let (_dir, state) = state();
    let (_, catalog) = get(&state, "/api/hermes/catalog", Some(&state.csrf.clone())).await;
    let id = catalog["profiles"][0]["id"].as_str().unwrap().to_string();
    let soul = state.config.hermes.root.join("SOUL.md");
    let revision = agora_server::hermes::catalog::file_revision(&fs::read_to_string(&soul).unwrap());
    let file = format!("/api/hermes/profiles/{id}/files/SOUL.md");
    let edit = json!({ "content": "# Hermes de prueba\n[línea oculta 1]\nNueva línea", "revision": revision }).to_string();
    assert_eq!(send(&state, "PUT", &file, false, &edit).await.0, StatusCode::FORBIDDEN);
    let extra = json!({ "content": "x", "revision": revision, "otro": 1 }).to_string();
    assert_eq!(send(&state, "PUT", &file, true, &extra).await, (StatusCode::BAD_REQUEST, json!({ "error": "Edición no válida." })));
    let other = format!("/api/hermes/profiles/{id}/files/config.yaml");
    assert_eq!(send(&state, "PUT", &other, true, &edit).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&state, "PUT", &file, true, "{roto").await.0, StatusCode::BAD_REQUEST);
    let huge = json!({ "content": "x".repeat(300_000), "revision": revision }).to_string();
    assert_eq!(send(&state, "PUT", &file, true, &huge).await.0, StatusCode::PAYLOAD_TOO_LARGE);
    if agora_server::hermes::python::system_python().is_some() {
        let (status, saved) = send(&state, "PUT", &file, true, &edit).await;
        assert_eq!(status, StatusCode::OK, "{saved}");
        assert_eq!(fs::read_to_string(&soul).unwrap(), "# Hermes de prueba\napi_key: CANARY\nNueva línea");
        assert!(state.config.data.join("profile-backups").join(&id).exists(), "copia previa en .agora");
    }
    let jobs = format!("/api/hermes/profiles/{id}/jobs");
    assert_eq!(send(&state, "POST", &jobs, true, r#"{"name":"  ","schedule":"every 1h","prompt":"x"}"#).await.1, json!({ "error": "Indica nombre, horario e instrucciones de la tarea." }));
    assert_eq!(send(&state, "POST", "/api/hermes/profiles/otro/jobs", true, "{}").await.0, StatusCode::NOT_FOUND);
    let job = format!("/api/hermes/profiles/{id}/jobs/tarea-1");
    assert_eq!(send(&state, "POST", &job, true, r#"{"action":"update","prompt":"sin revisión"}"#).await.1, json!({ "error": "Operación no válida." }));
    assert_eq!(send(&state, "POST", &format!("{job}/../x"), true, r#"{"action":"pause"}"#).await.0, StatusCode::NOT_FOUND);
    let card = format!("/api/hermes/profiles/{id}/cards/c-1");
    assert_eq!(send(&state, "POST", &card, true, r#"{"action":"comment","body":"   "}"#).await.0, StatusCode::BAD_REQUEST);
    let skills = format!("/api/hermes/profiles/{id}/skills");
    let bad = json!({ "category": "a/b", "name": "x", "description": "", "body": "x" }).to_string();
    assert_eq!(send(&state, "POST", &skills, true, &bad).await.0, StatusCode::BAD_REQUEST);
    let (status, listing) = get(&state, &skills, Some(&state.csrf.clone())).await;
    assert_eq!((status, listing), (StatusCode::OK, json!({ "skills": [], "truncated": false })));
    let call = format!("/api/hermes/profiles/{id}/mcp/mcp-x/tools/eco/call");
    assert_eq!(send(&state, "POST", &call, true, r#"{"args":[]}"#).await.1, json!({ "error": "Argumentos no válidos." }));
    assert_eq!(send(&state, "POST", &call, true, r#"{"args":{}}"#).await.0, StatusCode::NOT_FOUND);
}
