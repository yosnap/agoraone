//! The rest of server/app.test.ts and core-proxy.test.ts through the router: MCP tools by HTTP, the
//! read-only catalogue, vault notes behind CSRF, tasks and kanban bodies, skills, and the core proxy's
//! unsupported methods and wait limit.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use agora_server::access::proof;
use agora_server::core::CoreLink;
use agora_server::hermes::location::HermesLocation;
use agora_server::hermes::mcp_tools::mcp_fingerprint;
use agora_server::{AppState, Config, router};
use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::get;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const TOKEN: &str = "abababababababababababababababababababababababababababababababab";
const HOST: &str = "127.0.0.1:4317";

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    state: Arc<AppState>,
}

/// `hermes` builds the fictitious Hermes data root.
fn fixture(hermes: impl FnOnce(&std::path::Path), core: Option<CoreLink>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(dir.path()).unwrap();
    let root = base.join("hermes");
    fs::create_dir_all(&root).unwrap();
    hermes(&root);
    let location = HermesLocation { root: root.clone(), installation: "/not-installed".into(), python: PathBuf::new(), source: "test".into() };
    let config = Config { data: base.join("datos"), web: base.clone(), hosts: vec![HOST.into()], hermes: location, obsidian_registry: None, examples: base.join("ejemplos"), extractor: None };
    Fixture { _dir: dir, root, state: AppState::new(config, TOKEN, core) }
}

