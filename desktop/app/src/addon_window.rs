//! A window of this app for the own web of an add-on of the user (Central, CRMDev, Mi fábrica), never in a frame: the add-on
//! is the window's main page, so its session, its CSP and its headers work as in a browser on macOS (WKWebView),
//! Windows (WebView2) and Linux (WebKitGTK). The user signs in with the add-on's own login; no key of AgoraOne goes
//! there. Each window is described by a `Spec` (its label, title, data store, the rule for the addresses it may open
//! and which downloads, if any, it lets through) and keeps its own state in it.
//!
//! The window has no native commands (the app grants none to any window) and is refused the microphone, camera,
//! location, notifications and every other permission. It keeps its session between launches in a data store of its
//! own, apart from AgoraOne's window and from the other add-on windows: a data directory on Windows and Linux, a data
//! store identifier on macOS 14 and later. Where there is no store of its own (older macOS, where WebKit would use the
//! default one, AgoraOne's window's; or no data folder) the window is private: nothing kept, the user signs in each
//! time. It never gets the default store, because cookies go by host and not by port.
//!
//! It only goes to pages of the origin (scheme, host and port) of the address the core handed over, checked again
//! here by the spec's rule; it opens no other window. A link to another site is not followed: AgoraOne's window is
//! told (at most once a second, and brought to the front at most every five seconds, so a page insisting cannot take
//! the focus over) and offers to open it in the system's browser. AgoraOne's screen leaves its orders in the core and
//! this collects them, like the hidden YouTube window; each answer also says whether the window may still be open (a
//! module on and the same address), and when not it closes.
//!
//! Known limits: WebKit on macOS asks the navigation handler for frames too, so an iframe of another site inside the
//! add-on would be cancelled and told as a link. Tauri lets a navigation through when WebKit's address cannot be
//! parsed (`unwrap_or(true)` in tauri-runtime-wry), as for any window of the app.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::webview::{DownloadEvent, NewWindowResponse, PermissionResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

pub const MAX_URL: usize = 2000;
/// A refused link is told to AgoraOne at most this often, and AgoraOne's window brought to the front at most this often.
pub const TELL_EVERY: Duration = Duration::from_secs(1);
pub const FOCUS_EVERY: Duration = Duration::from_secs(5);
/// The size of a window that cannot take AgoraOne's, and the smallest one.
const SIZE: (f64, f64) = (1280.0, 820.0);
const MIN_SIZE: (f64, f64) = (720.0, 520.0);
/// Downloads waiting to finish, at most (an add-on cannot pile them up).
const MAX_PENDING: usize = 16;

/// Scheme, host and port: the only pages the window may load.
pub type Origin = (String, String, u16);

/// AgoraOne's own ports on this machine (its server and its core): never loaded in an add-on's window.
static OWN_PORTS: Mutex<Vec<u16>> = Mutex::new(Vec::new());

/// What a window keeps while the app runs.
pub struct State {
    /// The origin of the address last opened (an address saved in AgoraOne, never typed in the window).
    origin: Mutex<Option<Origin>>,
    last_told: Mutex<Option<Instant>>,
    last_focus: Mutex<Option<Instant>>,
    /// Downloads let through and not finished yet: their address and where they go.
    downloads: Mutex<Vec<(String, PathBuf)>>,
}

impl State {
    pub const fn new() -> Self {
        Self { origin: Mutex::new(None), last_told: Mutex::new(None), last_focus: Mutex::new(None), downloads: Mutex::new(Vec::new()) }
    }

    /// A closed window: no address open and no download on its way (a closed window may never say they ended).
    fn forget(&self) {
        *lock(&self.origin) = None;
        lock(&self.downloads).clear();
    }
}

