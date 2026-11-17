//! Ported from the conversation tests of server/app.test.ts, with a recording adapter instead of Hermes:
//! owners, history, streaming, profile identity and revocation, attachments, approvals and turn limits.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use agora_server::access::proof;
use agora_server::chat::worker::Progress;
use agora_server::chat::{Adapter, Turn};
use agora_server::hermes::location::HermesLocation;
use agora_server::hermes::resources::obsidian_vaults;
use agora_server::platform::{canonicalize, create_test_link as symlink};
use agora_server::{AppState, Config, router};
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use base64::Engine;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tokio::sync::Notify;
use tower::ServiceExt;

const TOKEN: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const HOST: &str = "127.0.0.1:4317";
const ME: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const OTHER: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const LUMA: &str = r#"{"agent":"luma","context":"library-lobby"}"#;

type Turns = Arc<Mutex<Vec<Turn>>>;

struct Fixture {
    _dir: tempfile::TempDir,
    base: PathBuf,
    state: Arc<AppState>,
    turns: Turns,
}

/// An adapter that records each turn, reports the given progress and answers `reply` (or fails with it).
fn recording(turns: Turns, events: Vec<Value>, reply: Result<&'static str, &'static str>) -> Adapter {
    Arc::new(move |turn: Turn, progress: Option<Progress>| {
        turns.lock().unwrap().push(turn);
        let events = events.clone();
        Box::pin(async move {
            if let Some(report) = progress {
                events.into_iter().for_each(|event| report(event));
            }
            reply.map(str::to_string).map_err(str::to_string)
        })
    })
}

/// `hermes`: the folder of a fictitious Hermes data root (profiles), or none; `vault`: Obsidian registry.
fn fixture(setup: impl FnOnce(&Path) -> (Option<PathBuf>, Option<PathBuf>), adapter: impl FnOnce(Turns) -> Adapter) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let base = canonicalize(dir.path()).unwrap();
    let examples = base.join("ejemplos");
    fs::create_dir(&examples).unwrap();
    fs::write(examples.join("bienvenida.txt"), "Clave del ejemplo: FARO-274").unwrap();
    let (hermes, registry) = setup(&base);
    let root = hermes.unwrap_or_else(|| base.join("sin-hermes"));
    let location = HermesLocation { root, installation: "/not-installed".into(), python: PathBuf::new(), source: "test".into() };
    let config = Config { data: base.join("datos"), web: base.clone(), hosts: vec![HOST.into()], hermes: location, obsidian_registry: registry, examples, extractor: None };
    let mut state = AppState::new(config, TOKEN, None);
    let turns = Turns::default();
    let fake = adapter(turns.clone());
    let inner = Arc::get_mut(&mut state).unwrap();
    inner.luma = fake.clone();
    inner.agent = fake;
    inner.backup_memories = false;
    Fixture { _dir: dir, base, state, turns }
}

fn simple(reply: &'static str) -> impl FnOnce(Turns) -> Adapter {
    move |turns| recording(turns, vec![], Ok(reply))
}

impl Fixture {
    async fn call(&self, method: &str, path: &str, body: Option<&str>, user: &str, extra: &[(&str, &str)]) -> (StatusCode, String, Option<String>) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, HOST)
            .header(header::ORIGIN, format!("http://{HOST}"))
            .header(header::COOKIE, format!("agora_access={}; agora_user={user}", proof(TOKEN)))
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-agora-csrf", &self.state.csrf);
        for (name, value) in extra {
            request.headers_mut().unwrap().insert(header::HeaderName::from_bytes(name.as_bytes()).unwrap(), value.parse().unwrap());
        }
        let response = router(self.state.clone()).oneshot(request.body(body.map(|b| Body::from(b.to_string())).unwrap_or_else(Body::empty)).unwrap()).await.unwrap();
        let status = response.status();
        let kind = response.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_string);
        let text = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
        (status, text, kind)
    }

    async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.post_as(path, body, ME).await
    }

    async fn post_as(&self, path: &str, body: Value, user: &str) -> (StatusCode, Value) {
        let (status, text, _) = self.call("POST", path, Some(&body.to_string()), user, &[]).await;
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str, user: &str) -> (StatusCode, Value) {
        let (status, text, _) = self.call("GET", path, None, user, &[]).await;
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn luma(&self) -> String {
        let (status, created) = self.post("/api/conversations", serde_json::from_str(LUMA).unwrap()).await;
        assert_eq!(status, StatusCode::CREATED);
        created["id"].as_str().unwrap().to_string()
    }

    fn turns(&self) -> Vec<Turn> {
        self.turns.lock().unwrap().clone()
    }
}

