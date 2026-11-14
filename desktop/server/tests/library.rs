//! Ported from server/library.test.ts, private-library.test.ts, document-extraction.test.ts and the library
//! routes of app.test.ts: examples by id, private copies per owner, PDF/DOCX extraction with the core's
//! Python inside the sandbox, and the HTTP contract.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use agora_server::access::proof;
use agora_server::hermes::location::HermesLocation;
use agora_server::library::extract::{Extractor, extract_upload, sandboxed};
use agora_server::library::{PrivateLibrary, read_example};
use agora_server::{AppState, Config, router};
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn temp() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(dir.path()).unwrap();
    (dir, base)
}

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

fn mode(path: impl AsRef<Path>) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

/// The core's own Python and folder, as in development.
fn extractor() -> Option<Extractor> {
    let folder = fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../core")).ok()?;
    let python = folder.join(".venv/bin/python");
    python.exists().then_some(Extractor { python, folder })
}

fn pdf_fixture(text: &str, pages: usize) -> Vec<u8> {
    let stream = format!("BT /F1 12 Tf 20 100 Td ({}) Tj ET", text.replace('\\', "\\\\").replace('(', "\\(").replace(')', "\\)"));
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        format!("<< /Type /Pages /Kids [{}] /Count {pages} >>", vec!["3 0 R"; pages].join(" ")),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".into(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into(),
        format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
    ];
    let mut pdf = String::from("%PDF-1.4\n");
    let mut offsets = vec![];
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf += &format!("{} 0 obj\n{object}\nendobj\n", index + 1);
    }
    let xref = pdf.len();
    let rows: String = offsets.iter().map(|o| format!("{o:010} 00000 n \n")).collect();
    pdf += &format!("xref\n0 6\n0000000000 65535 f \n{rows}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n");
    pdf.into_bytes()
}

