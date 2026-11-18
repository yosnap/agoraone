//! Central's own web in a window of this app (1.7), for what AgoraOne shows no native view of (Central's settings,
//! secrets, scanner, videos, integrations, its mail) and for «Abrir en Central». Never in a frame: Central is the
//! window's main page, so its session, its CSP and its headers work as in a browser on macOS (WKWebView), Windows
//! (WebView2) and Linux (WebKitGTK). The user signs in to Central with Central's own login; AgoraOne's key for
//! Central's API never comes here.
//!
//! The window has no native commands (the app grants none to any window) and is refused the microphone, camera,
//! location, notifications and every other permission, and every download. It keeps its session between launches in
//! a data store of its own, apart from AgoraOne's window: a data directory on Windows and Linux, a data store
//! identifier on macOS 14 and later (before that, WebKit's default store, which AgoraOne's window shares only by
//! store, never by site: AgoraOne lives on 127.0.0.1, Central elsewhere). It only goes to pages of the origin
//! (scheme, host and port) of the Central address saved in AgoraOne; it opens no other window. A link of Central to
//! another site is not followed: AgoraOne's window is told and offers to open it in the system's browser (through
//! the core, https only). AgoraOne's screen leaves its orders in the core and this collects them, like the hidden
//! YouTube window.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::webview::{NewWindowResponse, PermissionResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "central";
/// The window's own data store on macOS 14+ (a fixed identifier: the same store, and so the same session, every launch).
const STORE: [u8; 16] = [0x6a, 0x1f, 0x3c, 0x52, 0x9e, 0x47, 0x4b, 0x08, 0xa1, 0x7d, 0x25, 0xc4, 0x0e, 0x93, 0xb6, 0x71];
/// Its own data directory on Windows and Linux, inside the app's local data.
const STORE_FOLDER: &str = "central-web";
const MAX_URL: usize = 2000;
/// The same refused link, asked again this soon (a page insisting), is told to AgoraOne only once.
const REPEAT: Duration = Duration::from_secs(3);

/// Scheme, host and port: the only pages the window may load.
type Origin = (String, String, u16);

/// The origin of the Central address last opened (an address saved in AgoraOne, never typed in this window).
static ORIGIN: Mutex<Option<Origin>> = Mutex::new(None);
/// AgoraOne's own ports on this machine (its server and its core): never loaded in Central's window.
static OWN_PORTS: Mutex<Vec<u16>> = Mutex::new(Vec::new());
static LAST_TOLD: Mutex<Option<(String, Instant)>> = Mutex::new(None);

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

fn origin_of(url: &Url) -> Option<Origin> {
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    Some((url.scheme().to_string(), url.host_str()?.to_ascii_lowercase(), url.port_or_known_default()?))
}

fn loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// The origin of a Central address handed over by the core, checked again here: http or https, no user or password,
/// plain http only on this machine (like the core's own rule), and never AgoraOne itself.
fn central_origin(url: &Url, own_ports: &[u16]) -> Option<Origin> {
    let origin = origin_of(url)?;
    if !url.username().is_empty() || url.password().is_some() || url.as_str().len() > MAX_URL {
        return None;
    }
    if origin.0 == "http" && !loopback(&origin.1) {
        return None;
    }
    if loopback(&origin.1) && own_ports.contains(&origin.2) {
        return None;
    }
    Some(origin)
}

/// Whether a page may load in the window: exactly the same scheme, host and port as Central's address.
fn allowed(url: &Url, origin: Option<&Origin>) -> bool {
    origin.is_some_and(|origin| origin_of(url).as_ref() == Some(origin))
}

fn current_origin() -> Option<Origin> {
    lock(&ORIGIN).clone()
}

