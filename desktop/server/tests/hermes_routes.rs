//! /api/hermes reads through the router: CSRF on GET too, opaque ids only, and the catalog with its vaults.

use std::fs;
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
    let config = Config { data: root.clone(), web: root.clone(), hosts: vec![HOST.into()], hermes, obsidian_registry: Some(root.join("obsidian.json")) };
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
