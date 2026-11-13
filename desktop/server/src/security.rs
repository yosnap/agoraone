//! The checks every request goes through, in the former backend's order: Host, Origin, the access cookie
//! for the API, CSRF on every API write (and on GET for /api/hermes and /api/core), the browser identity
//! cookie, and headers that forbid framing and caching. The API prefix is compared case-insensitively, so
//! `/API/...` can never slip past them.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::access::{ACCESS_COOKIE, USER_COOKIE, core_owner, is_hex64, owner_of, random_hex, same_secret};
use crate::AppState;

/// Who is asking, set by the checks for the handlers after them.
#[derive(Clone, Debug)]
pub struct Owner(pub String);

pub fn error(status: StatusCode, message: &str) -> Response {
    (status, axum::Json(json!({ "error": message }))).into_response()
}

pub fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get_all(header::COOKIE).iter().filter_map(|value| value.to_str().ok()).flat_map(|line| line.split(';')).find_map(|pair| {
        let (key, value) = pair.trim().split_once('=')?;
        (key == name).then_some(value)
    })
}

fn harden(response: &mut Response) {
    let headers = response.headers_mut();
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("content-security-policy", HeaderValue::from_static("frame-ancestors 'none'"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
}

pub async fn guard(State(state): State<Arc<AppState>>, mut request: Request, next: Next) -> Response {
    let mut response = match check(&state, &mut request) {
        Some(refusal) => refusal,
        None => {
            let fresh = request.extensions().get::<FreshUser>().cloned();
            let mut response = next.run(request).await;
            // A browser seen for the first time gets its identity cookie (30 days).
            if let Some(FreshUser(token)) = fresh {
                let value = format!("{USER_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}", 30 * 86_400);
                if let Ok(value) = HeaderValue::from_str(&value) {
                    response.headers_mut().append(header::SET_COOKIE, value);
                }
            }
            response
        }
    };
    harden(&mut response);
    response
}

#[derive(Clone)]
struct FreshUser(String);

/// Returns a refusal, or None to let the request through (with its Owner attached).
fn check(state: &AppState, request: &mut Request) -> Option<Response> {
    let headers = request.headers();
    let path = request.uri().path().to_string();
    let lower = path.to_ascii_lowercase();
    let api = lower.starts_with("/api");
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    if !state.config.hosts.iter().any(|allowed| allowed == host) {
        return Some(error(StatusCode::FORBIDDEN, "Host no permitido."));
    }
    let origin = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()).map(str::to_string);
    if let Some(origin) = &origin {
        if !state.config.hosts.iter().any(|allowed| origin == &format!("http://{allowed}")) {
            return Some(error(StatusCode::FORBIDDEN, "Origen no permitido."));
        }
    }
    if path == "/api/session" && request.method() == Method::POST {
        return None;
    }
    if api && !same_secret(cookie(headers, ACCESS_COOKIE), &state.proof) {
        return Some(error(
            StatusCode::UNAUTHORIZED,
            "Abre AgoraOne con el enlace de acceso: lo muestra la app al arrancar, o usa «agoraone abrir».",
        ));
    }
    let csrf = headers.get("x-agora-csrf").and_then(|c| c.to_str().ok());
    let csrf_ok = same_secret(csrf, &state.csrf);
    if api && request.method() != Method::GET && (origin.is_none() || !csrf_ok) {
        return Some(error(StatusCode::FORBIDDEN, "Sesión de navegador no válida. Recarga la página."));
    }
    if (lower.starts_with("/api/hermes") || lower.starts_with("/api/core")) && !csrf_ok {
        let message = if lower.starts_with("/api/core") { "Sesión de navegador no válida. Recarga la página." } else { "Recarga AgoraOne para acceder al catálogo local." };
        return Some(error(StatusCode::FORBIDDEN, message));
    }
    // The core's owner is AgoraOne's access (single user, same in every browser); the rest, this browser.
    let owner = if lower.starts_with("/api/core") {
        core_owner(&state.proof)
    } else {
        match cookie(headers, USER_COOKIE).filter(|token| is_hex64(token)) {
            Some(token) => owner_of(token),
            None => {
                let token = random_hex();
                let owner = owner_of(&token);
                request.extensions_mut().insert(FreshUser(token));
                owner
            }
        }
    };
    request.extensions_mut().insert(Owner(owner));
    None
}
