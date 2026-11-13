//! Ported from server/vault-notes.test.ts: listing, reading, search, the consult cut, hidden lines, and
//! editing or creating notes without following links or overwriting; plus the routes through the router.

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use agora_server::access::proof;
use agora_server::hermes::location::HermesLocation;
use agora_server::hermes::resources::obsidian_vaults;
use agora_server::security::Failure;
use agora_server::vault::{NoteEdit, NoteMove, VaultNote, VaultNotes};
use agora_server::{AppState, Config, router};
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

struct Fixture {
    _dir: tempfile::TempDir,
    base: PathBuf,
    vault: PathBuf,
    notes: VaultNotes,
    id: String,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(dir.path()).unwrap();
    let (vault, outside) = (base.join("Mi vault"), base.join("fuera"));
    fs::create_dir_all(vault.join("Proyectos/Activos")).unwrap();
    for folder in [vault.join(".obsidian"), vault.join(".trash"), outside.clone()] {
        fs::create_dir(folder).unwrap();
    }
    fs::write(vault.join("Inicio.md"), "# Inicio\nBienvenida al vault.").unwrap();
    fs::write(vault.join("Proyectos/Activos/Jardín.md"), "Plan del jardín\nRegar las TOMATERAS cada mañana.").unwrap();
    fs::write(vault.join("Proyectos/Largo.md"), format!("{}FINAL_OCULTO", "x".repeat(30 * 1024))).unwrap();
    fs::write(vault.join("Proyectos/Roto.md"), [0xff, 0xfe, 0x00]).unwrap();
    fs::write(vault.join(".obsidian/workspace.md"), "CANARY_CONFIG").unwrap();
    fs::write(vault.join(".trash/Borrada.md"), "CANARY_TRASH").unwrap();
    fs::write(vault.join("foto.png"), "CANARY_ATTACHMENT").unwrap();
    fs::write(outside.join("secreto.md"), "CANARY_OUTSIDE").unwrap();
    symlink(outside.join("secreto.md"), vault.join("Enlace.md")).unwrap();
    symlink(&outside, vault.join("Carpeta enlazada")).unwrap();
    let registry = base.join("obsidian.json");
    fs::write(&registry, json!({ "vaults": { "a": { "path": vault } } }).to_string()).unwrap();
    let id = obsidian_vaults(Some(&registry)).vaults[0].id.clone();
    Fixture { _dir: dir, notes: VaultNotes::new(Some(registry)), base, vault, id }
}

fn by_title(f: &Fixture, title: &str) -> VaultNote {
    f.notes.list(&f.id, false).unwrap().notes.into_iter().find(|n| n.title == title).unwrap()
}

fn status<T: std::fmt::Debug>(result: Result<T, Failure>) -> u16 {
    result.expect_err("debía fallar").status.as_u16()
}

fn edit(content: &str, revision: &str) -> NoteEdit {
    NoteEdit { content: content.into(), revision: revision.into(), revealed: false }
}

fn read(path: impl AsRef<Path>) -> String {
    fs::read_to_string(path).unwrap()
}

#[test]
fn lista_solo_notas_markdown_propias() {
    let f = fixture();
    let list = f.notes.list(&f.id, false).unwrap();
    assert_eq!(list.vault.name, "Mi vault");
    let mut seen: Vec<String> = list.notes.iter().map(|n| format!("{}|{}", n.folder, n.title)).collect();
    seen.sort();
    assert_eq!(seen, ["Proyectos/Activos|Jardín", "Proyectos|Largo", "Proyectos|Roto", "|Inicio"]);
    let text = serde_json::to_string(&list).unwrap();
    for leak in ["CANARY", "/Users", "/private", "fuera", "file"] {
        assert!(!text.contains(leak), "{leak}");
    }
    assert!(list.notes.iter().all(|n| n.id.len() == 29 && n.id.starts_with("note-")));
    assert_eq!(status(f.notes.list("vault-desconocido", false)), 404);
}

#[test]
fn el_recorrido_ordena_como_locale_compare() {
    let mut names = vec!["Zeta", "Árbol", "abeja", "1 uno", "🔑 claves", "Informar", "Información", "arbol", "Arbol"];
    names.sort_by(|a, b| agora_server::js::locale_cmp(a, b));
    assert_eq!(names, ["🔑 claves", "1 uno", "abeja", "arbol", "Arbol", "Árbol", "Información", "Informar", "Zeta"]);
}

