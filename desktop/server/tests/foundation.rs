//! The server's foundations, ported from the former Node tests (server/app.test.ts and core-proxy.test.ts):
//! access cookie, CSRF, Host and Origin, framing, letter case of /api, and the proxy to the core.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use agora_server::access::proof;
use agora_server::core::CoreLink;
use agora_server::{AppState, Config, router};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use axum::response::IntoResponse;
use http_body_util::BodyExt;
use tower::ServiceExt;

const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HOST: &str = "127.0.0.1:4317";
const ORIGIN: &str = "http://127.0.0.1:4317";

/// What the fake core saw of each request.
#[derive(Default, Clone, Debug)]
struct Seen {
    path: String,
    method: String,
    secret: Option<String>,
    owner: Option<String>,
    cookie: Option<String>,
    body: Vec<u8>,
}

async fn fake_core(reply_status: u16) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let app = Router::new().fallback(move |request: Request<Body>| {
        let log = log.clone();
        async move {
            let (parts, body) = request.into_parts();
            let get = |name: &str| parts.headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
            // The body is read before taking the lock: a lock held across an await is not Send.
            let body = body.collect().await.unwrap().to_bytes().to_vec();
            log.lock().unwrap().push(Seen {
                path: parts.uri.to_string(), method: parts.method.to_string(), secret: get("x-agora-core-secret"),
                owner: get("x-agora-owner"), cookie: get("cookie"), body,
            });
            if parts.uri.path() == "/events" {
                let events = "event: stage\ndata: {}\n\nevent: done\ndata: {}\n\n";
                return ([(header::CONTENT_TYPE, "text/event-stream"), (header::SET_COOKIE, "core=secreta")], events).into_response();
            }
            (StatusCode::from_u16(reply_status).unwrap(), [(header::CONTENT_TYPE, "application/json")], r#"{"ok":true}"#).into_response()
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}"), seen)
}

fn app(core: Option<CoreLink>) -> (Router, Arc<AppState>) {
    let web = tempfile::tempdir().unwrap().keep();
    std::fs::write(web.join("index.html"), "<!doctype html>").unwrap();
    let hermes = agora_server::hermes::location::hermes_location(|_| None, &web.join("sin-hermes"));
    let config = Config { data: web.clone(), web, hosts: vec![HOST.into(), "127.0.0.1:5173".into()], hermes, obsidian_registry: None, examples: std::path::PathBuf::from("/no-examples"), extractor: None };
    let state = AppState::new(config, TOKEN, core);
    (router(state.clone()), state)
}

fn access() -> String {
    format!("agora_access={}", proof(TOKEN))
}

async fn call(app: &Router, request: Request<Body>) -> (StatusCode, axum::http::HeaderMap, String) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    (status, headers, body)
}

fn get(path: &str) -> axum::http::request::Builder {
    Request::get(path).header(header::HOST, HOST)
}

#[tokio::test]
async fn acceso_sin_el_enlace_privado_nadie_usa_la_api() {
    let (app, state) = app(None);
    let (status, _, _) = call(&app, get("/api/status").header("x-agora-csrf", &state.csrf).body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "ni con las cabeceras de la página");
    let (status, _, body) = call(&app, get("/api/status").header(header::COOKIE, access()).body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains(&state.csrf));
    // Trading the token: Origin required and the exact token.
    let session = |token: &str, origin: bool| {
        let mut request = Request::post("/api/session").header(header::HOST, HOST).header(header::CONTENT_TYPE, "application/json");
        if origin {
            request = request.header(header::ORIGIN, ORIGIN);
        }
        request.body(Body::from(format!(r#"{{"token":"{token}"}}"#))).unwrap()
    };
    assert_eq!(call(&app, session(&"b".repeat(64), true)).await.0, StatusCode::FORBIDDEN);
    assert_eq!(call(&app, session(TOKEN, false)).await.0, StatusCode::FORBIDDEN);
    let (status, headers, _) = call(&app, session(TOKEN, true)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let cookie = headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(cookie.starts_with(&access()) && cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
    assert!(!cookie.contains(TOKEN), "la cookie nunca lleva el token");
}

#[tokio::test]
async fn host_origen_y_csrf() {
    let (app, state) = app(None);
    let bad_host = Request::get("/api/status").header(header::HOST, "evil.test").header(header::COOKIE, access()).body(Body::empty()).unwrap();
    assert_eq!(call(&app, bad_host).await.0, StatusCode::FORBIDDEN);
    let bad_origin = get("/api/status").header(header::COOKIE, access()).header(header::ORIGIN, "http://evil.test").body(Body::empty()).unwrap();
    assert_eq!(call(&app, bad_origin).await.0, StatusCode::FORBIDDEN);
    let write = |csrf: Option<&str>, origin: bool| {
        let mut request = Request::post("/api/conversations").header(header::HOST, HOST).header(header::COOKIE, access());
        if let Some(csrf) = csrf { request = request.header("x-agora-csrf", csrf); }
        if origin { request = request.header(header::ORIGIN, ORIGIN); }
        request.body(Body::from("{}")).unwrap()
    };
    assert_eq!(call(&app, write(None, true)).await.0, StatusCode::FORBIDDEN, "escritura sin CSRF");
    assert_eq!(call(&app, write(Some(&state.csrf), false)).await.0, StatusCode::FORBIDDEN, "escritura sin Origin");
    assert_eq!(call(&app, write(Some("x"), true)).await.0, StatusCode::FORBIDDEN);
    let catalog = get("/api/hermes/catalog").header(header::COOKIE, access()).body(Body::empty()).unwrap();
    assert_eq!(call(&app, catalog).await.0, StatusCode::FORBIDDEN, "el catálogo exige CSRF también en GET");
}

#[tokio::test]
async fn ninguna_web_puede_incrustar_agoraone_ni_esquivar_por_mayusculas() {
    let (app, _) = app(None);
    for path in ["/", "/api/status", "/no-existe"] {
        let (_, headers, _) = call(&app, get(path).body(Body::empty()).unwrap()).await;
        assert_eq!(headers.get("x-frame-options").unwrap(), "DENY", "{path}");
        assert_eq!(headers.get("content-security-policy").unwrap(), "frame-ancestors 'none'");
        assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store");
    }
    for path in ["/API/status", "/Api/core/health", "/api/CORE/health"] {
        assert_eq!(call(&app, get(path).body(Body::empty()).unwrap()).await.0, StatusCode::UNAUTHORIZED, "{path}");
    }
}

#[tokio::test]
async fn el_proxy_anade_secreto_y_propietario_conserva_cuerpo_y_no_filtra_cookies() {
    let (url, seen) = fake_core(201).await;
    let (app, state) = app(Some(CoreLink { url, secret: "s".repeat(64) }));
    let request = Request::post("/api/core/assistant/conversations?x=1").header(header::HOST, HOST).header(header::ORIGIN, ORIGIN)
        .header(header::COOKIE, format!("{}; agora_user={}", access(), "c".repeat(64))).header("x-agora-csrf", &state.csrf)
        .header(header::CONTENT_TYPE, "application/json").body(Body::from(r#"{"a":1}"#)).unwrap();
    let (status, _, body) = call(&app, request).await;
    assert_eq!((status, body.as_str()), (StatusCode::CREATED, r#"{"ok":true}"#));
    let got = seen.lock().unwrap()[0].clone();
    assert_eq!((got.method.as_str(), got.path.as_str(), got.body.as_slice()), ("POST", "/assistant/conversations?x=1", br#"{"a":1}"#.as_slice()));
    assert_eq!(got.secret.as_deref(), Some("s".repeat(64).as_str()));
    assert_eq!(got.owner, Some(agora_server::access::core_owner(&proof(TOKEN))), "el dueño es el acceso, no la cookie del navegador");
    assert_eq!(got.cookie, None, "las cookies del navegador no llegan al núcleo");
    // Without CSRF, not even a GET reaches the core.
    let bare = get("/api/core/health").header(header::COOKIE, access()).body(Body::empty()).unwrap();
    assert_eq!(call(&app, bare).await.0, StatusCode::FORBIDDEN);
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn eventos_en_streaming_sin_reenviar_cookies_del_nucleo() {
    let (url, _) = fake_core(200).await;
    let (app, state) = app(Some(CoreLink { url, secret: "s".repeat(64) }));
    let (status, headers, body) = call(&app, get("/api/core/events").header(header::COOKIE, access()).header("x-agora-csrf", &state.csrf).body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "text/event-stream");
    assert!(headers.get_all(header::SET_COOKIE).iter().all(|c| !c.to_str().unwrap().contains("core=")));
    assert!(body.contains("event: done"));
}

#[tokio::test]
async fn rutas_internas_doble_barra_cuerpo_grande_y_nucleo_ausente_u_otro() {
    let (url, seen) = fake_core(401).await;
    let (app, state) = app(Some(CoreLink { url, secret: "s".repeat(64) }));
    let with = |path: &str| get(path).header(header::COOKIE, access()).header("x-agora-csrf", &state.csrf).body(Body::empty()).unwrap();
    for path in ["/api/core/internal/index/state", "/api/core/%69nternal/x", "/api/core//internal", "/api/core/INTERNAL/x", "/api/core/%2e%2e/internal/index/notes", "/api/core/a/%2E%2E/internal/x", "/api/core/a/../internal/x", "/api/core/internal/wake/status", "/api/core/internal/central/window/next", "/api/core/internal/fabrica/window/next", "/api/core/internal/crmdev/window/next"] {
        assert!(matches!(call(&app, with(path)).await.0, StatusCode::NOT_FOUND | StatusCode::BAD_REQUEST), "{path}");
    }
    assert!(seen.lock().unwrap().is_empty(), "nada llegó al núcleo");
    assert_eq!(call(&app, with("/api/core/health")).await.0, StatusCode::SERVICE_UNAVAILABLE, "un núcleo de otro arranque");
    let big = Request::post("/api/core/x").header(header::HOST, HOST).header(header::ORIGIN, ORIGIN).header(header::COOKIE, access())
        .header("x-agora-csrf", &state.csrf).body(Body::from(vec![b'a'; 1024 * 1024 + 1])).unwrap();
    assert_eq!(call(&app, big).await.0, StatusCode::PAYLOAD_TOO_LARGE);
    let (absent, state) = self::app(None);
    let request = get("/api/core/health").header(header::COOKIE, access()).header("x-agora-csrf", &state.csrf).body(Body::empty()).unwrap();
    assert_eq!(call(&absent, request).await.0, StatusCode::SERVICE_UNAVAILABLE);
}

#[test]
fn el_nucleo_conoce_los_puertos_de_agoraone() {
    let settings = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../core/agora_core/settings.py")).unwrap();
    let core_port = agora_server::core::CORE_URL.rsplit(':').next().unwrap();
    assert!(settings.lines().any(|l| l == format!("SERVER_PORT = {}", agora_server::PORT)), "el puerto del servidor, igual en el núcleo");
    assert!(settings.lines().any(|l| l == format!("PORT = {core_port}")), "el puerto del núcleo, igual en los dos lados");
}
