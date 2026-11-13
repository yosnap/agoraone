//! AgoraOne's local server in Rust: the same HTTP contract the browser has always used (`/api/*`), only on
//! 127.0.0.1, behind the access cookie, CSRF, Host and Origin checks (security.rs). The desktop app starts
//! it; it can also run on its own for the browser.

pub mod access;
pub mod core;
pub mod hermes;
pub mod js;
pub mod secret_lines;
pub mod security;

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post, put};
use axum::{Json, Router, middleware};
use serde::Deserialize;
use serde_json::json;
use tower_http::services::ServeDir;

use crate::access::{ACCESS_COOKIE, proof, same_secret};
use crate::core::CoreLink;
use crate::hermes::catalog::HermesDiscovery;
use crate::hermes::location::HermesLocation;
use crate::hermes::write_routes as write;
use crate::security::error;

pub const PORT: u16 = 4317;

#[derive(Clone, Debug)]
pub struct Config {
    /// Where AgoraOne keeps its own data (`.agora` in development).
    pub data: PathBuf,
    /// The compiled web interface.
    pub web: PathBuf,
    /// Host headers accepted (and their http:// origins).
    pub hosts: Vec<String>,
    /// Hermes' data folder and code.
    pub hermes: HermesLocation,
    /// Obsidian's registry of vaults (None: no vaults).
    pub obsidian_registry: Option<PathBuf>,
}

pub struct AppState {
    pub config: Config,
    pub proof: String,
    pub csrf: String,
    pub core: Option<CoreLink>,
    pub http: reqwest::Client,
    pub hermes: HermesDiscovery,
}

impl AppState {
    pub fn new(config: Config, token: &str, core: Option<CoreLink>) -> Arc<Self> {
        let http = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().expect("cliente HTTP");
        let hermes = HermesDiscovery::new(config.hermes.clone());
        Arc::new(Self { config, proof: proof(token), csrf: access::random_hex(), core, http, hermes })
    }
}

#[derive(Deserialize)]
struct SessionBody {
    token: Option<String>,
}

/// The browser proves once that it holds the access token and gets the access cookie (one year).
async fn session(State(state): State<Arc<AppState>>, headers: axum::http::HeaderMap, body: axum::body::Bytes) -> Response {
    let token = if body.len() <= 1024 { serde_json::from_slice::<SessionBody>(&body).ok().and_then(|b| b.token) } else { None };
    let valid = token.as_deref().map(|token| same_secret(Some(&proof(token)), &state.proof)).unwrap_or(false);
    if headers.get(header::ORIGIN).is_none() || !valid {
        return error(StatusCode::FORBIDDEN, "Enlace de acceso no válido.");
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    let cookie = format!("{ACCESS_COOKIE}={}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}", state.proof, 365 * 86_400);
    response.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).expect("cookie"));
    response
}

async fn status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let mut readiness = hermes_readiness();
    readiness["csrf"] = json!(state.csrf);
    Json(readiness)
}

/// Whether Hermes is installed and the profile chats' provider configured (the same answer as before).
pub fn hermes_readiness() -> serde_json::Value {
    let home = std::env::var("HOME").unwrap_or_default();
    let installation = std::env::var("HERMES_INSTALLATION").unwrap_or_else(|_| format!("{home}/.hermes/hermes-agent"));
    let installed = PathBuf::from(&installation).join("run_agent.py").exists() && PathBuf::from(&installation).join("venv/bin/python").exists();
    let configured = ["AGORA_MODEL", "AGORA_BASE_URL", "AGORA_API_KEY"].iter().all(|k| std::env::var(k).map(|v| !v.is_empty()).unwrap_or(false));
    let (state, detail) = if !installed {
        ("missing", "No se encuentra la instalación de Hermes.")
    } else if !configured {
        ("needs-configuration", "Falta configurar proveedor, modelo y autenticación en el backend.")
    } else {
        ("configured", "Configurado. La conexión se verifica al enviar un mensaje.")
    };
    json!({ "installed": installed, "configured": configured, "mode": "hermes-python", "tools": [], "state": state, "detail": detail })
}

pub fn router(state: Arc<AppState>) -> Router {
    let web = ServeDir::new(&state.config.web);
    Router::new()
        .route("/api/session", post(session))
        .route("/api/status", get(status))
        .route("/api/hermes/catalog", get(hermes::routes::catalog))
        .route("/api/hermes/activity", get(hermes::routes::activity))
        .route("/api/hermes/summary", get(hermes::routes::summary))
        .route("/api/hermes/profiles/{id}", get(hermes::routes::profile))
        .route("/api/hermes/profiles/{id}/mcp/{server}/tools", get(hermes::routes::mcp_tools))
        .route("/api/hermes/profiles/{id}/mcp/{server}/tools/{tool}/call", post(write::call_tool))
        .route("/api/hermes/profiles/{id}/files/{name}", put(write::save_file))
        .route("/api/hermes/profiles/{id}/jobs", post(write::create_job))
        .route("/api/hermes/profiles/{id}/jobs/{job}", get(write::job).post(write::change_job))
        .route("/api/hermes/profiles/{id}/cards", post(write::create_card))
        .route("/api/hermes/profiles/{id}/cards/{card}", post(write::change_card))
        .route("/api/hermes/profiles/{id}/skills", get(write::skills).post(write::create_skill))
        .route("/api/hermes/profiles/{id}/skills/{skill}", get(write::skill).put(write::save_skill))
        .route("/api/core", any(core::proxy))
        .route("/api/core/{*rest}", any(core::proxy))
        .route("/api/{*rest}", any(not_found))
        .fallback_service(web)
        .layer(middleware::from_fn_with_state(state.clone(), security::guard))
        .with_state(state)
}

/// What an unknown API path answers (the browser never reaches the static files under /api).
pub async fn not_found() -> Response {
    error(StatusCode::NOT_FOUND, "No disponible.")
}