#[test]
fn lectura_por_id_opaco_y_busqueda_sin_tildes() {
    let f = fixture();
    let garden = by_title(&f, "Jardín");
    let note = f.notes.read(&f.id, &garden.id, false).unwrap();
    assert!(note.content.contains("TOMATERAS"));
    assert_eq!(note.revision.len(), 64);
    assert_eq!(status(f.notes.read(&f.id, &by_title(&f, "Roto").id, false)), 404);
    assert_eq!(status(f.notes.read(&f.id, "note-000000000000000000000000", false)), 404);
    let titles: Vec<String> = f.notes.search(&f.id, "jardin").unwrap().results.into_iter().map(|r| r.title).collect();
    assert_eq!(titles, ["Jardín"]);
    assert_eq!(f.notes.search(&f.id, "tomateras").unwrap().results[0].snippet, "Regar las TOMATERAS cada mañana.");
    assert!(f.notes.search(&f.id, "CANARY").unwrap().results.is_empty());
}

#[test]
fn una_nota_en_consulta_se_recorta_a_24_kib() {
    let f = fixture();
    let document = f.notes.document(&by_title(&f, "Largo").id).unwrap();
    assert_eq!(document.title, "Mi vault · Proyectos/Largo");
    assert!(!document.content.contains("FINAL_OCULTO"));
    assert!(document.content.ends_with("[Nota recortada a 24 KiB para la consulta]"));
    assert!(document.content.len() <= 24 * 1024, "el documento completo cabe en el límite del puente");
    assert_eq!(status(f.notes.document("note-000000000000000000000000")), 404);
}

#[test]
fn las_lineas_con_pinta_de_clave_se_ocultan_salvo_peticion() {
    let f = fixture();
    fs::write(f.vault.join("Cuentas.md"), "Servicio de correo\npassword: CANARY_NOTE_SECRET\nRenovar en marzo.").unwrap();
    let id = by_title(&f, "Cuentas").id;
    let note = f.notes.read(&f.id, &id, false).unwrap();
    assert_eq!(note.hidden, 1);
    assert!(!note.content.contains("CANARY") && note.content.contains("Renovar en marzo"));
    assert!(f.notes.read(&f.id, &id, true).unwrap().content.contains("CANARY_NOTE_SECRET"));
    assert!(!serde_json::to_string(&f.notes.search(&f.id, "canary").unwrap()).unwrap().contains("CANARY"));
    assert!(!f.notes.document(&id).unwrap().content.contains("CANARY"));
}

#[test]
fn una_carpeta_ilegible_no_impide_listar_el_resto() {
    let f = fixture();
    let all = f.notes.list(&f.id, false).unwrap().notes.len();
    let folder = f.vault.join("Proyectos/Activos");
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o000)).unwrap();
    let after = f.notes.list(&f.id, true);
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
    let after = after.unwrap();
    assert!(after.notes.iter().any(|n| n.title == "Inicio"));
    assert!(after.notes.len() < all);
    assert!(after.truncated);
}

#[test]
fn guarda_con_copia_conserva_lineas_ocultas_y_respeta_cambios_de_fuera() {
    let f = fixture();
    let backups = f.base.join("copias");
    let file = f.vault.join("Claves.md");
    fs::write(&file, "Servicio\napi_key: CANARY_VAULT_KEY\nfin").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
    let note = by_title(&f, "Claves");
    let opened = f.notes.read(&f.id, &note.id, false).unwrap();
    assert!(!opened.content.contains("CANARY"));
    let saved = f.notes.save(&f.id, &note.id, edit(&opened.content.replace("fin", "final editado"), &opened.revision), &backups).unwrap();
    assert_eq!(read(&file), "Servicio\napi_key: CANARY_VAULT_KEY\nfinal editado", "la línea oculta vuelve de disco");
    assert_eq!(fs::metadata(&file).unwrap().mode() & 0o777, 0o640, "conserva los permisos");
    assert_eq!(f.notes.read(&f.id, &note.id, false).unwrap().revision, saved.revision, "la lectura ve la versión nueva");
    let copies: Vec<_> = fs::read_dir(backups.join(&f.id)).unwrap().flatten().collect();
    assert_eq!(copies.len(), 1);
    assert_eq!(read(copies[0].path()), "Servicio\napi_key: CANARY_VAULT_KEY\nfin");
    assert_eq!(fs::metadata(copies[0].path()).unwrap().mode() & 0o777, 0o600);
    // Changed in Obsidian meanwhile: the old revision no longer saves.
    fs::write(&file, "otra cosa").unwrap();
    assert_eq!(status(f.notes.save(&f.id, &note.id, edit("pisado", &saved.revision), &backups)), 409);
    assert_eq!(read(&file), "otra cosa");
    let fresh = f.notes.read(&f.id, &note.id, false).unwrap();
    assert_eq!(status(f.notes.save(&f.id, &note.id, edit("a\u{7}b", &fresh.revision), &backups)), 400);
    assert_eq!(status(f.notes.save(&f.id, &format!("note-{}", "0".repeat(24)), edit("x", &fresh.revision), &backups)), 404);
}