/// One add-on's window. Its label names the rest: the core's `/internal/{label}/window/next`, the events
/// `agora:{label}-external` and `agora:{label}-download` to AgoraOne's window, and the data folder `{label}-web`.
pub struct Spec {
    pub label: &'static str,
    pub title: &'static str,
    /// The window's own data store on macOS 14+ (a fixed identifier: the same store, and so the same session, every launch).
    pub store: [u8; 16],
    /// The origin of an address handed over by the core, checked again here (`None`: nothing opens).
    pub origin: fn(&Url, &[u16]) -> Option<Origin>,
    /// Which pages of the open origin may be downloaded to the Downloads folder; `None`: no download at all.
    pub downloads: Option<fn(&Url) -> bool>,
    /// Opens over AgoraOne's window with its position and size; otherwise with a size of its own.
    pub like_main: bool,
    pub state: State,
}

pub fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn origin_of(url: &Url) -> Option<Origin> {
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    Some((url.scheme().to_string(), url.host_str()?.to_ascii_lowercase(), url.port_or_known_default()?))
}

/// AgoraOne's own host: any 127.x address or ::1, which share cookies with AgoraOne's window whatever the port.
fn agora_host(host: &str) -> bool {
    host == "[::1]" || host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback())
}

/// The origin of a remote add-on's address (a connector's web: Central, CRMDev) handed over by the core, checked again
/// here: http or https, no user or password, plain http only on `localhost` (the core's rule, without AgoraOne's own
/// host, since cookies go by host and not by port), and never one of AgoraOne's own ports.
pub fn remote_origin(url: &Url, own_ports: &[u16]) -> Option<Origin> {
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

/// Whether a page may load in the window: exactly the same scheme, host and port as the open address.
pub fn allowed(url: &Url, origin: Option<&Origin>) -> bool {
    origin.is_some_and(|origin| origin_of(url).as_ref() == Some(origin))
}

fn current_origin(spec: &Spec) -> Option<Origin> {
    lock(&spec.state.origin).clone()
}

/// Whether enough time went by since the last time (and, when so, this is the last time now).
pub fn due(last: &Mutex<Option<Instant>>, every: Duration, now: Instant) -> bool {
    let mut last = lock(last);
    if last.is_some_and(|at| now.saturating_duration_since(at) < every) {
        return false;
    }
    *last = Some(now);
    true
}

/// An event to AgoraOne's window with a JSON literal as its detail: data, never code.
fn tell_main(app: &AppHandle, event: &str, detail: &serde_json::Value) -> bool {
    let Some(main) = app.get_webview_window("main") else { return false };
    let _ = main.eval(format!("window.dispatchEvent(new CustomEvent('agora:{event}', {{ detail: {detail} }}))"));
    true
}

/// A link to another site: AgoraOne's window offers to open it in the browser. Only web addresses, limited in time
/// so a page cannot flood AgoraOne or keep taking the focus.
fn tell_external(spec: &Spec, app: &AppHandle, url: &Url) {
    if !matches!(url.scheme(), "http" | "https") || url.as_str().len() > MAX_URL || !due(&spec.state.last_told, TELL_EVERY, Instant::now()) {
        return;
    }
    let event = format!("{}-external", spec.label);
    if tell_main(app, &event, &serde_json::json!({ "url": url.as_str() }))
        && due(&spec.state.last_focus, FOCUS_EVERY, Instant::now())
        && let Some(main) = app.get_webview_window("main")
    {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

/// Whether this Mac gives the window a store of its own (macOS 14+); Windows and Linux do when there is a folder.
#[cfg(target_os = "macos")]
fn own_store(_folder: bool) -> bool {
    let mut buffer = [0u8; 32];
    let mut size = buffer.len();
    // SAFETY: the name is NUL-terminated, the buffer and its size are valid and no new value is written.
    let read = unsafe {
        libc::sysctlbyname(c"kern.osproductversion".as_ptr(), buffer.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0)
    };
    read == 0 && macos_major(&buffer[..size.min(buffer.len())]).is_some_and(|major| major >= 14)
}

#[cfg(not(target_os = "macos"))]
fn own_store(folder: bool) -> bool {
    folder
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn macos_major(version: &[u8]) -> Option<u32> {
    std::str::from_utf8(version).ok()?.trim_end_matches('\0').split('.').next()?.parse().ok()
}

/// How the window keeps its data, as the window's options `(incognito, data store identifier)`. Two ways and neither
/// is the default store (AgoraOne's window's): its own store (not private, always with its identifier) or private
/// (nothing kept).
fn store_options(own: bool, identifier: [u8; 16]) -> (bool, Option<[u8; 16]>) {
    if own { (false, Some(identifier)) } else { (true, None) }
}

/// Characters that do not show (controls and Unicode format ones: direction marks and overrides, zero width…), which
/// could make a name look like another (`guia\u{202E}fdp.exe`).
fn hidden_char(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}')
}

/// Names Windows keeps for its devices (`CON`, `NUL`, `COM1`…, with any extension), where a download would fail.
fn reserved_on_windows(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or_default().trim_end().to_ascii_uppercase();
    let numbered = stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(stem.as_bytes()[3], b'1'..=b'9');
    numbered || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
}

/// Where a download goes: the Downloads folder and only the file's own name (no folders, nothing hidden), never over
/// a file that is there nor where a download still on its way goes (`taken`): «nombre (2).pdf»… Nothing invisible
/// and no name Windows keeps. `None` when no free name is found.
pub fn download_target(folder: &Path, suggested: &str, fallback: &str, taken: &[&Path]) -> Option<PathBuf> {
    let clean: String = suggested
        .chars()
        .filter(|&c| !hidden_char(c) && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .take(150)
        .collect();
    let clean = clean.trim().trim_start_matches('.').trim_end_matches(['.', ' ']).trim();
    let reserved = format!("_{clean}");
    let name = if clean.is_empty() { fallback } else if reserved_on_windows(clean) { reserved.as_str() } else { clean };
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    (1..=999).map(|n| if n == 1 { name.to_string() } else { format!("{stem} ({n}){extension}") })
        .map(|candidate| folder.join(candidate))
        .find(|path| !taken.contains(&path.as_path()) && !path.exists() && path.symlink_metadata().is_err())
}

/// A download asked by the window: only of the open origin and a page the spec allows, to the Downloads folder.
fn start_download(spec: &Spec, app: &AppHandle, url: &Url, destination: &mut PathBuf) -> bool {
    let Some(rule) = spec.downloads else { return false };
    if !allowed(url, current_origin(spec).as_ref()) || !rule(url) {
        return false;
    }
    let Ok(folder) = app.path().download_dir() else { return false };
    let suggested = destination.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let Some(target) = reserve(&spec.state, url, &folder, &suggested, &format!("{}.pdf", spec.label)) else { return false };
    *destination = target;
    true
}

/// Picks a download's file and keeps it as on its way, with the list held: two downloads of the same name in a row
/// never get the same file. `None` with too many on their way or no free name.
fn reserve(state: &State, url: &Url, folder: &Path, suggested: &str, fallback: &str) -> Option<PathBuf> {
    let mut pending = lock(&state.downloads);
    if pending.len() >= MAX_PENDING {
        return None;
    }
    let taken: Vec<&Path> = pending.iter().map(|(_, path)| path.as_path()).collect();
    let target = download_target(folder, suggested, fallback, &taken)?;
    pending.push((url.as_str().to_string(), target.clone()));
    Some(target)
}

/// A download that ended: AgoraOne's window is told its name (never the full path) and whether it worked.
fn finish_download(spec: &Spec, app: &AppHandle, url: &Url, success: bool) {
    let target = {
        let mut pending = lock(&spec.state.downloads);
        let Some(at) = pending.iter().position(|(address, _)| address == url.as_str()) else { return };
        pending.remove(at).1
    };
    let name = target.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let event = format!("{}-download", spec.label);
    tell_main(app, &event, &serde_json::json!({ "name": name, "ok": success }));
}

pub fn close(spec: &Spec, app: &AppHandle) {
    spec.state.forget();
    if let Some(window) = app.get_webview_window(spec.label) {
        let _ = window.destroy();
    }
}

/// AgoraOne's window's position and size, in logical units, when they can be read.
fn main_frame(app: &AppHandle) -> Option<((f64, f64), (f64, f64))> {
    let main = app.get_webview_window("main")?;
    let scale = main.scale_factor().ok()?;
    let position = main.outer_position().ok()?.to_logical::<f64>(scale);
    let size = main.inner_size().ok()?.to_logical::<f64>(scale);
    Some(((position.x, position.y), (size.width.max(MIN_SIZE.0), size.height.max(MIN_SIZE.1))))
}

/// Goes to a page of the add-on in its window, opening the window when it is not there.
fn open(spec: &'static Spec, app: &AppHandle, url: Url) {
    if let Some(window) = app.get_webview_window(spec.label) {
        let _ = window.navigate(url);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let navigation = app.clone();
    let new_window = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::External(url))
        .title(spec.title)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .visible(true)
        .focused(true)
        .on_navigation(move |url| {
            let ok = allowed(url, current_origin(spec).as_ref());
            if !ok {
                tell_external(spec, &navigation, url);
            }
            ok
        })
        // «target=_blank»: a page of the add-on opens here instead; another site, in the browser if the user wants.
        .on_new_window(move |url, _features| {
            if allowed(&url, current_origin(spec).as_ref()) {
                let app = new_window.clone();
                let _ = new_window.run_on_main_thread(move || {
                    if let Some(window) = app.get_webview_window(spec.label) {
                        let _ = window.navigate(url);
                    }
                });
            } else {
                tell_external(spec, &new_window, &url);
            }
            NewWindowResponse::Deny
        })
        .on_permission_request(|_, _| PermissionResponse::Deny)
        .on_download(move |webview, event| match event {
            DownloadEvent::Requested { url, destination } => start_download(spec, webview.app_handle(), &url, destination),
            DownloadEvent::Finished { url, success, .. } => {
                finish_download(spec, webview.app_handle(), &url, success);
                true
            }
            _ => false,
        });
    builder = match (spec.like_main).then(|| main_frame(app)).flatten() {
        Some(((x, y), (width, height))) => builder.position(x, y).inner_size(width, height),
        None => builder.inner_size(SIZE.0, SIZE.1),
    };
    let folder = app.path().app_local_data_dir().ok().map(|folder| folder.join(format!("{}-web", spec.label)));
    let (incognito, identifier) = store_options(own_store(folder.is_some()), spec.store);
    builder = builder.incognito(incognito);
    if let Some(identifier) = identifier {
        builder = builder.data_store_identifier(identifier);
    }
    if let Some(folder) = folder {
        builder = builder.data_directory(folder);
    }
    let _ = builder.build();
}

fn apply(spec: &'static Spec, app: &AppHandle, command: &serde_json::Value) {
    match command.get("action").and_then(|a| a.as_str()) {
        Some("open") => {
            let Some(url) = command.get("url").and_then(|u| u.as_str()).and_then(|u| Url::parse(u).ok()) else { return };
            let Some(origin) = (spec.origin)(&url, &lock(&OWN_PORTS)) else { return };
            *lock(&spec.state.origin) = Some(origin);
            open(spec, app, url);
        }
        Some("close") => close(spec, app),
        _ => {}
    }
}

/// Whether the open window may stay: a module that uses it is on and the add-on's address keeps the same origin.
pub fn may_stay(answer: &serde_json::Value, origin: Option<&Origin>) -> bool {
    let on = answer.get("allowed").and_then(|a| a.as_bool()).unwrap_or(true);
    let same = match answer.get("url") {
        Some(serde_json::Value::String(url)) => Url::parse(url).ok().is_some_and(|url| allowed(&url, origin)),
        Some(serde_json::Value::Null) => false,
        _ => true,  // a core that does not say: nothing changes
    };
    on && same
}

/// While the desktop app runs: the screen's orders to open or close the add-on's window, as they come.
pub fn run(spec: &'static Spec, app: AppHandle, link: agora_server::core::CoreLink) {
    let core_port = Url::parse(&link.url).ok().and_then(|u| u.port_or_known_default());
    *lock(&OWN_PORTS) = [Some(agora_server::PORT), core_port].into_iter().flatten().collect();
    tauri::async_runtime::spawn(async move {
        let http = reqwest::Client::new();
        let mut seen: i64 = -1;
        loop {
            let path = format!("/internal/{}/window/next?after={seen}", spec.label);
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
                    apply(spec, &handle, command);
                }
                // After the orders: the module turned off or the address changed closes the window.
                if handle.get_webview_window(spec.label).is_some() && !may_stay(&answer, current_origin(spec).as_ref()) {
                    close(spec, &handle);
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origen_remoto_solo_su_origen_y_nunca_agoraone() {
        let url = |text: &str| Url::parse(text).unwrap();
        let own = [4317, 4318];
        let saved = remote_origin(&url("https://crm.example.com/es/panel"), &own);
        let origin = saved.as_ref();
        assert!(allowed(&url("https://crm.example.com/es/proyectos/x"), origin));
        assert!(allowed(&url("https://KORDIA.tech:443/es/soporte"), origin));
        assert!(!allowed(&url("https://otro-crm.example.com/"), origin), "otro host");
        assert!(!allowed(&url("https://evil.crm.example.com/"), origin), "un subdominio es otro host");
        assert!(!allowed(&url("https://crm.example.com:8443/"), origin), "otro puerto");
        assert!(!allowed(&url("http://crm.example.com/"), origin), "http frente a https");
        for wrong in ["javascript:alert(1)", "data:text/html,hola", "file:///etc/passwd", "blob:https://crm.example.com/1", "about:blank"] {
            assert!(!allowed(&url(wrong), origin), "{wrong}");
            assert!(remote_origin(&url(wrong), &own).is_none(), "{wrong}");
        }
        for wrong in ["http://crm.example.com/", "https://ana@crm.example.com/", "https://ana:pw@crm.example.com/", "http://127.0.0.1:3099/",
                      "https://127.0.0.1:3099/", "http://127.1.2.3:3099/", "http://[::1]:3099/", "http://localhost:4317/", "http://localhost:4318/"] {
            assert!(remote_origin(&url(wrong), &own).is_none(), "{wrong}");
        }
        assert_eq!(remote_origin(&url("http://localhost:3099/"), &own), Some(("http".into(), "localhost".into(), 3099)));
        let long = format!("https://crm.example.com/{}", "a".repeat(MAX_URL));
        assert!(remote_origin(&url(&long), &own).is_none(), "dirección demasiado larga");
    }

    #[test]
    fn nunca_el_almacen_por_defecto() {
        let id = [7u8; 16];
        assert_eq!(store_options(true, id), (false, Some(id)), "almacén propio con su identificador");
        assert_eq!(store_options(false, id), (true, None), "sin almacén propio, privada");
        for own in [true, false] {
            let (incognito, identifier) = store_options(own, id);
            assert!(incognito || identifier == Some(id), "sin privada, siempre con identificador propio");
        }
    }

    #[test]
    fn nombre_de_descarga_saneado_y_sin_sobrescribir() {
        let folder = std::env::temp_dir().join(format!("agora-descargas-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        assert_eq!(download_target(&folder, "guion.pdf", "x.pdf", &[]), Some(folder.join("guion.pdf")));
        std::fs::write(folder.join("guion.pdf"), b"a").unwrap();
        assert_eq!(download_target(&folder, "guion.pdf", "x.pdf", &[]), Some(folder.join("guion (2).pdf")), "nunca sobrescribe");
        std::fs::write(folder.join("guion (2).pdf"), b"b").unwrap();
        assert_eq!(download_target(&folder, "guion.pdf", "x.pdf", &[]), Some(folder.join("guion (3).pdf")));
        assert_eq!(download_target(&folder, "../../etc/passwd", "x.pdf", &[]), Some(folder.join("etcpasswd")), "sin carpetas");
        assert_eq!(download_target(&folder, "..\\..\\a.pdf", "x.pdf", &[]), Some(folder.join("a.pdf")));
        assert_eq!(download_target(&folder, ".oculto", "x.pdf", &[]), Some(folder.join("oculto")), "nada oculto");
        assert_eq!(download_target(&folder, "", "x.pdf", &[]), Some(folder.join("x.pdf")));
        assert_eq!(download_target(&folder, "..", "x.pdf", &[]), Some(folder.join("x.pdf")));
        assert_eq!(download_target(&folder, "a\u{0}b\nc.pdf", "x.pdf", &[]), Some(folder.join("abc.pdf")));
        assert_eq!(download_target(&folder, "sin-extension", "x.pdf", &[]), Some(folder.join("sin-extension")));
        let long = "a".repeat(400);
        assert_eq!(download_target(&folder, &long, "x.pdf", &[]).unwrap().file_name().unwrap().len(), 150);
        assert_eq!(download_target(&folder, "guia\u{202E}fdp.exe", "x.pdf", &[]), Some(folder.join("guiafdp.exe")), "nada invisible");
        assert_eq!(download_target(&folder, "a\u{200B}\u{2066}b\u{FEFF}.pdf", "x.pdf", &[]), Some(folder.join("ab.pdf")));
        assert_eq!(download_target(&folder, "CON.pdf", "x.pdf", &[]), Some(folder.join("_CON.pdf")), "nombre reservado en Windows");
        assert_eq!(download_target(&folder, "nul", "x.pdf", &[]), Some(folder.join("_nul")));
        assert_eq!(download_target(&folder, "com1.tar.gz", "x.pdf", &[]), Some(folder.join("_com1.tar.gz")));
        assert_eq!(download_target(&folder, "com0.pdf", "x.pdf", &[]), Some(folder.join("com0.pdf")));
        assert_eq!(download_target(&folder, "console.pdf", "x.pdf", &[]), Some(folder.join("console.pdf")));
        assert_eq!(download_target(&folder, "guia.pdf. ", "x.pdf", &[]), Some(folder.join("guia.pdf")), "sin punto ni espacio al final");
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn dos_descargas_seguidas_del_mismo_nombre_no_comparten_archivo() {
        let folder = std::env::temp_dir().join(format!("agora-descargas-seguidas-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        let state = State::new();
        let first = Url::parse("http://127.0.0.1:8742/corridas/a/archivos/1").unwrap();
        let second = Url::parse("http://127.0.0.1:8742/corridas/b/archivos/1").unwrap();
        assert_eq!(reserve(&state, &first, &folder, "guia.pdf", "x.pdf"), Some(folder.join("guia.pdf")));
        assert_eq!(reserve(&state, &second, &folder, "guia.pdf", "x.pdf"), Some(folder.join("guia (2).pdf")), "la primera aún no está en el disco");
        let taken = [folder.join("guia.pdf")];
        assert_eq!(download_target(&folder, "guia.pdf", "x.pdf", &[taken[0].as_path()]), Some(folder.join("guia (2).pdf")));
        lock(&state.downloads).clear();
        for n in 0..MAX_PENDING {
            assert!(reserve(&state, &first, &folder, &format!("{n}.pdf"), "x.pdf").is_some());
        }
        assert_eq!(reserve(&state, &first, &folder, "otra.pdf", "x.pdf"), None, "como mucho las pendientes permitidas");
        *lock(&state.origin) = Some(("http".into(), "127.0.0.1".into(), 8742));
        state.forget();
        assert!(lock(&state.origin).is_none());
        assert!(reserve(&state, &first, &folder, "otra.pdf", "x.pdf").is_some(), "al cerrar se liberan las pendientes");
        let _ = std::fs::remove_dir_all(&folder);
    }
}
