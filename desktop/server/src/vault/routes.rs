//! `/api/hermes/vaults/*`: reads run off the async workers with the same limits as Hermes' reads; edits and
//! new notes write the user's real Obsidian notes (user's decision, 18/10/2026), CSRF-protected like every
//! /api/hermes request, revision-checked and backed up first.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Semaphore;

use super::{NOTE_UNAVAILABLE, NoteEdit, NoteMove};
use crate::AppState;
use crate::hermes::routes::background;
use crate::hermes::write_routes::{Fields, object};
use crate::js::{js_trim, utf16_len};
use crate::security::{Failure, error};

static REVISION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-f0-9]{64}$").unwrap());
const WRITE_LIMIT: usize = 384 * 1024;
const WRITE_TIME: Duration = Duration::from_secs(30);
/// One write at a time; the others wait here, without holding a thread, until their time limit.
static WRITING: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(1)));

async fn read<T: Serialize + Send + 'static>(run: impl FnOnce() -> Result<T, Failure> + Send + 'static, message: &str) -> Response {
    match background(move || Ok(run()?)).await {
        Some(value) => Json(value).into_response(),
        None => error(StatusCode::NOT_FOUND, message),
    }
}

/// Writes a note with a time limit. A write already under way cannot be stopped and may still finish,
/// so the answer asks to reload rather than saying it failed; it keeps its turn until it really ends.
async fn write<T: Serialize + Send + 'static>(run: impl FnOnce() -> Result<T, Failure> + Send + 'static, created: StatusCode) -> Response {
    let attempt = tokio::time::timeout(WRITE_TIME, async {
        let turn = WRITING.clone().acquire_owned().await.ok()?;
        tokio::task::spawn_blocking(move || {
            let _turn = turn;
            run()
        })
        .await
        .ok()
    });
    match attempt.await {
        Ok(Some(Ok(value))) => (created, Json(value)).into_response(),
        Ok(Some(Err(failure))) => failure.into_response(),
        Ok(None) => error(StatusCode::INTERNAL_SERVER_ERROR, "No se pudo guardar la nota."),
        Err(_) => error(StatusCode::GATEWAY_TIMEOUT, "El disco tarda demasiado en responder. Recarga la nota para comprobar si se guardó."),
    }
}

pub async fn list(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    read(move || state.vault.list(&id, false), "Vault no disponible.").await
}

pub async fn note(State(state): State<Arc<AppState>>, Path((id, note)): Path<(String, String)>, Query(query): Query<HashMap<String, String>>) -> Response {
    let reveal = query.get("reveal").is_some_and(|v| v == "1");
    read(move || state.vault.read(&id, &note, reveal), NOTE_UNAVAILABLE).await
}

pub async fn search(State(state): State<Arc<AppState>>, Path(id): Path<String>, Query(query): Query<HashMap<String, String>>) -> Response {
    let text = query.get("q").map(|q| js_trim(q).to_string()).filter(|q| (2..=100).contains(&utf16_len(q)));
    let Some(text) = text else { return error(StatusCode::BAD_REQUEST, "Escribe entre 2 y 100 caracteres.") };
    read(move || state.vault.search(&id, &text), "Vault no disponible.").await
}

pub async fn save(State(state): State<Arc<AppState>>, Path((id, note)): Path<(String, String)>, body: Bytes) -> Response {
    let map = match object(&body, WRITE_LIMIT) {
        Ok(map) => map,
        Err(refusal) => return *refusal,
    };
    let f = Fields(&map);
    let edit = (|| {
        f.only(&["content", "revision", "revealed"])?;
        let revision = map.get("revision").and_then(Value::as_str).filter(|r| REVISION.is_match(r)).ok_or(())?;
        Ok::<_, ()>(NoteEdit { content: f.required("content", 0, 300_000, false)?, revision: revision.into(), revealed: f.flag("revealed")? })
    })();
    let Ok(edit) = edit else { return error(StatusCode::BAD_REQUEST, "Contenido no válido.") };
    let backups = state.config.data.join("vault-backups");
    write(move || state.vault.save(&id, &note, edit, &backups), StatusCode::OK).await
}

pub async fn create(State(state): State<Arc<AppState>>, Path(id): Path<String>, body: Bytes) -> Response {
    let map = match object(&body, WRITE_LIMIT) {
        Ok(map) => map,
        Err(refusal) => return *refusal,
    };
    let f = Fields(&map);
    let fields = (|| {
        f.only(&["folder", "title", "content"])?;
        Ok::<_, ()>((f.required("folder", 0, 1000, false)?, f.required("title", 0, 200, false)?, f.required("content", 0, 300_000, false)?))
    })();
    let Ok((folder, title, content)) = fields else { return error(StatusCode::BAD_REQUEST, "Datos de la nota no válidos.") };
    write(move || state.vault.create(&id, &folder, &title, &content), StatusCode::CREATED).await
}

const FILE_LIMIT: usize = 25 * 1024 * 1024;

/// A mail's attachment or shared document next to its note: the bytes as the body, the folder and name in the query.
pub async fn create_file(State(state): State<Arc<AppState>>, Path(id): Path<String>, Query(query): Query<HashMap<String, String>>, body: Bytes) -> Response {
    let (Some(folder), Some(name)) = (query.get("folder").cloned(), query.get("name").cloned()) else {
        return error(StatusCode::BAD_REQUEST, "Datos del archivo no válidos.");
    };
    if body.is_empty() || body.len() > FILE_LIMIT || folder.len() > 1000 || name.len() > 255 {
        return error(StatusCode::BAD_REQUEST, "El archivo está vacío o es demasiado grande (hasta 25 MB).");
    }
    write(move || state.vault.create_file(&id, &folder, &name, &body), StatusCode::CREATED).await
}

// Moving and renaming notes (user's decision, 13/11/2026): same guarantees, never overwriting another note.
pub async fn move_note(State(state): State<Arc<AppState>>, Path((id, note)): Path<(String, String)>, body: Bytes) -> Response {
    let map = match object(&body, 16 * 1024) {
        Ok(map) => map,
        Err(refusal) => return *refusal,
    };
    let f = Fields(&map);
    let target = (|| {
        f.only(&["folder", "title", "revision"])?;
        let revision = map.get("revision").and_then(Value::as_str).filter(|r| REVISION.is_match(r)).ok_or(())?;
        Ok::<_, ()>(NoteMove { folder: f.required("folder", 0, 1000, false)?, title: f.required("title", 0, 200, false)?, revision: revision.into() })
    })();
    let Ok(target) = target else { return error(StatusCode::BAD_REQUEST, "Datos del cambio no válidos.") };
    let backups = state.config.data.join("vault-backups");
    write(move || state.vault.move_note(&id, &note, target, &backups), StatusCode::OK).await
}