#[test]
fn no_escribe_por_enlaces_ni_crea_fuera_de_carpetas_existentes_o_pisando() {
    let f = fixture();
    let backups = f.base.join("copias");
    // A note that became a hard link after it was listed is refused, and nothing is written.
    let note = by_title(&f, "Inicio");
    let revision = f.notes.read(&f.id, &note.id, false).unwrap().revision;
    fs::hard_link(f.vault.join("Inicio.md"), f.base.join("segundo-nombre.md")).unwrap();
    assert_eq!(status(f.notes.save(&f.id, &note.id, edit("cambio", &revision), &backups)), 404);
    assert_eq!(read(f.vault.join("Inicio.md")), "# Inicio\nBienvenida al vault.");

    let created = f.notes.create(&f.id, "Proyectos/Activos", "Huerto nuevo", "# Huerto\nSemillas.").unwrap();
    assert_eq!(read(f.vault.join("Proyectos/Activos/Huerto nuevo.md")), "# Huerto\nSemillas.");
    assert_eq!(by_title(&f, "Huerto nuevo").id, created.id, "aparece en el listado al momento");
    assert_eq!(status(f.notes.create(&f.id, "Proyectos/Activos", "Huerto nuevo", "pisar")), 409);
    assert_eq!(read(f.vault.join("Proyectos/Activos/Huerto nuevo.md")), "# Huerto\nSemillas.");
    for title in ["../fuera".to_string(), "a/b".into(), ".oculta".into(), "".into(), "x".repeat(260), "ñ".repeat(130), "a:b".into(), "a\u{202e}b".into()] {
        assert_eq!(status(f.notes.create(&f.id, "", &title, "x")), 400, "{title}");
    }
    for folder in ["Carpeta enlazada", "../fuera", "No existe"] {
        assert_eq!(status(f.notes.create(&f.id, folder, "Nota", "x")), 404, "{folder}");
    }
    assert!(!f.base.join("fuera/Nota.md").exists());
    f.notes.create(&f.id, "", "En la raíz", "texto").unwrap();
    assert_eq!(read(f.vault.join("En la raíz.md")), "texto");
}

#[test]
fn conserva_archivo_finales_de_linea_bom_y_permisos() {
    let f = fixture();
    let backups = f.base.join("copias");
    fs::write(f.vault.join("Control.md"), "texto\u{c}página").unwrap();
    let crlf = f.vault.join("Windows.md");
    fs::write(&crlf, [&[0xef, 0xbb, 0xbf][..], b"uno\r\napi_key: CANARY_CRLF\r\ndos"].concat()).unwrap();
    fs::set_permissions(&crlf, fs::Permissions::from_mode(0o664)).unwrap();
    let before = fs::metadata(&crlf).unwrap();
    let note = by_title(&f, "Windows");
    let opened = f.notes.read(&f.id, &note.id, false).unwrap();
    f.notes.save(&f.id, &note.id, edit(&opened.content.replace("dos", "tres"), &opened.revision), &backups).unwrap();
    let bytes = fs::read(&crlf).unwrap();
    assert_eq!(&bytes[..3], [0xef, 0xbb, 0xbf], "el BOM se conserva");
    assert_eq!(String::from_utf8_lossy(&bytes[3..]), "uno\r\napi_key: CANARY_CRLF\r\ntres", "CRLF en todas las líneas");
    let after = fs::metadata(&crlf).unwrap();
    assert_eq!(after.ino(), before.ino(), "el mismo archivo: Obsidian conserva su fecha de creación");
    assert_eq!(after.mode() & 0o777, 0o664);

    let control = by_title(&f, "Control");
    let revision = f.notes.read(&f.id, &control.id, false).unwrap().revision;
    assert_eq!(status(f.notes.save(&f.id, &control.id, edit("nuevo", &revision), &backups)), 400);
    assert_eq!(read(f.vault.join("Control.md")), "texto\u{c}página");
}

