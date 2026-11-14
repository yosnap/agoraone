//! `/api/library/*`: the examples and this browser's own copies (listing, reading, importing, renaming and
//! deleting). Any other method or path under /api/library is refused.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{Value, json};

use super::extract::{extract_upload, is_binary};
use super::{Document, LibraryError, UNAVAILABLE, list_examples, read_example, valid_name, valid_title};
use crate::AppState;
use crate::hermes::write_routes::object;
use crate::security::{Owner, error};

const UPLOAD_LIMIT: usize = 7 * 1024 * 1024;
const MAX_UPLOAD_BASE64: usize = 6_990_508;

/// An example or one of this owner's copies, by id.
pub fn read_document(state: &AppState, id: &str, owner: &str) -> Result<Document, LibraryError> {
    if id.starts_with("import-") { state.library.read(id, owner) } else { read_example(&state.config.examples, id) }
}

pub async fn list(State(state): State<Arc<AppState>>, Extension(Owner(owner)): Extension<Owner>) -> Response {
    let mut documents = serde_json::to_value(list_examples()).unwrap_or_default();
    let own = tokio::task::spawn_blocking(move || state.library.list(&owner)).await.unwrap_or_default();
    if let (Value::Array(all), Ok(Value::Array(own))) = (&mut documents, serde_json::to_value(own)) {
        all.extend(own);
    }
    Json(json!({ "resourceId": "library-test", "permissions": ["read"], "documents": documents })).into_response()
}

pub async fn read(State(state): State<Arc<AppState>>, Extension(Owner(owner)): Extension<Owner>, Path(id): Path<String>) -> Response {
    match tokio::task::spawn_blocking(move || read_document(&state, &id, &owner)).await {
        Ok(Ok(document)) => Json(document).into_response(),
        _ => error(StatusCode::NOT_FOUND, UNAVAILABLE),
    }
}

pub async fn import(State(state): State<Arc<AppState>>, Extension(Owner(owner)): Extension<Owner>, body: Bytes) -> Response {
    let map = match object(&body, UPLOAD_LIMIT) {
        Ok(map) => map,
        Err(refusal) => return *refusal,
    };
    let text = |key: &str| map.get(key).and_then(Value::as_str);
    let upload = match (text("name"), text("base64")) {
        (Some(name), Some(base64)) if map.len() == 2 && valid_name(name) && (4..=MAX_UPLOAD_BASE64).contains(&base64.len()) => (name.to_string(), base64.to_string()),
        _ => return error(StatusCode::BAD_REQUEST, "Elige TXT, Markdown, PDF o DOCX. No se permiten rutas ni campos adicionales."),
    };
    let (name, base64) = upload;
    let extracted = match extract_upload(state.config.extractor.as_ref(), &name, &base64).await {
        Ok(extracted) => extracted,
        Err(message) => {
            let message = if is_binary(&name) { message } else { "Texto no válido. Usa UTF-8 y un máximo de 24 KiB.".into() };
            return error(StatusCode::BAD_REQUEST, &message);
        }
    };
    match tokio::task::spawn_blocking(move || state.library.import(&name, &extracted, &owner)).await {
        Ok(Ok(document)) => (StatusCode::CREATED, Json(document)).into_response(),
        _ => error(StatusCode::BAD_REQUEST, "No se pudo guardar la copia. Comprueba el límite de 100 documentos."),
    }
}

pub async fn rename(State(state): State<Arc<AppState>>, Extension(Owner(owner)): Extension<Owner>, Path(id): Path<String>, body: Bytes) -> Response {
    let map = match object(&body, 16 * 1024) {
        Ok(map) => map,
        Err(refusal) => return *refusal,
    };
    let title = match (map.len(), map.get("title").and_then(Value::as_str).and_then(valid_title)) {
        (1, Some(title)) => title,
        _ => return error(StatusCode::BAD_REQUEST, "Escribe un nombre de 1 a 160 caracteres, sin rutas."),
    };
    match tokio::task::spawn_blocking(move || state.library.rename(&id, &owner, &title)).await {
        Ok(Ok(document)) => Json(document).into_response(),
        _ => error(StatusCode::NOT_FOUND, "No se puede renombrar esta copia. No existe o no te pertenece."),
    }
}

pub async fn delete(State(state): State<Arc<AppState>>, Extension(Owner(owner)): Extension<Owner>, Path(id): Path<String>) -> Response {
    let target = id.clone();
    match tokio::task::spawn_blocking(move || state.library.delete(&target, &owner)).await {
        Ok(Ok(())) => Json(json!({ "deleted": id })).into_response(),
        _ => error(StatusCode::NOT_FOUND, "No se puede eliminar esta copia. No existe o no te pertenece."),
    }
}

pub async fn not_allowed() -> Response {
    error(StatusCode::METHOD_NOT_ALLOWED, "Operación no disponible en la biblioteca.")
}
