//! Central's own web in a window of this app (1.7), for what AgoraOne shows no native view of (Central's settings,
//! secrets, scanner, videos, integrations, its mail) and for «Abrir en Central». Never in a frame: Central is the
//! window's main page, so its session, its CSP and its headers work as in a browser on macOS (WKWebView), Windows
//! (WebView2) and Linux (WebKitGTK). The user signs in to Central with Central's own login; AgoraOne's key for
//! Central's API never comes here.
//!
//! The window has no native commands (the app grants none to any window) and is refused the microphone, camera,
//! location, notifications and every other permission, and every download. It keeps its session between launches in
//! a data store of its own, apart from AgoraOne's window: a data directory on Windows and Linux, a data store
//! identifier on macOS 14 and later. On older macOS there is no store of its own (WebKit would use the default one,
//! AgoraOne's window's): there the window is private (nothing kept, the user signs in to Central each time), because
//! cookies go by host and not by port. For the same reason a Central on 127.0.0.1 or ::1 (AgoraOne's own host) is
//! never opened here, on any system: `localhost` is another host for cookies, and AgoraOne's ports are refused too.
//!
//! It only goes to pages of the origin (scheme, host and port) of the Central address saved in AgoraOne; it opens no
//! other window. A link of Central to another site is not followed: AgoraOne's window is told (at most once a second,
//! and brought to the front at most every five seconds, so a page insisting cannot take the focus over) and offers
//! to open it in the system's browser. AgoraOne's screen leaves its orders in the core and this collects them, like
//! the hidden YouTube window; each answer also says whether the window may still be open (a module on and the same
//! Central address), and when not it closes.
//!
//! Known limits: WebKit on macOS asks the navigation handler for frames too, so an iframe of another site inside
//! Central (it has none today) would be cancelled and told as a link. Tauri lets a navigation through when WebKit's
//! address cannot be parsed (`unwrap_or(true)` in tauri-runtime-wry), as for any window of the app.
//!
//! The window itself, and its rule for addresses (`remote_origin`), are the add-on window shared with CRMDev and Mi
//! fábrica (`addon_window.rs`).

use tauri::AppHandle;

use crate::addon_window::{self, Spec, State, remote_origin as central_origin};
#[cfg(test)]
use crate::addon_window::{FOCUS_EVERY, allowed, due, macos_major, may_stay};

pub(crate) static CENTRAL: Spec = Spec {
    label: "central",
    title: "Central (AgoraOne)",
    store: [0x6a, 0x1f, 0x3c, 0x52, 0x9e, 0x47, 0x4b, 0x08, 0xa1, 0x7d, 0x25, 0xc4, 0x0e, 0x93, 0xb6, 0x71],
    origin: central_origin,
    downloads: None,
    like_main: false,
    state: State::new(),
};