fn target(folder: &str, title: &str, revision: &str) -> NoteMove {
    NoteMove { folder: folder.into(), title: title.into(), revision: revision.into() }
}

#[test]
fn mover_y_renombrar_conserva_el_archivo_copia_antes_y_nunca_pisa() {
    let f = fixture();
    let backups = f.base.join("copias");
    let file = f.vault.join("Inicio.md");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
    let before = fs::metadata(&file).unwrap();
    let note = by_title(&f, "Inicio");
    let revision = f.notes.read(&f.id, &note.id, false).unwrap().revision;
    let moved = f.notes.move_note(&f.id, &note.id, target("Proyectos/Activos", "Portada", &revision), &backups).unwrap();
    let dest = f.vault.join("Proyectos/Activos/Portada.md");
    assert!(!file.exists());
    assert_eq!(read(&dest), "# Inicio\nBienvenida al vault.");
    let after = fs::metadata(&dest).unwrap();
    assert_eq!((after.ino(), after.mode() & 0o777, after.nlink()), (before.ino(), 0o640, 1), "el mismo archivo, sus permisos y un solo nombre");
    assert_eq!((moved.folder.as_str(), moved.title.as_str()), ("Proyectos/Activos", "Portada"));
    assert_eq!(by_title(&f, "Portada").id, moved.id, "aparece en el listado con su id nuevo");
    assert_eq!(fs::read_dir(backups.join(&f.id)).unwrap().count(), 1, "copia previa");

    // Never overwrites, never with an old revision, never to the same place or a bad target.
    let garden = by_title(&f, "Jardín");
    let current = f.notes.read(&f.id, &garden.id, false).unwrap().revision;
    assert_eq!(status(f.notes.move_note(&f.id, &garden.id, target("Proyectos/Activos", "Portada", &current), &backups)), 409);
    assert_eq!(status(f.notes.move_note(&f.id, &garden.id, target("", "Huerta", &"f".repeat(64)), &backups)), 409);
    assert_eq!(status(f.notes.move_note(&f.id, &garden.id, target("Proyectos/Activos", "Jardín", &current), &backups)), 400);
    assert_eq!(status(f.notes.move_note(&f.id, &garden.id, target("", "../fuera", &current), &backups)), 400);
    for folder in ["Carpeta enlazada", "../fuera", "No existe"] {
        assert_eq!(status(f.notes.move_note(&f.id, &garden.id, target(folder, "X", &current), &backups)), 404, "{folder}");
    }
    assert_eq!(read(&dest), "# Inicio\nBienvenida al vault.");
    assert_eq!(read(f.vault.join("Proyectos/Activos/Jardín.md")), "Plan del jardín\nRegar las TOMATERAS cada mañana.");

    // Only the case changes: also on a disk that ignores case.
    let renamed = f.notes.move_note(&f.id, &garden.id, target("Proyectos/Activos", "jardín", &current), &backups).unwrap();
    let mut names: Vec<String> = fs::read_dir(f.vault.join("Proyectos/Activos")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, ["Portada.md", "jardín.md"]);
    assert_eq!(by_title(&f, "jardín").id, renamed.id);

    // A note that became a hard link is not moved.
    let portada = by_title(&f, "Portada");
    let rev = f.notes.read(&f.id, &portada.id, false).unwrap().revision;
    fs::hard_link(&dest, f.base.join("otro-nombre.md")).unwrap();
    assert_eq!(status(f.notes.move_note(&f.id, &portada.id, target("", "Inicio", &rev), &backups)), 404);
    assert!(dest.exists());
}

const TOKEN: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const HOST: &str = "127.0.0.1:4317";