/// Two fictitious profiles under `<base>/hermes`.
fn profiles(base: &Path) -> PathBuf {
    let root = base.join("hermes");
    for name in ["alpha", "beta"] {
        let home = root.join("profiles").join(name);
        fs::create_dir_all(home.join("memories")).unwrap();
        fs::write(home.join("SOUL.md"), format!("Soy {name}.")).unwrap();
        fs::write(home.join("memories/MEMORY.md"), format!("Recuerdo de {name}.")).unwrap();
    }
    root
}

fn profile_id(f: &Fixture, name: &str) -> String {
    f.state.hermes.scan(true).profiles.into_iter().find(|p| p.name == name).unwrap().id
}

#[tokio::test]
async fn separa_propietarios_y_conserva_historial_por_conversacion() {
    let f = fixture(|_| (None, None), simple("Respuesta del doble de prueba"));
    let id = f.luma().await;
    let path = format!("/api/conversations/{id}");
    assert_eq!(f.get(&path, OTHER).await.0, StatusCode::NOT_FOUND);
    assert_eq!(f.post(&format!("{path}/messages"), json!({ "message": "hola" })).await.0, StatusCode::OK);
    assert_eq!(f.post(&format!("{path}/messages"), json!({ "message": "continúa" })).await.0, StatusCode::OK);
    let turns = f.turns();
    assert_eq!((turns[0].history.len(), turns[1].history.len()), (0, 2));
    assert_eq!(turns[0].session_id, turns[1].session_id);
    let other = f.luma().await;
    f.post(&format!("/api/conversations/{other}/messages"), json!({ "message": "otra" })).await;
    let turns = f.turns();
    assert_ne!(turns[2].session_id, turns[0].session_id);
    assert_eq!(turns[2].history.len(), 0);
    assert_eq!(f.post("/api/conversations", json!({ "agent": "byte", "context": "library-lobby" })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(f.post("/api/conversations", json!({ "agent": "luma", "context": "../../private" })).await.0, StatusCode::BAD_REQUEST);
    let saved = fs::metadata(f.base.join("datos/conversations").join(format!("{id}.json"))).unwrap();
    assert!(saved.is_file());
    #[cfg(unix)]
    assert_eq!(std::os::unix::fs::PermissionsExt::mode(&saved.permissions()) & 0o777, 0o600);
}

#[tokio::test]
async fn rechaza_origen_host_csrf_y_herramientas_desde_el_navegador() {
    let f = fixture(|_| (None, None), simple("test"));
    for extra in [[("origin", "https://evil.example")], [("host", "evil.example")], [("x-agora-csrf", "")]] {
        assert_eq!(f.call("POST", "/api/conversations", Some(LUMA), ME, &extra).await.0, StatusCode::FORBIDDEN);
    }
    let id = f.luma().await;
    assert_eq!(f.post(&format!("/api/conversations/{id}/messages"), json!({ "message": "x", "tools": ["terminal"] })).await.0, StatusCode::BAD_REQUEST);
    assert!(f.turns().is_empty());
}

#[tokio::test]
async fn un_error_no_guarda_una_respuesta_ficticia() {
    let f = fixture(|_| (None, None), |turns| recording(turns, vec![], Err("Proveedor no disponible")));
    let id = f.luma().await;
    let (status, body) = f.post(&format!("/api/conversations/{id}/messages"), json!({ "message": "hola" })).await;
    assert_eq!((status, body), (StatusCode::BAD_GATEWAY, json!({ "error": "Proveedor no disponible" })));
    assert_eq!(f.get(&format!("/api/conversations/{id}"), ME).await.1["messages"], json!([]));
}

#[tokio::test]
async fn un_error_con_ruta_se_muestra_generico() {
    let f = fixture(|_| (None, None), |turns| recording(turns, vec![], Err("ENOENT: /Users/alguien/secreto")));
    let id = f.luma().await;
    let (_, body) = f.post(&format!("/api/conversations/{id}/messages"), json!({ "message": "hola" })).await;
    assert_eq!(body, json!({ "error": "No se pudo conversar con Hermes." }));
}

#[tokio::test]
async fn streaming_eventos_resultado_y_fallo_sin_texto_parcial() {
    let fail = Arc::new(Mutex::new(false));
    let flag = fail.clone();
    let f = fixture(
        |_| (None, None),
        move |turns| -> Adapter {
            Arc::new(move |turn: Turn, progress: Option<Progress>| {
                turns.lock().unwrap().push(turn);
                let failing = *flag.lock().unwrap();
                Box::pin(async move {
                    let report = progress.unwrap();
                    report(json!({ "type": "status", "stage": "generating" }));
                    report(json!({ "type": "delta", "text": "Texto parcial" }));
                    if failing { Err("Fallo de prueba".to_string()) } else { Ok("Respuesta completa".to_string()) }
                })
            })
        },
    );
    let id = f.luma().await;
    let path = format!("/api/conversations/{id}/messages");
    let ndjson = [("accept", "application/x-ndjson")];
    let (_, text, kind) = f.call("POST", &path, Some(r#"{"message":"hola"}"#), ME, &ndjson).await;
    assert!(kind.unwrap().contains("application/x-ndjson"));
    let events: Vec<Value> = text.trim().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(events[0], json!({ "type": "status", "stage": "starting" }));
    assert_eq!(events[2]["text"], "Texto parcial");
    assert_eq!(events.last().unwrap()["conversation"]["messages"][1]["content"], "Respuesta completa");
    *fail.lock().unwrap() = true;
    let (_, text, _) = f.call("POST", &path, Some(r#"{"message":"fallará"}"#), ME, &ndjson).await;
    let last: Value = serde_json::from_str(text.trim().lines().last().unwrap()).unwrap();
    assert_eq!(last, json!({ "type": "error", "error": "Fallo de prueba" }));
    assert_eq!(f.get(&format!("/api/conversations/{id}"), ME).await.1["messages"].as_array().unwrap().len(), 2);
    assert_eq!(f.call("POST", &path, Some(r#"{"message":"ajeno"}"#), OTHER, &ndjson).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn serializa_turnos_para_no_perder_historial() {
    let (entered, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let (inside, gate) = (entered.clone(), release.clone());
    let f = fixture(
        |_| (None, None),
        move |_| -> Adapter {
            Arc::new(move |_turn: Turn, _progress: Option<Progress>| {
                let (inside, gate) = (inside.clone(), gate.clone());
                Box::pin(async move {
                    inside.notify_one();
                    gate.notified().await;
                    Ok("test".to_string())
                })
            })
        },
    );
    let id = f.luma().await;
    let path = format!("/api/conversations/{id}/messages");
    let state = f.state.clone();
    let first_path = path.clone();
    let first = tokio::spawn(async move {
        let request = Request::post(&first_path)
            .header(header::HOST, HOST)
            .header(header::ORIGIN, format!("http://{HOST}"))
            .header(header::COOKIE, format!("agora_access={}; agora_user={ME}", proof(TOKEN)))
            .header("x-agora-csrf", &state.csrf)
            .body(Body::from(r#"{"message":"uno"}"#))
            .unwrap();
        router(state).oneshot(request).await.unwrap().status()
    });
    entered.notified().await;
    let (status, body) = f.post(&path, json!({ "message": "dos" })).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({ "error": "Hay una respuesta en curso. Espera antes de continuar." })));
    release.notify_one();
    assert_eq!(first.await.unwrap(), StatusCode::OK);
}

#[tokio::test]
async fn chat_de_perfiles_identidad_memoria_aislamiento_y_revocacion() {
    let f = fixture(|base| (Some(profiles(base)), None), simple("Respuesta de prueba"));
    let (alpha, beta) = (profile_id(&f, "alpha"), profile_id(&f, "beta"));
    let a = f.post("/api/conversations", json!({ "profileId": alpha })).await.1;
    let b = f.post("/api/conversations", json!({ "profileId": beta })).await.1;
    assert_eq!((a["profileId"].as_str(), b["profileId"].as_str()), (Some(alpha.as_str()), Some(beta.as_str())));
    assert_eq!(f.post("/api/conversations", json!({ "profileId": alpha, "tools": ["terminal"] })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(f.post("/api/conversations", json!({ "profileId": "profile-000000000000000000000000" })).await.0, StatusCode::FORBIDDEN);
    let a_messages = format!("/api/conversations/{}/messages", a["id"].as_str().unwrap());
    let b_messages = format!("/api/conversations/{}/messages", b["id"].as_str().unwrap());
    assert_eq!(f.post(&a_messages, json!({ "message": "hola", "documentId": "../.env" })).await.0, StatusCode::FORBIDDEN);
    let (status, sent) = f.post(&a_messages, json!({ "message": "hola" })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(sent["messages"][0]["identity"]["profileId"], alpha.as_str());
    let turns = f.turns();
    let first = turns[0].profile.as_ref().unwrap();
    assert_eq!(first.name, "alpha");
    assert!(first.files.iter().any(|file| file.content == "Recuerdo de alpha."));
    f.post(&b_messages, json!({ "message": "hola beta" })).await;
    let turns = f.turns();
    assert_eq!((turns[1].profile.as_ref().unwrap().name.as_str(), turns[1].history.len()), ("beta", 0));
    assert_ne!(turns[0].session_id, turns[1].session_id);
    assert_eq!(f.post_as(&a_messages, json!({ "message": "otro usuario" }), OTHER).await.0, StatusCode::NOT_FOUND);
    let root = f.base.join("hermes/profiles");
    fs::write(root.join("alpha/memories/MEMORY.md"), "Memoria actualizada").unwrap();
    f.post(&a_messages, json!({ "message": "continúa" })).await;
    let turns = f.turns();
    assert_eq!(turns[2].history.len(), 2);
    assert!(turns[2].profile.as_ref().unwrap().files.iter().any(|file| file.content == "Memoria actualizada"));
    // A profile can be consulted about a document too: the turn carries both its identity and the document.
    let with_document = f.post(&a_messages, json!({ "message": "resume", "documentId": "welcome" })).await.1;
    let turns = f.turns();
    assert_eq!(turns[3].document.as_ref().unwrap().id, "welcome");
    let all = with_document["messages"].as_array().unwrap();
    let asked = &all[all.len() - 2];
    assert_eq!((asked["sources"][0]["id"].as_str(), asked["identity"]["profileId"].as_str()), (Some("welcome"), Some(alpha.as_str())));
    let before = f.turns().len();
    fs::remove_file(root.join("alpha/SOUL.md")).unwrap();
    symlink(&root.join("beta/SOUL.md"), &root.join("alpha/SOUL.md")).unwrap();
    assert_eq!(f.post(&a_messages, json!({ "message": "no ejecutar" })).await.0, StatusCode::FORBIDDEN);
    fs::create_dir(root.join(".deleted")).unwrap();
    fs::write(root.join(".deleted/beta"), "1").unwrap();
    assert_eq!(f.post(&b_messages, json!({ "message": "no ejecutar" })).await.0, StatusCode::FORBIDDEN);
    assert_eq!(f.turns().len(), before);
    let luma = f.luma().await;
    f.post(&format!("/api/conversations/{luma}/messages"), json!({ "message": "hola Luma" })).await;
    assert!(f.turns().last().unwrap().profile.is_none());
}

#[tokio::test]
async fn una_nota_consultada_llega_por_id_recortada_y_sin_rutas() {
    let f = fixture(
        |base| {
            fs::create_dir_all(base.join("vault/Ideas")).unwrap();
            fs::write(base.join("vault/Ideas/Larga.md"), format!("CLAVE-NOTA-731\n{}", "y".repeat(40 * 1024))).unwrap();
            fs::write(base.join("obsidian.json"), json!({ "vaults": { "a": { "path": base.join("vault") } } }).to_string()).unwrap();
            (None, Some(base.join("obsidian.json")))
        },
        simple("ok"),
    );
    let vault = obsidian_vaults(f.state.config.obsidian_registry.as_deref()).vaults[0].id.clone();
    let notes = f.get(&format!("/api/hermes/vaults/{vault}/notes"), ME).await.1;
    let note = notes["notes"][0]["id"].as_str().unwrap().to_string();
    let id = f.luma().await;
    assert_eq!(f.post(&format!("/api/conversations/{id}/messages"), json!({ "message": "¿Qué clave aparece?", "documentId": note })).await.0, StatusCode::OK);
    let document = f.turns()[0].document.clone().unwrap();
    assert_eq!((document.id.as_str(), document.title.as_str()), (note.as_str(), "vault · Ideas/Larga"));
    assert!(document.content.starts_with("CLAVE-NOTA-731") && document.content.len() <= 24 * 1024);
    assert!(!format!("{document:?}").contains(&f.base.display().to_string()));
}

#[tokio::test]
async fn adjuntos_en_chats_de_perfil_copias_ajenas_notas_y_perfil_revocado() {
    let f = fixture(
        |base| {
            let root = profiles(base);
            fs::create_dir_all(base.join("vault/Ideas")).unwrap();
            fs::write(base.join("vault/Ideas/Plan.md"), "CLAVE-PERFIL-404").unwrap();
            fs::write(base.join("obsidian.json"), json!({ "vaults": { "a": { "path": base.join("vault") } } }).to_string()).unwrap();
            (Some(root), Some(base.join("obsidian.json")))
        },
        simple("ok"),
    );
    let alpha = profile_id(&f, "alpha");
    let upload = json!({ "name": "privado.md", "base64": base64::engine::general_purpose::STANDARD.encode("Dato privado: RIO-88") });
    let imported = f.post("/api/library/imports", upload).await.1;
    // Another browser identity cannot attach this copy, not even through a profile chat.
    let foreign = f.post_as("/api/conversations", json!({ "profileId": alpha }), OTHER).await.1;
    let foreign_messages = format!("/api/conversations/{}/messages", foreign["id"].as_str().unwrap());
    assert_eq!(f.post_as(&foreign_messages, json!({ "message": "lee", "documentId": imported["id"] }), OTHER).await.0, StatusCode::FORBIDDEN);
    assert!(f.turns().is_empty());
    let own = f.post("/api/conversations", json!({ "profileId": alpha })).await.1;
    let own_messages = format!("/api/conversations/{}/messages", own["id"].as_str().unwrap());
    let vault = obsidian_vaults(f.state.config.obsidian_registry.as_deref()).vaults[0].id.clone();
    let note = f.get(&format!("/api/hermes/vaults/{vault}/notes"), ME).await.1["notes"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(f.post(&own_messages, json!({ "message": "¿Clave?", "documentId": note })).await.0, StatusCode::OK);
    assert!(f.turns()[0].document.as_ref().unwrap().content.starts_with("CLAVE-PERFIL-404"));
    // A revoked profile gets nothing, attachment included.
    let soul = f.base.join("hermes/profiles/alpha/SOUL.md");
    fs::remove_file(&soul).unwrap();
    symlink(&f.base.join("vault/Ideas/Plan.md"), &soul).unwrap();
    assert_eq!(f.post(&own_messages, json!({ "message": "otra vez", "documentId": note })).await.0, StatusCode::FORBIDDEN);
    assert_eq!(f.turns().len(), 1);
}

#[tokio::test]
async fn acciones_de_perfiles_solo_el_dueno_y_nombres_de_herramientas_no_datos() {
    let events = vec![json!({ "type": "tool", "state": "start", "name": "read_file" }), json!({ "type": "tool", "state": "end", "name": "read_file" })];
    let f = fixture(|base| (Some(profiles(base)), None), move |turns| recording(turns, events, Ok("Leído")));
    let alpha = profile_id(&f, "alpha");
    let conversation = f.post("/api/conversations", json!({ "profileId": alpha })).await.1;
    let id = conversation["id"].as_str().unwrap();
    let sent = f.post(&format!("/api/conversations/{id}/messages"), json!({ "message": "lee" })).await.1;
    assert_eq!(sent["messages"][1]["tools"], json!(["read_file"]));
    let request = "a".repeat(32);
    let url = format!("/api/conversations/{id}/approvals/{request}");
    assert_eq!(f.call("POST", &url, Some(r#"{"choice":"once"}"#), ME, &[("x-agora-csrf", "")]).await.0, StatusCode::FORBIDDEN);
    assert_eq!(f.post(&url, json!({ "choice": "always" })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(f.post(&url, json!({ "choice": "once" })).await, (StatusCode::NOT_FOUND, json!({ "error": "Esta acción ya no está pendiente." })));
    assert_eq!(f.post(&format!("/api/conversations/{id}/approvals/..%2Fx"), json!({ "choice": "once" })).await.0, StatusCode::NOT_FOUND);
    let luma = f.luma().await;
    assert_eq!(f.post(&format!("/api/conversations/{luma}/approvals/{request}"), json!({ "choice": "once" })).await.0, StatusCode::NOT_FOUND);
    assert_eq!(f.post(&format!("/api/conversations/conversation-ajena/approvals/{request}"), json!({ "choice": "once" })).await.0, StatusCode::NOT_FOUND);
    assert_eq!(f.post(&format!("/api/conversations/{id}/cancel"), json!({})).await, (StatusCode::NOT_FOUND, json!({ "error": "No hay ningún turno en curso." })));
    assert_eq!(f.call("POST", &format!("/api/conversations/{id}/cancel"), Some("{}"), ME, &[("x-agora-csrf", "")]).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn documentos_por_id_y_cada_turno_revalida_el_archivo() {
    let f = fixture(|_| (None, None), simple("Respuesta de prueba"));
    let id = f.luma().await;
    let path = format!("/api/conversations/{id}/messages");
    assert_eq!(f.post(&path, json!({ "message": "lee", "documentId": "../.env" })).await.0, StatusCode::FORBIDDEN);
    assert_eq!(f.post(&path, json!({ "message": "lee", "documentId": "welcome", "document": { "content": "falso" } })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(f.post_as(&path, json!({ "message": "lee", "documentId": "welcome" }), OTHER).await.0, StatusCode::NOT_FOUND);
    assert!(f.turns().is_empty());
    let welcome = f.get("/api/library/documents/welcome", ME).await.1;
    let (status, result) = f.post(&path, json!({ "message": "resume", "documentId": "welcome" })).await;
    assert_eq!(status, StatusCode::OK);
    assert!(f.turns()[0].document.as_ref().unwrap().content.contains("FARO-274"));
    assert_eq!(result["messages"][0]["sources"][0]["revision"], welcome["revision"]);
    assert_eq!(result["messages"][0]["content"], "resume");
    f.post(&path, json!({ "message": "sin adjunto" })).await;
    assert!(f.turns()[1].document.is_none());
    // Replacing the example with a link revokes it for the next turn.
    let example = f.base.join("ejemplos/bienvenida.txt");
    fs::remove_file(&example).unwrap();
    symlink(Path::new("/etc/hosts"), &example).unwrap();
    assert_eq!(f.post(&path, json!({ "message": "leer", "documentId": "welcome" })).await.0, StatusCode::FORBIDDEN);
    assert_eq!(f.turns().len(), 2);
}

#[tokio::test]
async fn copias_borradas_ya_no_se_adjuntan_y_el_historial_conserva_su_titulo() {
    let f = fixture(|_| (None, None), simple("respuesta de prueba"));
    let upload = json!({ "name": "prueba.md", "base64": base64::engine::general_purpose::STANDARD.encode("Texto original") });
    let imported = f.post("/api/library/imports", upload).await.1;
    let document = format!("/api/library/documents/{}", imported["id"].as_str().unwrap());
    f.call("PATCH", &document, Some(r#"{"title":"Mis notas"}"#), ME, &[]).await;
    let id = f.luma().await;
    let messages = format!("/api/conversations/{id}/messages");
    assert_eq!(f.post(&messages, json!({ "message": "consulta", "documentId": imported["id"] })).await.0, StatusCode::OK);
    assert_eq!(f.post_as(&format!("/api/conversations/{}/messages", f.luma().await), json!({ "message": "x", "documentId": imported["id"] }), OTHER).await.0, StatusCode::NOT_FOUND);
    assert_eq!(f.call("DELETE", &document, None, ME, &[]).await.0, StatusCode::OK);
    assert_eq!(f.post(&messages, json!({ "message": "otra consulta", "documentId": imported["id"] })).await.0, StatusCode::FORBIDDEN);
    assert_eq!(f.turns().len(), 1);
    let history = f.get(&format!("/api/conversations/{id}"), ME).await.1;
    assert_eq!(history["messages"].as_array().unwrap().len(), 2);
    assert_eq!(history["messages"][0]["sources"][0]["title"], "Mis notas");
}
