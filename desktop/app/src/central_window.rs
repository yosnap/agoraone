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
/// A refused link is told to AgoraOne at most this often, and AgoraOne's window brought to the front at most this often.
const TELL_EVERY: Duration = Duration::from_secs(1);
const FOCUS_EVERY: Duration = Duration::from_secs(5);

/// Scheme, host and port: the only pages the window may load.
type Origin = (String, String, u16);

/// The origin of the Central address last opened (an address saved in AgoraOne, never typed in this window).
static ORIGIN: Mutex<Option<Origin>> = Mutex::new(None);
/// AgoraOne's own ports on this machine (its server and its core): never loaded in Central's window.
static OWN_PORTS: Mutex<Vec<u16>> = Mutex::new(Vec::new());
static LAST_TOLD: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_FOCUS: Mutex<Option<Instant>> = Mutex::new(None);

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

fn origin_of(url: &Url) -> Option<Origin> {
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    Some((url.scheme().to_string(), url.host_str()?.to_ascii_lowercase(), url.port_or_known_default()?))
}

/// AgoraOne's own host: any 127.x address or ::1, which share cookies with AgoraOne's window whatever the port.
fn agora_host(host: &str) -> bool {
    host == "[::1]" || host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback())
}

/// The origin of a Central address handed over by the core, checked again here: http or https, no user or password,
/// plain http only on `localhost` (the core's rule, without AgoraOne's own host), and never AgoraOne itself.
fn central_origin(url: &Url, own_ports: &[u16]) -> Option<Origin> {
    let origin = origin_of(url)?;
    if !url.username().is_empty() || url.password().is_some() || url.as_str().len() > MAX_URL || agora_host(&origin.1) {
        return None;
    }
    let local = origin.1 == "localhost";
    if (origin.0 == "http" && !local) || (local && own_ports.contains(&origin.2)) {
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

/// Whether enough time went by since the last time (and, when so, this is the last time now).
fn due(last: &Mutex<Option<Instant>>, every: Duration, now: Instant) -> bool {
    let mut last = lock(last);
    if last.is_some_and(|at| now.saturating_duration_since(at) < every) {
        return false;
    }
    *last = Some(now);
    true
}

/// A link of Central to another site: AgoraOne's window offers to open it in the browser (a JSON literal: data, never
/// code). Only web addresses, limited in time so a page cannot flood AgoraOne or keep taking the focus.
fn tell_external(app: &AppHandle, url: &Url) {
    if !matches!(url.scheme(), "http" | "https") || url.as_str().len() > MAX_URL || !due(&LAST_TOLD, TELL_EVERY, Instant::now()) {
        return;
    }
    let detail = serde_json::json!({ "url": url.as_str() });
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.eval(format!("window.dispatchEvent(new CustomEvent('agora:central-external', {{ detail: {detail} }}))"));
        if due(&LAST_FOCUS, FOCUS_EVERY, Instant::now()) {
            let _ = main.show();
            let _ = main.unminimize();
            let _ = main.set_focus();
        }
    }
}

/// Whether this Mac gives the window a store of its own (macOS 14+); Windows and Linux always do, by folder.
#[cfg(target_os = "macos")]
fn own_store() -> bool {
    let mut buffer = [0u8; 32];
    let mut size = buffer.len();
    // SAFETY: the name is NUL-terminated, the buffer and its size are valid and no new value is written.
    let read = unsafe {
        libc::sysctlbyname(c"kern.osproductversion".as_ptr(), buffer.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0)
    };
    read == 0 && macos_major(&buffer[..size.min(buffer.len())]).is_some_and(|major| major >= 14)
}

#[cfg(not(target_os = "macos"))]
fn own_store() -> bool {
    true
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn macos_major(version: &[u8]) -> Option<u32> {
    std::str::from_utf8(version).ok()?.trim_end_matches('\0').split('.').next()?.parse().ok()
}

fn close(app: &AppHandle) {
    *lock(&ORIGIN) = None;
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
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
    builder = if own_store() { builder.incognito(false).data_store_identifier(STORE) } else { builder.incognito(true) };
    if let Ok(folder) = app.path().app_local_data_dir() {
        builder = builder.data_directory(folder.join(STORE_FOLDER));
    }
    let _ = builder.build();
}

fn apply(app: &AppHandle, command: &serde_json::Value) {
    match command.get("action").and_then(|a| a.as_str()) {
        Some("open") => {
            let Some(url) = command.get("url").and_then(|u| u.as_str()).and_then(|u| Url::parse(u).ok()) else { return };
            let Some(origin) = central_origin(&url, &lock(&OWN_PORTS)) else { return };
            *lock(&ORIGIN) = Some(origin);
            open(app, url);
        }
        Some("close") => close(app),
        _ => {}
    }
}

/// Whether the open window may stay: a module that uses it is on and Central's address keeps the same origin.
fn may_stay(answer: &serde_json::Value, origin: Option<&Origin>) -> bool {
    let on = answer.get("allowed").and_then(|a| a.as_bool()).unwrap_or(true);
    let same = match answer.get("url") {
        Some(serde_json::Value::String(url)) => Url::parse(url).ok().is_some_and(|url| allowed(&url, origin)),
        Some(serde_json::Value::Null) => false,
        _ => true,  // a core that does not say: nothing changes
    };
    on && same
}

/// While the desktop app runs: the screen's orders to open or close Central's window, as they come.
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
            let commands: Vec<serde_json::Value> = answer.get("commands").and_then(|c| c.as_array()).cloned().unwrap_or_default();
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                for command in &commands {
                    apply(&handle, command);
                }
                // After the orders: the module turned off or Central's address changed closes the window.
                if handle.get_webview_window(LABEL).is_some() && !may_stay(&answer, current_origin().as_ref()) {
                    close(&handle);
                }
            });
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