impl Fixture {
    async fn call(&self, method: &str, path: &str, body: Option<Value>, csrf: bool) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, HOST)
            .header(header::ORIGIN, format!("http://{HOST}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, format!("agora_access={}", proof(TOKEN)));
        if csrf {
            request = request.header("x-agora-csrf", &self.state.csrf);
        }
        let response = router(self.state.clone()).oneshot(request.body(body.map(|b| Body::from(b.to_string())).unwrap_or_else(Body::empty)).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn profile(&self, name: &str) -> agora_server::hermes::catalog::HermesProfile {
        self.state.hermes.scan(true).profiles.into_iter().find(|p| p.name == name).unwrap()
    }
}

#[tokio::test]
async fn herramientas_mcp_exigen_csrf_servidor_del_perfil_y_registro_vigente() {
    let f = fixture(
        |root| {
            fs::create_dir(root.join("cache")).unwrap();
            fs::write(root.join("config.yaml"), "mcp_servers:\n  demo:\n    command: test-only\n").unwrap();
            let config = json!({ "command": "test-only" }).as_object().unwrap().clone();
            let cache = json!({ "demo": { "fingerprint": mcp_fingerprint(&config), "tools": [{ "name": "test_tool" }] } });
            fs::write(root.join("cache/mcp_schema_cache.json"), cache.to_string()).unwrap();
        },
        None,
    );
    let profile = f.profile("default");
    let server = profile.mcp[0].id.clone();
    let url = format!("/api/hermes/profiles/{}/mcp/{server}/tools", profile.id);
    // Calling a tool by hand: CSRF, strict body, only tools of the saved catalogue and only declared servers.
    let call = format!("{url}/test_tool/call");
    assert_eq!(f.call("POST", &call, Some(json!({ "args": {} })), false).await.0, StatusCode::FORBIDDEN);
    assert_eq!(f.call("POST", &call, Some(json!({ "args": {}, "server": "/bin/sh" })), true).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(f.call("POST", &format!("{url}/otra/call"), Some(json!({ "args": {} })), true).await.0, StatusCode::NOT_FOUND, "fuera del catálogo");
    assert_eq!(f.call("POST", &call.replace(&server, "mcp-x"), Some(json!({ "args": {} })), true).await.0, StatusCode::NOT_FOUND);
    assert_eq!(f.call("GET", &url, None, false).await.0, StatusCode::FORBIDDEN);
    let (status, tools) = f.call("GET", &url, None, true).await;
    assert_eq!((status, tools["tools"][0]["name"].as_str()), (StatusCode::OK, Some("test_tool")));
    assert_eq!(f.call("GET", &url.replace(&profile.id, "profile-other"), None, true).await.0, StatusCode::NOT_FOUND);
    fs::write(f.root.join("config.yaml"), "mcp_servers: {}").unwrap();
    assert_eq!(f.call("GET", &url, None, true).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn el_catalogo_es_de_solo_lectura_y_se_revoca_al_desaparecer_el_perfil() {
    let f = fixture(
        |root| {
            fs::write(root.join("SOUL.md"), "# Perfil ficticio\nIdentidad local.").unwrap();
            fs::write(root.join([".", "env"].concat()), "KEY=PRIVATE_CANARY").unwrap();
        },
        None,
    );
    assert_eq!(f.call("GET", "/api/hermes/catalog", None, false).await.0, StatusCode::FORBIDDEN);
    let (status, catalog) = f.call("GET", "/api/hermes/catalog", None, true).await;
    assert_eq!((status, catalog["profiles"].as_array().unwrap().len()), (StatusCode::OK, 1));
    let path = format!("/api/hermes/profiles/{}", catalog["profiles"][0]["id"].as_str().unwrap());
    let detail = f.call("GET", &path, None, true).await.1;
    assert!(detail["files"][0]["content"].as_str().unwrap().contains("Identidad local"));
    assert!(!detail.to_string().contains("PRIVATE_CANARY"));
    assert_eq!(f.call("PUT", &path, Some(json!({ "content": "Cambio prohibido" })), true).await, (StatusCode::NOT_FOUND, json!({ "error": "No disponible." })));
    assert!(fs::read_to_string(f.root.join("SOUL.md")).unwrap().contains("Identidad local"));
    fs::remove_file(f.root.join("SOUL.md")).unwrap();
    fs::remove_file(f.root.join([".", "env"].concat())).unwrap();
    assert_eq!(f.call("GET", &path, None, true).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn notas_del_vault_con_csrf_y_solo_ids_de_un_vault_registrado() {
    let f = fixture(|_| {}, None);
    let note = format!("/api/hermes/vaults/vault-x/notes/note-{}", "0".repeat(24));
    assert_eq!(f.call("GET", "/api/hermes/vaults/vault-x/notes", None, false).await.0, StatusCode::FORBIDDEN);
    assert_eq!(f.call("GET", "/api/hermes/vaults/vault-x/notes", None, true).await.0, StatusCode::NOT_FOUND);
    assert_eq!(f.call("GET", "/api/hermes/vaults/vault-x/search?q=a", None, true).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(f.call("GET", &note, None, true).await.0, StatusCode::NOT_FOUND);
    // The library route never resolves notes: they are only attached when sending a message.
    assert_eq!(f.call("GET", &format!("/api/library/documents/note-{}", "0".repeat(24)), None, true).await.0, StatusCode::NOT_FOUND);
    // Revealing hidden lines needs the CSRF header like any other local read.
    assert_eq!(f.call("GET", &format!("/api/hermes/profiles/profile-{}?reveal=1", "0".repeat(24)), None, false).await.0, StatusCode::FORBIDDEN);
    assert_eq!(f.call("GET", &format!("{note}?reveal=1"), None, false).await.0, StatusCode::FORBIDDEN);
    let edit = json!({ "content": "x", "revision": "a".repeat(64) });
    assert_eq!(f.call("PUT", &note, Some(edit.clone()), false).await.0, StatusCode::FORBIDDEN);
    assert_eq!(f.call("PUT", &note, Some(json!({ "content": "x", "revision": "a".repeat(64), "path": "/etc/passwd" })), true).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(f.call("PUT", &note, Some(json!({ "content": "x", "revision": "corta" })), true).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(f.call("PUT", &note, Some(edit), true).await.0, StatusCode::NOT_FOUND);
    let new = json!({ "folder": "", "title": "Nueva", "content": "x" });
    assert_eq!(f.call("POST", "/api/hermes/vaults/vault-x/notes", Some(new.clone()), false).await.0, StatusCode::FORBIDDEN);
    assert_eq!(f.call("POST", "/api/hermes/vaults/vault-x/notes", Some(new), true).await.0, StatusCode::NOT_FOUND);
    let moved = json!({ "folder": "", "title": "Otra", "revision": "a".repeat(64) });
    assert_eq!(f.call("POST", &format!("{note}/move"), Some(moved.clone()), false).await.0, StatusCode::FORBIDDEN);
    assert_eq!(f.call("POST", &format!("{note}/move"), Some(moved), true).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn tareas_y_kanban_con_csrf_cuerpo_estricto_y_solo_perfiles_del_catalogo() {
    let f = fixture(|_| {}, None);
    let profile = format!("profile-{}", "0".repeat(24));
    let jobs = format!("/api/hermes/profiles/{profile}/jobs");
    let job = json!({ "name": "Resumen", "schedule": "every 2h", "prompt": "hola" });
    assert_eq!(f.call("POST", &jobs, Some(job.clone()), false).await.0, StatusCode::FORBIDDEN);
    let mut deliver = job.clone();
    deliver["deliver"] = "telegram".into();
    assert_eq!(f.call("POST", &jobs, Some(deliver), true).await.0, StatusCode::BAD_REQUEST, "no se elige el destino");
    assert_eq!(f.call("POST", &format!("{jobs}/abc"), Some(json!({ "action": "run", "prompt": "x" })), true).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(f.call("POST", &format!("{jobs}/../x"), Some(json!({ "action": "run" })), true).await.0, StatusCode::NOT_FOUND);
    let cards = format!("/api/hermes/profiles/{profile}/cards");
    assert_eq!(f.call("POST", &cards, Some(json!({ "title": "x", "assignee": "otro" })), true).await.0, StatusCode::BAD_REQUEST, "no se elige a quién se asigna");
    assert_eq!(f.call("POST", &format!("{cards}/t_1"), Some(json!({ "action": "delete" })), true).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(f.call("POST", &cards, Some(json!({ "title": "x" })), false).await.0, StatusCode::FORBIDDEN);
    assert_eq!(f.call("GET", &format!("{jobs}/abc"), None, false).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn skills_con_csrf_tambien_al_leer_cuerpo_estricto_y_solo_perfiles_del_catalogo() {
    let f = fixture(
        |root| {
            fs::create_dir_all(root.join("profiles/alpha/skills/redaccion")).unwrap();
            fs::write(root.join("profiles/alpha/SOUL.md"), "Soy alpha.").unwrap();
            fs::write(root.join("profiles/alpha/skills/redaccion/SKILL.md"), "---\nname: redaccion\ndescription: \"Tono.\"\n---\n\n# Redaccion\n").unwrap();
        },
        None,
    );
    let alpha = f.profile("alpha").id;
    let list = format!("/api/hermes/profiles/{alpha}/skills");
    assert_eq!(f.call("GET", &list, None, false).await.0, StatusCode::FORBIDDEN);
    let skills = f.call("GET", &list, None, true).await.1;
    assert_eq!(skills["skills"].as_array().unwrap().len(), 1);
    let detail = format!("{list}/{}", skills["skills"][0]["id"].as_str().unwrap());
    assert_eq!(f.call("GET", &detail, None, false).await.0, StatusCode::FORBIDDEN);
    let read = f.call("GET", &detail, None, true).await.1;
    let revision = read["revision"].as_str().unwrap().to_string();
    assert_eq!(f.call("PUT", &detail, Some(json!({ "content": "x", "revision": revision })), false).await.0, StatusCode::FORBIDDEN);
    assert_eq!(f.call("PUT", &detail, Some(json!({ "content": "x" })), true).await.0, StatusCode::BAD_REQUEST);
    if agora_server::hermes::python::system_python().is_some() {
        assert_eq!(f.call("PUT", &detail, Some(json!({ "content": "x", "revision": "0".repeat(24) })), true).await.0, StatusCode::CONFLICT);
        assert_eq!(f.call("PUT", &detail, Some(json!({ "content": "# Redaccion\n", "revision": revision })), true).await.0, StatusCode::OK);
        assert_eq!(f.call("POST", &list, Some(json!({ "category": "nuevo", "name": "b", "description": "d", "body": "texto" })), true).await.0, StatusCode::CREATED);
    }
    let new = json!({ "category": "nuevo", "name": "c", "description": "d", "body": "texto" });
    assert_eq!(f.call("POST", &list, Some(new), false).await.0, StatusCode::FORBIDDEN);
    assert_eq!(f.call("POST", &list, Some(json!({ "category": "a/b", "name": "b", "description": "d", "body": "texto" })), true).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(f.call("GET", &format!("/api/hermes/profiles/profile-{}/skills", "0".repeat(24)), None, true).await.0, StatusCode::NOT_FOUND);
    assert_eq!(f.call("GET", &format!("{list}/skill-{}", "0".repeat(24)), None, true).await.0, StatusCode::NOT_FOUND);
}

/// A core that streams slowly on /slow and never answers on /hang.
async fn slow_core() -> String {
    let app = Router::new()
        .route(
            "/slow",
            get(|| async {
                let chunks = futures_util::stream::unfold(0, |n| async move {
                    if n == 2 {
                        return None;
                    }
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    Some((Ok::<_, std::convert::Infallible>(Bytes::from(if n == 0 { "data: uno\n\n" } else { "data: dos\n\n" })), n + 1))
                });
                ([(header::CONTENT_TYPE, "text/event-stream")], Body::from_stream(chunks)).into_response()
            }),
        )
        .route(
            "/hang",
            get(|| async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                "tarde"
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

#[tokio::test]
async fn el_proxy_rechaza_metodos_no_admitidos_y_su_limite_cubre_la_espera_no_el_flujo() {
    let url = slow_core().await;
    let mut f = fixture(|_| {}, Some(CoreLink { url, secret: "s".repeat(64) }));
    Arc::get_mut(&mut f.state).unwrap().core_wait = Duration::from_millis(100);
    assert_eq!(f.call("OPTIONS", "/api/core/health", None, true).await.0, StatusCode::METHOD_NOT_ALLOWED);
    let request = Request::get("/api/core/slow")
        .header(header::HOST, HOST)
        .header(header::COOKIE, format!("agora_access={}", proof(TOKEN)))
        .header("x-agora-csrf", &f.state.csrf)
        .body(Body::empty())
        .unwrap();
    let response = router(f.state.clone()).oneshot(request).await.unwrap();
    let text = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert_eq!(text, "data: uno\n\ndata: dos\n\n", "el flujo sigue pasado el tiempo límite");
    assert_eq!(f.call("GET", "/api/core/hang", None, true).await.0, StatusCode::SERVICE_UNAVAILABLE, "sin respuesta a tiempo, 503");
}