fn docx_fixture(text: &str, oversized: bool) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("[Content_Types].xml", options).unwrap();
    zip.write_all(br#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#).unwrap();
    zip.start_file("word/document.xml", options).unwrap();
    let escaped = text.replace('&', "&amp;").replace('<', "&lt;");
    zip.write_all(format!(r#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{escaped}</w:t></w:r></w:p></w:body></w:document>"#).as_bytes()).unwrap();
    if oversized {
        zip.start_file("word/padding.bin", options).unwrap();
        zip.write_all(&vec![0; 17 * 1024 * 1024]).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

#[test]
fn ejemplos_por_id_utf8_y_revision() {
    let (_dir, root) = temp();
    fs::write(root.join("bienvenida.txt"), "Texto de prueba con acentos: lectura.").unwrap();
    let document = read_example(&root, "welcome").unwrap();
    assert!(document.content.contains("acentos"));
    assert_eq!(document.revision.len(), 64);
    fs::write(root.join("bienvenida.txt"), "Versión nueva").unwrap();
    assert_ne!(read_example(&root, "welcome").unwrap().revision, document.revision);
    for id in ["../.env", "/etc/passwd", "bienvenida.txt", "%2e%2e", "constructor", "unknown"] {
        assert!(read_example(&root, id).is_err(), "{id}");
    }
}

#[test]
fn ejemplos_rechazan_enlaces_raiz_redirigida_tamano_y_binarios() {
    let (_dir, base) = temp();
    let root = base.join("root");
    fs::create_dir(&root).unwrap();
    let (outside, file) = (base.join("outside.txt"), root.join("bienvenida.txt"));
    fs::write(&outside, "No autorizado").unwrap();
    symlink(&outside, &file).unwrap();
    assert!(read_example(&root, "welcome").is_err());
    fs::remove_file(&file).unwrap();
    fs::hard_link(&outside, &file).unwrap();
    assert!(read_example(&root, "welcome").is_err());
    fs::remove_file(&file).unwrap();
    for bytes in ["x".repeat(24577).into_bytes(), vec![0xff, 0xfe], b"text\0data".to_vec()] {
        fs::write(&file, bytes).unwrap();
        assert!(read_example(&root, "welcome").is_err());
    }
    fs::write(&file, "válido").unwrap();
    assert!(read_example(&root, "welcome").is_ok());
    symlink(&root, base.join("alias")).unwrap();
    assert!(read_example(&base.join("alias"), "welcome").is_err());
    fs::remove_file(&file).unwrap();
    fs::create_dir(&file).unwrap();
    assert!(read_example(&root, "welcome").is_err());
}

#[test]
fn copias_privadas_persisten_con_permisos_propietario_y_nombres_sin_rutas() {
    let (_dir, root) = temp();
    let library = PrivateLibrary::new(root.clone());
    let base64 = b64("# Lectura\nSolo mi archivo.".as_bytes());
    let document = library.import("notas.md", &base64, OWNER).unwrap();
    assert!(document.id.starts_with("import-"));
    assert_eq!(PrivateLibrary::new(root.clone()).read(&document.id, OWNER).unwrap().content, "# Lectura\nSolo mi archivo.");
    assert_eq!(library.list(OWNER).len(), 1);
    assert!(library.list(OTHER).is_empty());
    assert!(library.read(&document.id, OTHER).is_err());
    let file = root.join(OWNER).join(format!("{}.json", document.id));
    assert_eq!((mode(&file), mode(root.join(OWNER))), (0o600, 0o700));
    for name in ["../notas.txt", "/tmp/notas.txt", "a\\b.md", ".env", "foto.exe", "x\0.txt"] {
        assert!(library.import(name, &base64, OWNER).is_err(), "{name}");
    }
    let link = root.join(OWNER).join("linked.json");
    fs::hard_link(&file, &link).unwrap();
    assert!(library.read(&document.id, OWNER).is_err());
    fs::remove_file(&link).unwrap();
    fs::remove_file(&file).unwrap();
    symlink("/etc/hosts", &file).unwrap();
    assert!(library.read(&document.id, OWNER).is_err());
}

#[test]
fn copias_privadas_rechazan_binarios_utf8_invalido_tamano_vacios_y_cuota() {
    let (_dir, root) = temp();
    let library = PrivateLibrary::new(root);
    for bytes in [vec![255, 254], b"a\0b".to_vec(), vec![65; 24577], b"   ".to_vec(), vec![]] {
        assert!(library.import("test.txt", &b64(&bytes), OWNER).is_err());
    }
    assert!(library.import("test.txt", "!invalid!", OWNER).is_err());
    for _ in 0..100 {
        library.import("test.txt", &b64(b"test"), OWNER).unwrap();
    }
    assert!(library.import("test.txt", &b64(b"test"), OWNER).is_err());
    assert_eq!(library.list(OWNER).len(), 100);
}

#[test]
fn renombrar_conserva_bytes_id_y_revision_y_borrar_rechaza_enlaces() {
    let (_dir, root) = temp();
    let library = PrivateLibrary::new(root.clone());
    let imported = library.import("notas.md", &b64("\u{feff}# Texto\r\n".as_bytes()), OWNER).unwrap();
    let file = root.join(OWNER).join(format!("{}.json", imported.id));
    let before: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    library.rename(&imported.id, OWNER, "Notas renombradas").unwrap();
    let after: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!((&after["base64"], &after["name"]), (&before["base64"], &before["name"]));
    let persisted = PrivateLibrary::new(root.clone()).read(&imported.id, OWNER).unwrap();
    assert_eq!((persisted.title.as_str(), persisted.revision.as_str()), ("Notas renombradas", imported.revision.as_str()));
    assert_eq!(mode(&file), 0o600);
    let link = root.join(OWNER).join("enlace-duro");
    fs::hard_link(&file, &link).unwrap();
    assert!(library.rename(&imported.id, OWNER, "No").is_err());
    assert!(library.delete(&imported.id, OWNER).is_err());
    fs::remove_file(&link).unwrap();
    library.delete(&imported.id, OWNER).unwrap();
    assert!(library.list(OWNER).is_empty());
    assert!(library.read(&imported.id, OWNER).is_err());
    assert!(library.delete(&imported.id, OWNER).is_err());
    assert!(library.rename(&imported.id, OWNER, "No").is_err());
}

#[tokio::test]
async fn extrae_pdf_y_docx_reales_y_rechaza_los_danados() {
    let Some(extractor) = extractor() else { return eprintln!("sin el entorno del núcleo: se omite") };
    for (name, bytes, marker) in [("prueba.pdf", pdf_fixture("Clave PDF: FARO-842", 1), "FARO-842"), ("prueba.docx", docx_fixture("Español: áéíóú, <script>texto</script> LUNA-913", false), "áéíóú")] {
        let text = extract_upload(Some(&extractor), name, &b64(&bytes)).await.unwrap();
        assert!(String::from_utf8(STANDARD.decode(text).unwrap()).unwrap().contains(marker), "{name}");
    }
    let refused = [
        ("falso.pdf", b"Texto normal".to_vec()),
        ("falso.docx", b"PKbad".to_vec()),
        ("vacio.pdf", pdf_fixture("", 1)),
        ("vacio.docx", docx_fixture("", false)),
        ("largo.docx", docx_fixture(&"a".repeat(24577), false)),
        ("expandido.docx", docx_fixture("test", true)),
        ("paginas.pdf", pdf_fixture("texto", 101)),
        ("grande.pdf", vec![0; 5 * 1024 * 1024 + 1]),
    ];
    for (name, bytes) in refused {
        assert!(extract_upload(Some(&extractor), name, &b64(&bytes)).await.is_err(), "{name}");
    }
}

#[tokio::test]
async fn el_extractor_no_puede_escribir_archivos_ni_usar_la_red() {
    if !Path::new("/usr/bin/sandbox-exec").exists() {
        return eprintln!("sin sandbox-exec: se omite");
    }
    let (_dir, base) = temp();
    let python = Path::new("/usr/bin/python3");
    let target = base.join("escrito.txt");
    let write = sandboxed(python).arg("-c").arg(format!("open({:?}, 'w').write('x')", target.display().to_string())).output().await.unwrap();
    assert!(!write.status.success() && !target.exists(), "no escribe archivos");
    let net = sandboxed(python).arg("-c").arg("import socket; socket.create_connection(('127.0.0.1', 9), timeout=2)").output().await.unwrap();
    assert!(String::from_utf8_lossy(&net.stderr).contains("PermissionError") || String::from_utf8_lossy(&net.stderr).contains("Operation not permitted"), "sin red");
    let read = sandboxed(python).arg("-c").arg("print('ok')").output().await.unwrap();
    assert_eq!(String::from_utf8_lossy(&read.stdout).trim(), "ok", "lo demás funciona");
}

const TOKEN: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const HOST: &str = "127.0.0.1:4317";

async fn call(state: &Arc<AppState>, method: &str, path: &str, user: &str, csrf: bool, body: Option<String>) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::HOST, HOST)
        .header(header::ORIGIN, format!("http://{HOST}"))
        .header(header::COOKIE, format!("agora_access={}; agora_user={user}", proof(TOKEN)))
        .header(header::CONTENT_TYPE, "application/json");
    if csrf {
        request = request.header("x-agora-csrf", &state.csrf);
    }
    let response = router(state.clone()).oneshot(request.body(body.map(Body::from).unwrap_or_else(Body::empty)).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn rutas_de_la_biblioteca_propietario_csrf_limites_y_ejemplos_protegidos() {
    let (_dir, base) = temp();
    let examples = base.join("ejemplos");
    fs::create_dir(&examples).unwrap();
    fs::write(examples.join("bienvenida.txt"), "Clave del ejemplo: FARO-274").unwrap();
    let hermes = HermesLocation { root: base.clone(), installation: base.join("hermes-agent"), python: base.join("python"), source: "test".into() };
    let config = Config { data: base.join("datos"), web: base.clone(), hosts: vec![HOST.into()], hermes, obsidian_registry: None, examples, extractor: extractor() };
    let state = AppState::new(config, TOKEN, None);

    let (status, list) = call(&state, "GET", "/api/library/documents", OWNER, false, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((list["permissions"].clone(), list["documents"].as_array().unwrap().len()), (json!(["read"]), 2));
    assert!(!list.to_string().contains("filename"));
    let (_, welcome) = call(&state, "GET", "/api/library/documents/welcome", OWNER, false, None).await;
    assert!(welcome["content"].as_str().unwrap().contains("FARO-274"));
    assert_eq!(call(&state, "GET", "/api/library/documents/unknown", OWNER, false, None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(call(&state, "GET", "/api/library/documents/note-000000000000000000000000", OWNER, false, None).await.0, StatusCode::NOT_FOUND);
    let (status, body) = call(&state, "POST", "/api/library/documents/welcome", OWNER, true, Some(json!({ "content": "reescribir" }).to_string())).await;
    assert_eq!((status, body), (StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "Operación no disponible en la biblioteca." })));
    assert_eq!(call(&state, "GET", "/api/library/otra", OWNER, false, None).await.0, StatusCode::METHOD_NOT_ALLOWED);

    let body = json!({ "name": "privado.md", "base64": b64(b"Dato privado: LAGO-219") });
    assert_eq!(call(&state, "POST", "/api/library/imports", OWNER, false, Some(body.to_string())).await.0, StatusCode::FORBIDDEN);
    let mut extra = body.clone();
    extra["path"] = "/etc/hosts".into();
    assert_eq!(call(&state, "POST", "/api/library/imports", OWNER, true, Some(extra.to_string())).await.0, StatusCode::BAD_REQUEST);
    let long = json!({ "name": "privado.md", "base64": "A".repeat(50_000) });
    let (status, refused) = call(&state, "POST", "/api/library/imports", OWNER, true, Some(long.to_string())).await;
    assert_eq!((status, refused), (StatusCode::BAD_REQUEST, json!({ "error": "Texto no válido. Usa UTF-8 y un máximo de 24 KiB." })));
    let huge = json!({ "name": "privado.md", "base64": "A".repeat(8 * 1024 * 1024) });
    let (status, refused) = call(&state, "POST", "/api/library/imports", OWNER, true, Some(huge.to_string())).await;
    assert_eq!((status, refused), (StatusCode::PAYLOAD_TOO_LARGE, json!({ "error": "El archivo o la solicitud supera el tamaño permitido." })), "también en JSON");
    let (status, imported) = call(&state, "POST", "/api/library/imports", OWNER, true, Some(body.to_string())).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(imported["title"], "privado.md");
    let path = format!("/api/library/documents/{}", imported["id"].as_str().unwrap());
    assert_eq!(call(&state, "GET", &path, OTHER, false, None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(call(&state, "GET", "/api/library/documents", OTHER, false, None).await.1["documents"].as_array().unwrap().len(), 2);
    assert_eq!(call(&state, "GET", "/api/library/documents", OWNER, false, None).await.1["documents"][2]["kind"], "private");

    // Examples cannot be renamed or deleted; another owner cannot touch a copy.
    let rename = json!({ "title": "Otro título" }).to_string();
    assert_eq!(call(&state, "PATCH", "/api/library/documents/welcome", OWNER, true, Some(rename.clone())).await.0, StatusCode::NOT_FOUND);
    assert_eq!(call(&state, "DELETE", "/api/library/documents/welcome", OWNER, true, None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(call(&state, "PATCH", &path, OTHER, true, Some(rename.clone())).await.0, StatusCode::NOT_FOUND);
    assert_eq!(call(&state, "PATCH", &path, OWNER, true, Some(json!({ "title": "../x" }).to_string())).await.0, StatusCode::BAD_REQUEST);
    let (status, renamed) = call(&state, "PATCH", &path, OWNER, true, Some(rename)).await;
    assert_eq!((status, renamed["title"].as_str()), (StatusCode::OK, Some("Otro título")));
    assert_eq!(call(&state, "DELETE", &path, OTHER, true, None).await.0, StatusCode::NOT_FOUND);
    let (status, deleted) = call(&state, "DELETE", &path, OWNER, true, None).await;
    assert_eq!((status, deleted["deleted"].as_str()), (StatusCode::OK, imported["id"].as_str()));
    assert_eq!(call(&state, "GET", &path, OWNER, false, None).await.0, StatusCode::NOT_FOUND);

    // PDF and DOCX through the route, with the core's Python.
    if state.config.extractor.is_some() {
        for (name, bytes, marker) in [("uno.pdf", pdf_fixture("Clave PDF: FARO-842", 1), "FARO-842"), ("dos.docx", docx_fixture("Clave DOCX: LUNA-913", false), "LUNA-913")] {
            let (status, doc) = call(&state, "POST", "/api/library/imports", OWNER, true, Some(json!({ "name": name, "base64": b64(&bytes) }).to_string())).await;
            assert_eq!(status, StatusCode::CREATED, "{name}");
            assert!(doc["content"].as_str().unwrap().contains(marker));
        }
        let (status, failed) = call(&state, "POST", "/api/library/imports", OWNER, true, Some(json!({ "name": "roto.pdf", "base64": b64(b"no es un pdf") }).to_string())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(failed["error"].as_str().unwrap().starts_with("No se pudo extraer el texto"));
    }
}
