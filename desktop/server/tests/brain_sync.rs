//! Ported from server/brain-sync.test.ts against a stand-in for the core's internal index routes.

#[path = "support/test_links.rs"]
mod test_links;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agora_server::brain_sync::{BrainSync, SyncReport};
use agora_server::core::CoreLink;
use agora_server::platform::canonicalize;
use test_links::{create_test_link as symlink};
use agora_server::vault::VaultNotes;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde_json::{Value, json};

const SECRET: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

#[derive(Default)]
struct Fake {
    calls: Vec<(String, Value, String)>,
    refs: HashMap<String, String>,
    reject: String,
}

type Shared = Arc<Mutex<Fake>>;

async fn answer(State(fake): State<Shared>, request: Request) -> Response {
    let path = request.uri().to_string();
    let secret = request.headers().get("x-agora-core-secret").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let bytes = axum::body::to_bytes(request.into_body(), 4 << 20).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let mut fake = fake.lock().unwrap();
    fake.calls.push((path.clone(), body.clone(), secret));
    if path.starts_with("/internal/index/state") {
        return Json(json!({ "refs": fake.refs })).into_response();
    }
    match path.as_str() {
        "/internal/index/notes" if body["source"] == fake.reject.as_str() => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({}))).into_response(),
        "/internal/index/notes" => {
            for note in body["notes"].as_array().unwrap() {
                fake.refs.insert(note["ref"].as_str().unwrap().into(), note["revision"].as_str().unwrap().into());
            }
            Json(json!({ "indexed": body["notes"].as_array().unwrap().len() })).into_response()
        }
        "/internal/index/sources" => Json(json!({ "removed": 0 })).into_response(),
        "/internal/index/remove" => {
            let refs = body["refs"].as_array().unwrap();
            for r in refs {
                fake.refs.remove(r.as_str().unwrap());
            }
            Json(json!({ "removed": refs.len() })).into_response()
        }
        _ => (StatusCode::NOT_FOUND, Json(json!({}))).into_response(),
    }
}

async fn fake_core() -> (Shared, String) {
    let fake = Shared::default();
    let app = Router::new().fallback(answer).with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (fake, url)
}

fn sync(registry: PathBuf, url: &str) -> Arc<BrainSync> {
    let vault = Arc::new(VaultNotes::new(Some(registry.clone())));
    BrainSync::new(vault, CoreLink { url: url.into(), secret: SECRET.into() }, Some(registry), reqwest::Client::new())
}

fn base() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let base = canonicalize(dir.path()).unwrap();
    (dir, base)
}

fn sent_notes(fake: &Shared) -> Vec<Value> {
    let fake = fake.lock().unwrap();
    fake.calls.iter().filter(|c| c.0 == "/internal/index/notes").flat_map(|c| c.1["notes"].as_array().unwrap().clone()).collect()
}

#[tokio::test]
async fn el_indice_recibe_texto_enmascarado_incremental_y_retira_lo_borrado() {
    let (_dir, base) = base();
    let vault = base.join("vault");
    fs::create_dir_all(vault.join("Proyectos")).unwrap();
    fs::create_dir(vault.join(".obsidian")).unwrap();
    fs::write(vault.join("Proyectos/Agora.md"), "# Agora\n\nEl cerebro de la oficina.\napi_key = CANARY_BRAIN_KEY\nFin.").unwrap();
    fs::write(vault.join("Diario.md"), "Hoy toca la ponencia.").unwrap();
    fs::write(vault.join("Enorme.md"), "x".repeat(300 * 1024)).unwrap();
    fs::write(vault.join(".obsidian/config.md"), "oculto").unwrap();
    fs::write(base.join("fuera.md"), "fuera del vault").unwrap();
    symlink(base.join("fuera.md"), vault.join("Enlace.md")).unwrap();
    fs::write(base.join("obsidian.json"), json!({ "vaults": { "a": { "path": vault } } }).to_string()).unwrap();
    let (fake, url) = fake_core().await;
    let sync = sync(base.join("obsidian.json"), &url);

    let first = sync.sync().await.unwrap();
    assert_eq!(first, SyncReport { vaults: 1, sent: 2, removed: 0, skipped: 1, failed: 0 });
    let sent = sent_notes(&fake);
    let mut titles: Vec<&str> = sent.iter().map(|n| n["title"].as_str().unwrap()).collect();
    titles.sort();
    assert_eq!(titles, ["Agora", "Diario"]);
    let agora = sent.iter().find(|n| n["title"] == "Agora").unwrap()["text"].as_str().unwrap();
    assert!(!agora.contains("CANARY"), "la línea con la clave no sale del servidor");
    assert!(agora.contains("[línea oculta 1]"));
    {
        let fake = fake.lock().unwrap();
        assert!(fake.calls.iter().all(|c| c.2 == SECRET));
        assert!(!format!("{:?}", fake.calls).contains("fuera del vault"), "ni enlaces simbólicos ni carpetas ocultas");
    }
    assert_eq!(sync.sync().await.unwrap().sent, 0, "sin cambios no se reenvía nada");

    fs::remove_file(vault.join("Diario.md")).unwrap();
    fs::write(vault.join("Proyectos/Agora.md"), "# Agora\n\nCambiado y más largo que antes.").unwrap();
    let third = sync.sync().await.unwrap();
    assert_eq!((third.sent, third.removed), (1, 1));
    assert_eq!(fake.lock().unwrap().refs.len(), 1);
}

