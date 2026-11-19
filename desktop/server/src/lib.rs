//! AgoraOne's local server in Rust: the same HTTP contract the browser has always used (`/api/*`), only on
//! 127.0.0.1, behind the access cookie, CSRF, Host and Origin checks (security.rs). The desktop app starts
//! it; it can also run on its own for the browser.

pub mod access;
pub mod brain_sync;
pub mod chat;
pub mod core;
pub mod hermes;
pub mod js;
pub mod launch;
pub mod library;
pub mod secret_lines;
pub mod security;
pub mod vault;

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::extract::DefaultBodyLimit;
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
    /// The library's fixed example documents.
    pub examples: PathBuf,
    /// The core's Python that extracts PDF and DOCX text (None: those imports are refused).
    pub extractor: Option<library::extract::Extractor>,
}

pub struct AppState {
    pub config: Config,
    pub proof: String,
    pub csrf: String,
    pub core: Option<CoreLink>,
    /// How long the core proxy waits for an answer to start (a stream may then last longer).
    pub core_wait: std::time::Duration,
    pub http: reqwest::Client,
    pub hermes: HermesDiscovery,
    pub vault: Arc<vault::VaultNotes>,
    pub library: library::PrivateLibrary,
    pub conversations: chat::store::Conversations,
    /// Luma's adapter and the profiles' agent adapter (tests replace them).
    pub luma: chat::Adapter,
    pub agent: chat::Adapter,
    /// Copy a profile's memory before its agent runs (only with the real agent).
    pub backup_memories: bool,
    /// Conversations with a turn running, and those whose turn the user stopped.
    pub busy: std::sync::Mutex<std::collections::HashSet<String>>,
    pub stopped: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl AppState {
    pub fn new(config: Config, token: &str, core: Option<CoreLink>) -> Arc<Self> {
        let http = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().expect("cliente HTTP");
        let hermes = HermesDiscovery::new(config.hermes.clone());
        let vault = Arc::new(vault::VaultNotes::new(config.obsidian_registry.clone()));
        let library = library::PrivateLibrary::new(config.data.join("library"));
        let conversations = chat::store::Conversations::new(config.data.join("conversations"));
        let luma = chat::luma_adapter(config.hermes.clone(), config.data.clone());
        let agent = chat::agent_adapter(config.hermes.clone(), chat::app_dir(&config.data));
        Arc::new(Self {
            config,
            proof: proof(token),
            csrf: access::random_hex(),
            core,
            core_wait: std::time::Duration::from_secs(120),
            http,
            hermes,
            vault,
            library,
            conversations,
            luma,
            agent,
            backup_memories: true,
            busy: Default::default(),
            stopped: Default::default(),
        })
    }

    /// The brain's index kept in step with the vaults (None without a core).
    pub fn brain_sync(&self) -> Option<Arc<brain_sync::BrainSync>> {
        let link = self.core.clone()?;
        Some(brain_sync::BrainSync::new(self.vault.clone(), link, self.config.obsidian_registry.clone(), self.http.clone()))
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
    let mut readiness = hermes_readiness_at(&state.config.hermes);
    readiness["csrf"] = json!(state.csrf);
    Json(readiness)
}

/// Whether Hermes is installed and the profile chats' provider configured (the same answer as before).
pub fn hermes_readiness_at(location: &HermesLocation) -> serde_json::Value {
    let installed = location.installation.join("run_agent.py").exists() && location.python.exists();
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
        .route("/api/hermes/work", get(hermes::routes::work))
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
        .route("/api/hermes/vaults/{id}/notes", get(vault::routes::list).post(vault::routes::create))
        .route("/api/hermes/vaults/{id}/notes/{note}", get(vault::routes::note).put(vault::routes::save))
        .route("/api/hermes/vaults/{id}/notes/{note}/move", post(vault::routes::move_note))
        .route("/api/hermes/vaults/{id}/files", post(vault::routes::create_file).layer(DefaultBodyLimit::max(26 * 1024 * 1024)))
        .route("/api/hermes/vaults/{id}/search", get(vault::routes::search))
        .route("/api/library/documents", get(library::routes::list).fallback(library::routes::not_allowed))
        .route("/api/library/documents/{id}", get(library::routes::read).patch(library::routes::rename).delete(library::routes::delete).fallback(library::routes::not_allowed))
        .route("/api/library/imports", post(library::routes::import).layer(DefaultBodyLimit::max(8 * 1024 * 1024)).fallback(library::routes::not_allowed))
        .route("/api/library", any(library::routes::not_allowed))
        .route("/api/library/{*rest}", any(library::routes::not_allowed))
        .route("/api/conversations", post(chat::routes::create))
        .route("/api/conversations/{id}", get(chat::routes::read))
        .route("/api/conversations/{id}/messages", post(chat::routes::send))
        .route("/api/conversations/{id}/cancel", post(chat::routes::cancel))
        .route("/api/conversations/{id}/approvals/{request}", post(chat::routes::approve))
        .route("/api/core", any(core::proxy))
        .route("/api/core/{*rest}", any(core::proxy))
        .route("/api/{*rest}", any(not_found))
        // A method an API route does not take answers like an unknown route (as before), not an empty 405.
        .method_not_allowed_fallback(not_found)
        .fallback_service(web)
        .layer(middleware::from_fn_with_state(state.clone(), security::guard))
        .with_state(state)
}

/// What an unknown API path answers (the browser never reaches the static files under /api).
pub async fn not_found() -> Response {
    error(StatusCode::NOT_FOUND, "No disponible.")
}
