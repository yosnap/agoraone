//! Mi fábrica's own panel in a window of this app (1.7): the panel as it is, with its own password and session, to
//! approve or reject runs, watch competitors, keep ideas and change its settings. AgoraOne brings none of its code.
//! The window is the add-on window shared with Central (`addon_window.rs`): no native commands, every permission
//! refused, only its own origin, links to other sites told to AgoraOne's window, a data store of its own (never the
//! default one) and closed when the module is turned off.
//!
//! What is its own: it opens over AgoraOne's window with its position and size, and only `http://127.0.0.1:{port}`
//! (the panel listens on IPv4 only: `localhost` could reach another program on `::1`), never on one of AgoraOne's
//! ports. That host is AgoraOne's too, which is safe only because this window never uses the default store: on macOS
//! 13, with no store of its own, it is private. The files of a run (`/corridas/{id}/archivos/{n}`) of the open
//! origin download to the Downloads folder, never over a file that is there; AgoraOne's window is told the name.
//! Any other download is refused. WebKit's iframes and Tauri's `unwrap_or(true)`: see `addon_window.rs`.

use tauri::{AppHandle, Url};

use crate::addon_window::{self, MAX_URL, Origin, Spec, State, origin_of};

pub(crate) static FABRICA: Spec = Spec {
    label: "fabrica",
    title: "Mi fábrica (AgoraOne)",
    store: [0x3e, 0x81, 0x5d, 0x0c, 0xb2, 0x64, 0x4f, 0x19, 0x97, 0x2a, 0x6e, 0xd3, 0x41, 0xf8, 0x0b, 0x5c],
    origin: fabrica_origin,
    downloads: Some(run_file),
    like_main: true,
    state: State::new(),
};

/// The origin of the panel's address handed over by the core, checked again here: plain http on exactly 127.0.0.1,
/// no user or password, and never one of AgoraOne's ports.
fn fabrica_origin(url: &Url, own_ports: &[u16]) -> Option<Origin> {
    let origin = origin_of(url)?;
    if origin.0 != "http" || origin.1 != "127.0.0.1" || !url.username().is_empty() || url.password().is_some()
        || url.as_str().len() > MAX_URL || own_ports.contains(&origin.2)
    {
        return None;
    }
    Some(origin)
}

/// A file of a run: `/corridas/{id}/archivos/{n}` and nothing else (the address is already normalised, no `..`).
fn run_file(url: &Url) -> bool {
    let Some(rest) = url.path().strip_prefix("/corridas/") else { return false };
    let parts: Vec<&str> = rest.split('/').collect();
    matches!(parts.as_slice(), [id, "archivos", n] if !id.is_empty() && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// While the desktop app runs: the screen's orders to open or close the panel's window, as they come.
pub fn fabrica_loop(app: AppHandle, link: agora_server::core::CoreLink) {
    addon_window::run(&FABRICA, app, link);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::addon_window::{allowed, may_stay};

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    const OWN: [u16; 2] = [4317, 4318];

    #[test]
    fn solo_127_0_0_1_por_http_y_fuera_de_los_puertos_de_agoraone() {
        assert!(fabrica_origin(&url("http://127.0.0.1:8742/corridas"), &OWN).is_some());
        for wrong in ["http://localhost:8742/", "http://[::1]:8742/", "http://127.0.0.2:8742/", "https://127.0.0.1:8742/",
                      "http://127.0.0.1:4317/", "http://127.0.0.1:4318/", "http://ana@127.0.0.1:8742/", "http://ana:x@127.0.0.1:8742/",
                      "about:blank", "data:text/html,hola", "file:///etc/passwd", "blob:http://127.0.0.1:8742/1", "javascript:alert(1)",
                      "http://fabrica.example.com:8742/"] {
            assert!(fabrica_origin(&url(wrong), &OWN).is_none(), "{wrong}");
        }
        let long = format!("http://127.0.0.1:8742/{}", "a".repeat(2000));
        assert!(fabrica_origin(&url(&long), &OWN).is_none());
    }

    #[test]
    fn solo_su_origen() {
        let origin = fabrica_origin(&url("http://127.0.0.1:8742/"), &OWN);
        assert!(allowed(&url("http://127.0.0.1:8742/corridas/abc?x=1"), origin.as_ref()));
        assert!(!allowed(&url("http://127.0.0.1:8743/"), origin.as_ref()), "otro puerto");
        assert!(!allowed(&url("http://localhost:8742/"), origin.as_ref()), "otro host");
        assert!(!allowed(&url("https://127.0.0.1:8742/"), origin.as_ref()));
        assert!(!allowed(&url("https://www.youtube.com/"), origin.as_ref()));
        assert!(!allowed(&url("http://127.0.0.1:8742/"), None));
    }

    #[test]
    fn solo_se_descargan_los_archivos_de_una_corrida() {
        assert!(run_file(&url("http://127.0.0.1:8742/corridas/x/archivos/1")));
        assert!(run_file(&url("http://127.0.0.1:8742/corridas/2026-11-18-a/archivos/12")));
        for wrong in ["http://127.0.0.1:8742/corridas/x/archivos/1/../..", "http://127.0.0.1:8742/ajustes", "http://127.0.0.1:8742/corridas/x/archivos/",
                      "http://127.0.0.1:8742/corridas/x/archivos/1a", "http://127.0.0.1:8742/corridas//archivos/1",
                      "http://127.0.0.1:8742/corridas/x/archivos/1/otra", "http://127.0.0.1:8742/x/corridas/x/archivos/1"] {
            assert!(!run_file(&url(wrong)), "{wrong}");
        }
    }

    #[test]
    fn la_ventana_se_cierra_si_cambia_el_puerto_o_se_apaga_el_modulo() {
        let origin = fabrica_origin(&url("http://127.0.0.1:8742/"), &OWN);
        let stay = |answer: serde_json::Value| may_stay(&answer, origin.as_ref());
        assert!(stay(serde_json::json!({ "allowed": true, "url": "http://127.0.0.1:8742" })));
        assert!(!stay(serde_json::json!({ "allowed": false, "url": "http://127.0.0.1:8742" })), "módulo apagado");
        assert!(!stay(serde_json::json!({ "allowed": true, "url": null })), "sin carpeta");
        assert!(!stay(serde_json::json!({ "allowed": true, "url": "http://127.0.0.1:9000" })), "otro puerto");
    }
}