async fn call(state: &Arc<AppState>, method: &str, path: &str, csrf: bool, body: Option<Value>) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, HOST)
        .header(header::ORIGIN, format!("http://{HOST}"))
        .header(header::COOKIE, format!("agora_access={}", proof(TOKEN)))
        .header(header::CONTENT_TYPE, "application/json");
    if csrf {
        request = request.header("x-agora-csrf", &state.csrf);
    }
    let body = body.map(|b| Body::from(b.to_string())).unwrap_or_else(Body::empty);
    let response = router(state.clone()).oneshot(request.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn rutas_del_vault_con_csrf_y_validacion() {
    let f = fixture();
    let hermes = HermesLocation { root: f.base.clone(), installation: f.base.join("hermes-agent"), python: f.base.join("python"), source: "test".into() };
    let config = Config { data: f.base.join("datos"), web: f.base.clone(), hosts: vec![HOST.into()], hermes, obsidian_registry: Some(f.base.join("obsidian.json")) };
    let state = AppState::new(config, TOKEN, None);
    let notes = format!("/api/hermes/vaults/{}/notes", f.id);
    assert_eq!(call(&state, "GET", &notes, false, None).await.0, StatusCode::FORBIDDEN);
    let (status, list) = call(&state, "GET", &notes, true, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["vault"]["name"], "Mi vault");
    let (status, body) = call(&state, "GET", "/api/hermes/vaults/vault-otro/notes", true, None).await;
    assert_eq!((status, body), (StatusCode::NOT_FOUND, json!({ "error": "Vault no disponible." })));
    let garden = list["notes"].as_array().unwrap().iter().find(|n| n["title"] == "Jardín").unwrap()["id"].as_str().unwrap().to_string();
    let (status, note) = call(&state, "GET", &format!("{notes}/{garden}"), true, None).await;
    assert_eq!(status, StatusCode::OK);
    let keys: Vec<&String> = note.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["id", "title", "folder", "bytes", "modifiedAt", "readable", "content", "hidden", "revision"]);
    let search = format!("/api/hermes/vaults/{}/search", f.id);
    assert_eq!(call(&state, "GET", &format!("{search}?q=%20a%20"), true, None).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(call(&state, "GET", &format!("{search}?q=jard%C3%ADn"), true, None).await.1["results"][0]["title"], "Jardín");

    let revision = note["revision"].as_str().unwrap();
    let put = format!("{notes}/{garden}");
    let (status, body) = call(&state, "PUT", &put, true, Some(json!({ "content": "x", "revision": revision, "extra": 1 }))).await;
    assert_eq!((status, body), (StatusCode::BAD_REQUEST, json!({ "error": "Contenido no válido." })));
    assert_eq!(call(&state, "PUT", &put, false, Some(json!({ "content": "x", "revision": revision }))).await.0, StatusCode::FORBIDDEN);
    let (status, saved) = call(&state, "PUT", &put, true, Some(json!({ "content": "Plan nuevo", "revision": revision }))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["id"], garden.as_str());
    assert_eq!(read(f.vault.join("Proyectos/Activos/Jardín.md")), "Plan nuevo");
    assert!(f.base.join("datos/vault-backups").join(&f.id).is_dir(), "la copia va a los datos de AgoraOne");

    let (status, created) = call(&state, "POST", &notes, true, Some(json!({ "folder": "", "title": "Nueva", "content": "hola" }))).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["title"], "Nueva");
    let (status, body) = call(&state, "POST", &notes, true, Some(json!({ "folder": "", "title": "Nueva" }))).await;
    assert_eq!((status, body), (StatusCode::BAD_REQUEST, json!({ "error": "Datos de la nota no válidos." })));
    assert_eq!(call(&state, "POST", &notes, true, Some(json!({ "folder": "", "title": "Nueva", "content": "otra" }))).await.0, StatusCode::CONFLICT);

    let created_id = created["id"].as_str().unwrap();
    let (_, nueva) = call(&state, "GET", &format!("{notes}/{created_id}"), true, None).await;
    let move_path = format!("{notes}/{created_id}/move");
    let body = json!({ "folder": "Proyectos", "title": "Movida", "revision": nueva["revision"] });
    assert_eq!(call(&state, "POST", &move_path, false, Some(body.clone())).await.0, StatusCode::FORBIDDEN);
    let (status, refused) = call(&state, "POST", &move_path, true, Some(json!({ "folder": "Proyectos", "title": "Movida" }))).await;
    assert_eq!((status, refused), (StatusCode::BAD_REQUEST, json!({ "error": "Datos del cambio no válidos." })));
    let (status, moved) = call(&state, "POST", &move_path, true, Some(body)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((moved["folder"].as_str(), moved["title"].as_str()), (Some("Proyectos"), Some("Movida")));
    assert_eq!(read(f.vault.join("Proyectos/Movida.md")), "hola");
}
