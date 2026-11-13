//! The Python core: started next to the server with a fresh secret and a minimal environment, stopped with
//! it, and reached by the browser only through `/api/core/*` after the usual checks. The proxy sends the
//! start secret and the authenticated owner, never the browser's cookies; only the path and query of the
//! request travel, so it cannot be pointed elsewhere; bodies are capped at 1 MiB and answers are streamed
//! (Server-Sent Events work through it).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::Response;
use tokio::process::{Child, Command};

use crate::AppState;
use crate::security::{Owner, error};

pub const CORE_URL: &str = "http://127.0.0.1:4318";
const MAX_BODY: usize = 1024 * 1024;
const FORWARDED_REQUEST: [&str; 3] = ["content-type", "accept", "last-event-id"];
const FORWARDED_RESPONSE: [&str; 2] = ["content-type", "content-disposition"];
// What the core may inherit: programs, locale, temp folder, what uv needs behind a proxy, and what the
// local Claude Code needs to find the user's own session. Never keys, tokens or the server's settings.
const INHERITED: [&str; 12] = [
    "PATH", "HOME", "LANG", "TMPDIR", "USER", "LOGNAME", "UV_CACHE_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "CLAUDE_CONFIG_DIR",
];

#[derive(Clone, Debug)]
pub struct CoreLink {
    pub url: String,
    pub secret: String,
}

/// How to run the core: `uv run` from its folder in development, or the bundled Python inside the app.
#[derive(Clone, Debug)]
pub enum CoreLaunch {
    Uv { folder: PathBuf },
    Bundled { python: PathBuf, folder: PathBuf },
}

/// The core's whole environment: the start secret, the server's PID to watch, its data folder and the basics.
pub fn environment(secret: &str, server_pid: u32, data: &Path, from: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    let mut env = vec![
        ("AGORA_CORE_SECRET".into(), secret.into()),
        ("AGORA_BACKEND_PID".into(), server_pid.to_string()),
        ("AGORA_CORE_DATA".into(), data.display().to_string()),
        ("PYTHONUNBUFFERED".into(), "1".into()),
    ];
    env.extend(INHERITED.iter().filter_map(|name| from(name).map(|value| ((*name).to_string(), value))));
    env
}

/// Starts the core; it watches this process and ends on its own if the server dies.
pub fn start(launch: &CoreLaunch, link: &CoreLink, data: &Path) -> std::io::Result<Child> {
    let (program, args, folder): (PathBuf, Vec<&str>, &Path) = match launch {
        CoreLaunch::Uv { folder } => ("uv".into(), vec!["run", "--frozen", "--quiet", "python", "-m", "agora_core"], folder),
        CoreLaunch::Bundled { python, folder } => (python.clone(), vec!["-m", "agora_core"], folder),
    };
    Command::new(program)
        .args(args)
        .current_dir(folder)
        .env_clear()
        .envs(environment(&link.secret, std::process::id(), data, |name| std::env::var(name).ok()))
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()
}

fn decode(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub async fn proxy(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let unavailable = || error(StatusCode::SERVICE_UNAVAILABLE, "El núcleo de AgoraOne no está disponible. Reinicia AgoraOne.");
    let Some(link) = state.core.clone() else { return unavailable() };
    let method = request.method().clone();
    if ![Method::GET, Method::HEAD, Method::POST, Method::PUT, Method::PATCH, Method::DELETE].contains(&method) {
        return error(StatusCode::METHOD_NOT_ALLOWED, "Método no admitido.");
    }
    // Mounted under /api/core: what is left is the core's own path.
    let full = request.uri().path().to_string();
    let path = full.get("/api/core".len()..).unwrap_or("").to_string();
    if path.starts_with("//") {
        return error(StatusCode::BAD_REQUEST, "Ruta no válida.");
    }
    let Some(decoded) = decode(&path) else { return error(StatusCode::BAD_REQUEST, "Ruta no válida.") };
    // /internal/* is for the server's own calls (e.g. writing the index): never from the browser.
    let trimmed = decoded.trim_start_matches('/').to_ascii_lowercase();
    if trimmed == "internal" || trimmed.starts_with("internal/") {
        return error(StatusCode::NOT_FOUND, "No disponible.");
    }
    let owner = request.extensions().get::<Owner>().map(|owner| owner.0.clone()).unwrap_or_default();
    let query = request.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let target = format!("{}{}{}", link.url, if path.is_empty() { "/" } else { &path }, query);
    let mut outgoing = state.http.request(reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap(), &target)
        .header("x-agora-core-secret", &link.secret)
        .header("x-agora-owner", owner);
    for name in FORWARDED_REQUEST {
        if let Some(value) = request.headers().get(name).and_then(|v| v.to_str().ok()) {
            outgoing = outgoing.header(name, value);
        }
    }
    if method != Method::GET && method != Method::HEAD {
        match axum::body::to_bytes(request.into_body(), MAX_BODY).await {
            Ok(body) => outgoing = outgoing.body(body),
            Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "La petición es demasiado grande."),
        }
    }
    // The limit covers waiting for the answer to start; a stream may then last as long as the browser keeps it.
    let answer = match tokio::time::timeout(Duration::from_secs(120), outgoing.send()).await {
        Ok(Ok(answer)) => answer,
        _ => return unavailable(),
    };
    // A 401 means the running core belongs to another start (it does not hold this start's secret).
    if answer.status() == reqwest::StatusCode::UNAUTHORIZED {
        return error(StatusCode::SERVICE_UNAVAILABLE, "El núcleo en marcha pertenece a otro arranque de AgoraOne. Reinicia AgoraOne.");
    }
    let status = StatusCode::from_u16(answer.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers: Vec<_> = FORWARDED_RESPONSE.iter()
        .filter_map(|name| answer.headers().get(*name).and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok()).map(|v| (*name, v)))
        .collect();
    let mut response = Response::new(Body::from_stream(answer.bytes_stream()));
    *response.status_mut() = status;
    for (name, value) in headers {
        response.headers_mut().insert(header::HeaderName::from_static(name), value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entorno_minimo_sin_claves() {
        let env = environment("s", 7, Path::new("/datos"), |name| match name {
            "PATH" => Some("/bin".into()),
            "ANTHROPIC_API_KEY" => Some("sk-no".into()),
            _ => None,
        });
        let names: Vec<_> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, ["AGORA_CORE_SECRET", "AGORA_BACKEND_PID", "AGORA_CORE_DATA", "PYTHONUNBUFFERED", "PATH"]);
    }

    #[test]
    fn rutas_codificadas() {
        assert_eq!(decode("/%69nternal/x").as_deref(), Some("/internal/x"));
        assert_eq!(decode("/%zz"), None);
    }
}
