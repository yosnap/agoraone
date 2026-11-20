//! Access to AgoraOne's API needs a token only the user can read (a 0600 file in `.agora`), so another user
//! of the Mac, a sandboxed app or a container reaching 127.0.0.1 cannot use it with the user's credentials.
//! The browser trades the token once for an HttpOnly cookie holding a digest of it; the CSRF header and the
//! Host/Origin checks stay on top. Same file, digest and cookie as the former Node backend.

use std::fs;
use std::io::Write;
use std::path::Path;

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::platform::{create_mode_file, set_mode};

pub const ACCESS_COOKIE: &str = "agora_access";
pub const USER_COOKIE: &str = "agora_user";

/// A fresh random secret: 32 bytes as 64 hex characters.
pub fn random_hex() -> String {
    let bytes: [u8; 32] = rand::random();
    hex::encode(bytes)
}

pub fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The persistent token: read from its file, or created there (0600, folder 0700) the first time.
pub fn load_token(file: &Path) -> std::io::Result<String> {
    if let Ok(text) = fs::read_to_string(file) {
        let token = text.trim();
        if is_hex64(token) {
            set_mode(file, 0o600)?;
            return Ok(token.to_string());
        }
    }
    if let Some(folder) = file.parent() {
        fs::create_dir_all(folder)?;
        set_mode(folder, 0o700)?;
    }
    let token = random_hex();
    let mut out = create_mode_file(file, false, true, 0o600)?;
    writeln!(out, "{token}")?;
    Ok(token)
}

fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// What the access cookie holds: a digest of the token, never the token itself.
pub fn proof(token: &str) -> String {
    sha256_hex(&format!("agoraone-access:{token}"))
}

/// The browser identity behind a user cookie (conversations and private copies belong to it).
pub fn owner_of(user_cookie: &str) -> String {
    sha256_hex(user_cookie)
}

/// The core's single owner, tied to AgoraOne's access rather than to one browser's cookie.
pub fn core_owner(proof: &str) -> String {
    sha256_hex(&format!("agoraone-core-owner:{proof}"))
}

/// Constant-time comparison of two secrets of the same length.
pub fn same_secret(given: Option<&str>, expected: &str) -> bool {
    match given {
        Some(given) if given.len() == expected.len() => given.as_bytes().ct_eq(expected.as_bytes()).into(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_se_crea_privado_y_se_reutiliza() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sub/access-token");
        let first = load_token(&file).unwrap();
        assert!(is_hex64(&first));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(file.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        #[cfg(windows)]
        {
            use crate::platform::is_owner_only;
            let folder = file.parent().unwrap();
            assert!(is_owner_only(&file).unwrap(), "el token solo lo lee su usuario");
            assert!(is_owner_only(folder).unwrap(), "la carpeta de datos solo la abre su usuario");
            fs::write(folder.join("otro"), "x").unwrap();
            assert!(is_owner_only(&folder.join("otro")).unwrap(), "lo que se crea dentro hereda la protección");
            assert!(!is_owner_only(dir.path()).unwrap(), "la carpeta de fuera sigue como estaba");
        }
        assert_eq!(load_token(&file).unwrap(), first);
        fs::write(&file, "no-es-un-token").unwrap();
        assert_ne!(load_token(&file).unwrap(), first, "un archivo dañado se sustituye");
    }

    #[cfg(windows)]
    #[test]
    fn un_token_existente_con_permisos_abiertos_se_protege_al_leerlo() {
        use crate::platform::is_owner_only;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("access-token");
        fs::write(&file, format!("{}\n", "b".repeat(64))).unwrap();
        assert!(!is_owner_only(&file).unwrap(), "un archivo nuevo hereda los permisos de su carpeta");
        assert_eq!(load_token(&file).unwrap(), "b".repeat(64));
        assert!(is_owner_only(&file).unwrap());
    }

    #[test]
    fn prueba_compatible_con_el_backend_anterior() {
        // sha256("agoraone-access:" + "a"*64), as computed by the former Node backend.
        let token = "a".repeat(64);
        assert_eq!(proof(&token), "ca2392d7629f9bb077dbfdb9c85dc453d14fe28d45c565826736a8c98fef0ec3");
        assert!(same_secret(Some(&proof(&token)), &proof(&token)));
        assert!(!same_secret(Some("x"), &proof(&token)));
        assert!(!same_secret(None, &proof(&token)));
    }
}