/// A link of Central to another site: AgoraOne's window offers to open it in the browser (a JSON literal: data, never
/// code). Only web addresses, and the same one only once in a short while.
fn tell_external(app: &AppHandle, url: &Url) {
    if !matches!(url.scheme(), "http" | "https") || url.as_str().len() > MAX_URL {
        return;
    }
    {
        let mut last = lock(&LAST_TOLD);
        if last.as_ref().is_some_and(|(told, at)| told == url.as_str() && at.elapsed() < REPEAT) {
            return;
        }
        *last = Some((url.as_str().to_string(), Instant::now()));
    }
    let detail = serde_json::json!({ "url": url.as_str() });
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.eval(format!("window.dispatchEvent(new CustomEvent('agora:central-external', {{ detail: {detail} }}))"));
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

/// Goes to a page of Central in its window, opening the window when it is not there.
fn open(app: &AppHandle, url: Url) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.navigate(url);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let navigation = app.clone();
    let new_window = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("Central (AgoraOne)")
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 520.0)
        .visible(true)
        .focused(true)
        .incognito(false)
        .data_store_identifier(STORE)
        .on_navigation(move |url| {
            let ok = allowed(url, current_origin().as_ref());
            if !ok {
                tell_external(&navigation, url);
            }
            ok
        })
        // «target=_blank»: a page of Central opens here instead; another site, in the browser if the user wants.
        .on_new_window(move |url, _features| {
            if allowed(&url, current_origin().as_ref()) {
                let app = new_window.clone();
                let _ = new_window.run_on_main_thread(move || {
                    if let Some(window) = app.get_webview_window(LABEL) {
                        let _ = window.navigate(url);
                    }
                });
            } else {
                tell_external(&new_window, &url);
            }
            NewWindowResponse::Deny
        })
        .on_permission_request(|_, _| PermissionResponse::Deny)
        .on_download(|_, _| false);
    if let Ok(folder) = app.path().app_local_data_dir() {
        builder = builder.data_directory(folder.join(STORE_FOLDER));
    }
    let _ = builder.build();
}

fn apply(app: &AppHandle, command: &serde_json::Value) {
    if command.get("action").and_then(|a| a.as_str()) != Some("open") {
        return;
    }
    let Some(url) = command.get("url").and_then(|u| u.as_str()).and_then(|u| Url::parse(u).ok()) else { return };
    let Some(origin) = central_origin(&url, &lock(&OWN_PORTS)) else { return };
    *lock(&ORIGIN) = Some(origin);
    open(app, url);
}

/// While the desktop app runs: the screen's orders to open a page of Central, as they come.
pub fn central_loop(app: AppHandle, link: agora_server::core::CoreLink) {
    let core_port = Url::parse(&link.url).ok().and_then(|u| u.port_or_known_default());
    *lock(&OWN_PORTS) = [Some(agora_server::PORT), core_port].into_iter().flatten().collect();
    tauri::async_runtime::spawn(async move {
        let http = reqwest::Client::new();
        let mut seen: i64 = -1;
        loop {
            let path = format!("/internal/central/window/next?after={seen}");
            let Ok(answer) = agora_server::core::core_request(&http, &link, &path, None).await else {
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            };
            // A core that started again counts from zero: follow its count.
            seen = answer.get("seq").and_then(|s| s.as_i64()).unwrap_or(seen);
            for command in answer.get("commands").and_then(|c| c.as_array()).into_iter().flatten() {
                let (handle, command) = (app.clone(), command.clone());
                let _ = app.run_on_main_thread(move || apply(&handle, &command));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(central_origin(&url("http://127.0.0.1:4317/"), &own).is_none(), "nunca AgoraOne");
        assert!(central_origin(&url("http://localhost:4318/"), &own).is_none(), "nunca el núcleo");
        assert!(central_origin(&url("javascript:alert(1)"), &own).is_none());
        assert!(central_origin(&url("about:blank"), &own).is_none());
        assert!(central_origin(&url("https://central.example.com"), &own).is_some());
        assert!(central_origin(&url("http://[::1]:3099/"), &own).is_some());
    }
}