#[tokio::test]
async fn sin_vaults_solo_se_retira_y_si_el_nucleo_falla_lo_dice() {
    let (_dir, base) = base();
    fs::create_dir(base.join("vault")).unwrap();
    fs::write(base.join("vault/Nota.md"), "hola").unwrap();
    let (fake, url) = fake_core().await;
    let none = sync(base.join("no-existe.json"), &url);
    assert_eq!(none.sync().await.unwrap(), SyncReport::default());
    let paths: Vec<String> = fake.lock().unwrap().calls.iter().map(|c| c.0.clone()).collect();
    assert_eq!(paths, ["/internal/index/sources"], "sin vaults solo se retira lo que ya no está");
    fs::write(base.join("obsidian.json"), json!({ "vaults": { "a": { "path": base.join("vault") } } }).to_string()).unwrap();
    let down = sync(base.join("obsidian.json"), "http://127.0.0.1:9");
    let error = down.sync().await.unwrap_err().to_string();
    assert!(error.contains("núcleo"), "{error}");
}

#[tokio::test]
async fn un_vault_que_falla_no_deja_sin_indexar_a_los_demas() {
    let (_dir, base) = base();
    for name in ["uno", "dos"] {
        fs::create_dir(base.join(name)).unwrap();
        fs::write(base.join(name).join("Nota.md"), format!("nota de {name}")).unwrap();
    }
    let secret_note = if cfg!(windows) { "dos/password = hunter2.md" } else { "dos/password: hunter2.md" };
    fs::write(base.join(secret_note), "título con pinta de clave").unwrap();
    let vaults = json!({ "vaults": { "a": { "path": base.join("uno") }, "b": { "path": base.join("dos") } } });
    fs::write(base.join("obsidian.json"), vaults.to_string()).unwrap();
    let (fake, url) = fake_core().await;
    let sync = sync(base.join("obsidian.json"), &url);
    let first = sync.sync().await.unwrap();
    assert_eq!((first.vaults, first.failed), (2, 0));
    let keep: Vec<String> = {
        let fake = fake.lock().unwrap();
        let call = fake.calls.iter().find(|c| c.0 == "/internal/index/sources").unwrap();
        call.1["keep"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect()
    };
    assert_eq!(keep.len(), 2, "se conservan los dos vaults registrados");
    let titles: Vec<String> = sent_notes(&fake).iter().map(|n| n["title"].as_str().unwrap().to_string()).collect();
    assert!(titles.contains(&"[nombre oculto]".to_string()) && !titles.iter().any(|t| t.contains("hunter2")), "un título con pinta de clave no sale");

    // The core now rejects the first vault's notes; the second must still be indexed.
    let before = {
        let mut fake = fake.lock().unwrap();
        fake.reject = keep[0].clone();
        fake.refs.clear();
        fake.calls.len()
    };
    let second = sync.sync().await.unwrap();
    assert_eq!((second.failed, second.vaults), (1, 1));
    let fake = fake.lock().unwrap();
    assert!(fake.calls[before..].iter().any(|c| c.0 == "/internal/index/notes" && c.1["source"] != keep[0].as_str()), "el otro vault se indexó igualmente");
}