/// While the desktop app runs: the screen's orders to open or close Central's window, as they come.
pub fn central_loop(app: AppHandle, link: agora_server::core::CoreLink) {
    addon_window::run(&CENTRAL, app, link);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tauri::Url;
    use std::time::{Duration, Instant};

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn solo_el_mismo_origen() {
        let central = central_origin(&url("https://central.example.com/ajustes"), &[4317, 4318]);
        let origin = central.as_ref();
        assert!(allowed(&url("https://central.example.com/"), origin));
        assert!(allowed(&url("https://central.example.com:443/clientes/c111?x=1#y"), origin));
        assert!(allowed(&url("https://CENTRAL.example.com/login"), origin));
        assert!(!allowed(&url("https://otro.example.com/"), origin), "otro host");
        assert!(!allowed(&url("https://evil.central.example.com/"), origin), "un subdominio es otro host");
        assert!(!allowed(&url("https://central.example.com.evil.net/"), origin));
        assert!(!allowed(&url("https://central.example.com:8443/"), origin), "otro puerto");
        assert!(!allowed(&url("http://central.example.com/"), origin), "http frente a https");
        assert!(!allowed(&url("about:blank"), origin));
        assert!(!allowed(&url("about:srcdoc"), origin));
        assert!(!allowed(&url("javascript:alert(1)"), origin));
        assert!(!allowed(&url("data:text/html,hola"), origin));
        assert!(!allowed(&url("file:///etc/passwd"), origin));
        assert!(!allowed(&url("blob:https://central.example.com/1"), origin));
        assert!(!allowed(&url("https://central.example.com/"), None), "sin dirección abierta no se carga nada");
    }

    #[test]
    fn central_local_por_http_con_su_puerto() {
        let central = central_origin(&url("http://localhost:3099/"), &[4317, 4318]);
        let origin = central.as_ref();
        assert!(allowed(&url("http://localhost:3099/ajustes"), origin));
        assert!(!allowed(&url("http://localhost:3000/"), origin));
        assert!(!allowed(&url("https://localhost:3099/"), origin));
        assert!(!allowed(&url("http://127.0.0.1:3099/"), origin), "otro nombre es otro origen, como en el navegador");
    }

    #[test]
    fn direcciones_que_no_se_abren() {
        let own = [4317, 4318];
        assert!(central_origin(&url("http://central.example.com/"), &own).is_none(), "http fuera de este equipo");
        assert!(central_origin(&url("https://ana@central.example.com/"), &own).is_none(), "sin usuario en la dirección");
        assert!(central_origin(&url("http://127.0.0.1:3099/"), &own).is_none(), "el host de AgoraOne comparte sus cookies");
        assert!(central_origin(&url("https://127.0.0.1:3099/"), &own).is_none());
        assert!(central_origin(&url("http://127.1.2.3:3099/"), &own).is_none());
        assert!(central_origin(&url("http://[::1]:3099/"), &own).is_none());
        assert!(central_origin(&url("http://localhost:4317/"), &own).is_none(), "nunca AgoraOne");
        assert!(central_origin(&url("http://localhost:4318/"), &own).is_none(), "nunca el núcleo");
        assert!(central_origin(&url("javascript:alert(1)"), &own).is_none());
        assert!(central_origin(&url("about:blank"), &own).is_none());
        assert!(central_origin(&url("https://central.example.com"), &own).is_some());
        assert!(central_origin(&url("http://localhost:3099/"), &own).is_some());
    }

    #[test]
    fn avisos_y_foco_limitados_por_tiempo() {
        let last = Mutex::new(None);
        let start = Instant::now();
        assert!(due(&last, FOCUS_EVERY, start));
        assert!(!due(&last, FOCUS_EVERY, start + Duration::from_millis(10)), "otra dirección enseguida: no roba el foco");
        assert!(!due(&last, FOCUS_EVERY, start + Duration::from_secs(4)));
        assert!(due(&last, FOCUS_EVERY, start + Duration::from_secs(5)));
    }

    #[test]
    fn la_ventana_se_cierra_si_cambia_la_direccion_o_se_apaga_el_modulo() {
        let origin = central_origin(&url("https://central.example.com/"), &[4317]);
        let stay = |answer: serde_json::Value| may_stay(&answer, origin.as_ref());
        assert!(stay(serde_json::json!({ "allowed": true, "url": "https://central.example.com" })));
        assert!(stay(serde_json::json!({ "seq": 1 })), "un núcleo que no lo dice no cierra nada");
        assert!(!stay(serde_json::json!({ "allowed": false, "url": "https://central.example.com" })), "módulo apagado");
        assert!(!stay(serde_json::json!({ "allowed": true, "url": null })), "dirección borrada");
        assert!(!stay(serde_json::json!({ "allowed": true, "url": "https://otra.example.com" })), "otra dirección");
    }

    #[test]
    fn version_de_macos() {
        assert_eq!(macos_major(b"14.6.1\0"), Some(14));
        assert_eq!(macos_major(b"13.7"), Some(13));
        assert_eq!(macos_major(b"27.0\0\0"), Some(27));
        assert_eq!(macos_major(b"x"), None);
    }
}
