//! `/api/hermes/*` reads. They run off the async workers (SQLite and file reads are blocking) with a run
//! limit, and at most a few heavy reads wait at once, like the former background worker.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use tokio::sync::Semaphore;

use super::activity::read_activity;
use super::resources::obsidian_vaults;
use super::summary::read_hermes_summary;
use crate::AppState;
use crate::js::now_ms;
use crate::security::error;

const RUN_LIMIT: Duration = Duration::from_secs(20);
static QUEUE: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(8));

/// Runs a blocking read; None if it failed, took too long or too many are already waiting.
pub(crate) async fn background<T: Send + 'static>(read: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> Option<T> {
    let _permit = QUEUE.try_acquire().ok()?;
    match tokio::time::timeout(RUN_LIMIT, tokio::task::spawn_blocking(read)).await {
        Ok(Ok(Ok(value))) => Some(value),
        _ => None,
    }
}

fn answer(value: Option<Value>, status: StatusCode, message: &str) -> Response {
    match value {
        Some(value) => Json(value).into_response(),
        None => error(status, message),
    }
}

pub async fn catalog(State(state): State<Arc<AppState>>) -> Response {
    let value = background(move || {
        let catalog = state.hermes.scan(false);
        let obsidian = obsidian_vaults(state.config.obsidian_registry.as_deref());
        let mut value = serde_json::to_value(&catalog)?;
        value["vaults"] = serde_json::to_value(&obsidian.vaults)?;
        let mut warnings = catalog.warnings;
        warnings.extend(obsidian.warnings);
        value["warnings"] = serde_json::to_value(warnings)?;
        Ok(value)
    })
    .await;
    answer(value, StatusCode::SERVICE_UNAVAILABLE, "No se pudo leer el catálogo de Hermes.")
}

pub async fn activity(State(state): State<Arc<AppState>>) -> Response {
    let value = background(move || {
        let (root, profiles) = state.hermes.activity_targets()?;
        Ok(read_activity(&root, &profiles, now_ms()))
    })
    .await;
    answer(value, StatusCode::SERVICE_UNAVAILABLE, "No se pudo leer la actividad de Hermes.")
}

/// Tokens per profile and project and the user's most used words, for the summary: counts only.
pub async fn summary(State(state): State<Arc<AppState>>) -> Response {
    let value = background(move || {
        let (root, profiles) = state.hermes.activity_targets()?;
        Ok(read_hermes_summary(&root, &profiles, now_ms()))
    })
    .await;
    answer(value, StatusCode::SERVICE_UNAVAILABLE, "No se pudo leer el resumen de Hermes.")
}

/// ?reveal=1 shows hidden credential-like lines. Under /api/hermes, so the CSRF header is required on GET too.
pub async fn profile(State(state): State<Arc<AppState>>, Path(id): Path<String>, Query(query): Query<HashMap<String, String>>) -> Response {
    let reveal = query.get("reveal").is_some_and(|v| v == "1");
    let value = background(move || state.hermes.detail(&id, reveal)).await;
    answer(value, StatusCode::NOT_FOUND, "Perfil no disponible para lectura.")
}

pub async fn mcp_tools(State(state): State<Arc<AppState>>, Path((id, server)): Path<(String, String)>) -> Response {
    let value = background(move || Ok(serde_json::to_value(state.hermes.mcp_tools(&id, &server)?)?)).await;
    answer(value, StatusCode::NOT_FOUND, "Servidor MCP no disponible en este perfil.")
}
