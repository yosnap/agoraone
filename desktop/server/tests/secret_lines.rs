//! Ported from server/secret-lines.test.ts. Every credential below is a made-up placeholder.

use std::time::Instant;

use agora_server::secret_lines::{HiddenLineError, mask_secrets, restore_secrets};

#[test]
fn hides_whole_credential_lines_and_keeps_the_rest() {
    let sk = format!("{}-{}", "sk", "abcdefghij1234567890");
    let bearer = format!("Authorization: Bearer {}", "abcdefghijklmnop1234");
    let pem = ["-----BEGIN PRIVATE KEY-----", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "-----END PRIVATE KEY-----"].join("\n");
    let raw = [
        "Vivo en Valencia.",
        "api_key: CANARY_1",
        "Contraseña = CANARY_2",
        "export TOKEN=CANARY_3",
        &format!("Usa {sk} para pruebas"),
        &bearer,
        "hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        &pem,
        "Ruta /Users/ana/Documentos/Proyectos/AgoraOne/agoraone/docs/arquitectura.md",
        "Web https://example.com/guia?lang=es",
        "Workspace 3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f",
        "Hablamos del token de acceso sin dar su valor.",
    ]
    .join("\n");
    let masked = mask_secrets(&raw);
    assert_eq!(masked.hidden.len(), 9);
    for gone in ["CANARY", "sk-abc", "Bearer abc", "9f86d08", "MIIE"] {
        assert!(!masked.text.contains(gone), "{gone}");
    }
    for kept in ["Vivo en Valencia.", "/Users/ana/Documentos", "https://example.com/guia", "token de acceso sin dar", "3f2b8c1e-9d4a"] {
        assert!(masked.text.contains(kept), "{kept}");
    }
    assert_eq!(restore_secrets(&masked.text, &masked.hidden).unwrap(), raw);
}

#[test]
fn edits_get_their_lines_back_by_marker() {
    let masked = mask_secrets("uno\npassword: CANARY\ndos\ntoken: OTRA-123");
    assert_eq!(masked.text, "uno\n[línea oculta 1]\ndos\n[línea oculta 2]");
    assert_eq!(restore_secrets("UNO\n[línea oculta 1]\ndos", &masked.hidden).unwrap(), "UNO\npassword: CANARY\ndos");
    assert_eq!(restore_secrets("[línea oculta 3]", &masked.hidden), Err(HiddenLineError));
}

#[test]
fn spanish_json_urls_and_values_on_the_next_line() {
    let visible = [
        "Valores clave: honestidad y cercanía",
        "Puntos clave: orden",
        "max_tokens: 4096",
        "Guía https://example.com/como-configurar-el-servidor-en-2024-paso-a-paso",
        "Ver [[2024-01-15-reunion-con-el-equipo-de-producto-y-diseno]]",
        "nombre_largo_de_variable_para_pruebas_2024",
        "Usamos un token para entrar.",
    ];
    let password_url = format!("postgres://admin:{}@db.local/app", "s3creto");
    let hidden = [
        r#""password": "CANARY""#,
        r#"{"api_key": "CANARY"}"#,
        "aws_secret_access_key = CANARY",
        &password_url,
        "PWD=CANARY",
        "**Contraseña**: CANARY",
        "Mi clave API es CANARY",
        "clave: Xk9#mQ2p",
        "token: abc123def",
    ];
    for line in visible {
        assert_eq!(mask_secrets(line).hidden.len(), 0, "{line}");
    }
    for line in hidden {
        assert_eq!(mask_secrets(line).hidden.len(), 1, "{line}");
    }
    assert_eq!(mask_secrets("password:\nCANARY_SIGUIENTE\nnormal").text, "[línea oculta 1]\n[línea oculta 2]\nnormal");
}

#[test]
fn a_literal_marker_is_not_confused_with_a_key() {
    let raw = "x\n[línea oculta 1]\npassword: a";
    let masked = mask_secrets(raw);
    assert_eq!(masked.text, "x\n[línea oculta 1]\n[línea oculta 2]");
    assert_eq!(restore_secrets(&masked.text, &masked.hidden).unwrap(), raw);
}

#[test]
fn long_hostile_lines_do_not_block() {
    for unit in ["a.", "a-", "x://a:", "Ab1+", "a="] {
        let line = unit.repeat(128_000_usize.div_ceil(unit.len()));
        let start = Instant::now();
        mask_secrets(&line);
        assert!(start.elapsed().as_millis() < 500, "«{unit}» repetido no debe tardar");
    }
}
