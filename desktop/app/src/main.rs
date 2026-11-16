//! AgoraOne's desktop app: starts the server and the core in this process (launch.rs) and opens a window
//! on them that is let in without a visible link or token (the window has no address bar and the page
//! trades the token for its cookie and drops it from the address at once). The page gets no access to the
//! app's native commands. Links to other sites open in the default browser, never inside the window.
//! Closing the app stops the server, the core and the conversation bridges.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod youtube_window;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use agora_server::PORT;
use agora_server::launch::{Paths, access_url, app_support, copy_first_run, load_dotenv, prepare, widen_path};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

/// The project folder when not packaged: `AGORA_ROOT`, or (development builds only) the repository this app
/// was built from. Release builds never carry the build machine's path.
fn root() -> PathBuf {
    if let Some(root) = std::env::var_os("AGORA_ROOT") {
        return PathBuf::from(root);
    }
    #[cfg(debug_assertions)]
    {
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        std::fs::canonicalize(&repository).unwrap_or(repository)
    }
    #[cfg(not(debug_assertions))]
    {
        std::env::current_dir().unwrap_or_default()
    }
}

/// A project folder the user named to bring their data from (`AGORA_MIGRAR_DESDE`): a real folder of this
/// user, never a link, another user's folder or a fixed path baked into the app.
fn migration_source() -> Option<PathBuf> {
    use std::os::unix::fs::MetadataExt;
    let folder = PathBuf::from(std::env::var_os("AGORA_MIGRAR_DESDE")?);
    let meta = std::fs::symlink_metadata(&folder).ok()?;
    // SAFETY: getuid has no preconditions.
    let mine = meta.uid() == unsafe { libc::getuid() };
    (meta.is_dir() && mine).then_some(folder)
}

/// The bundle's `Resources` when this runs as the packaged app (it carries the core inside).
fn bundle_resources() -> Option<PathBuf> {
    let executable = std::fs::canonicalize(std::env::current_exe().ok()?).ok()?;
    let resources = executable.parent()?.parent()?.join("Resources");
    resources.join("core/agora_core").is_dir().then_some(resources)
}

/// Where the app's pieces are: inside its bundle with the data in Application Support when packaged
/// (unless `AGORA_ROOT` points at a project), the repository in development.
fn layout() -> Paths {
    widen_path();
    if std::env::var_os("AGORA_ROOT").is_none()
        && let Some(resources) = bundle_resources()
    {
        let data = app_support().unwrap_or_else(|| alert("no se encuentra la carpeta del usuario"));
        let settings = data.join(".env");
        // Only from a project the user named: the first start copies (never moves) what they had there.
        if let Some(project) = migration_source() {
            if let Err(error) = copy_first_run(&project.join(".agora"), &data) {
                alert(&format!("no se pudieron copiar tus datos de .agora ({error})"));
            }
            let source = project.join(".env");
            let plain = std::fs::symlink_metadata(&source).is_ok_and(|m| m.is_file());
            if !settings.exists() && plain && std::fs::copy(&source, &settings).is_ok() {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&settings, std::fs::Permissions::from_mode(0o600));
            }
        }
        load_dotenv(&settings);
        return Paths::packaged(&resources, data);
    }
    let project = root();
    load_dotenv(&project.join(".env"));
    Paths::project(&project)
}

/// A start-up failure, shown as a native alert since the app has no terminal.
fn alert(message: &str) -> ! {
    eprintln!("AgoraOne: {message}.");
    let script = format!("display alert \"AgoraOne no ha podido arrancar\" message {}", serde_quote(message));
    let _ = std::process::Command::new("/usr/bin/osascript").args(["-e", &script]).status();
    std::process::exit(1);
}

/// An AppleScript string literal.
fn serde_quote(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Every minute, the reminders due now (never in quiet hours) become macOS notifications from AgoraOne, and
/// only those really shown are confirmed to the core, so none is lost. While the window is in front the
/// interface shows them itself (macOS does not show banners for the app in front).
fn notify_loop(app: AppHandle, link: agora_server::core::CoreLink) {
    tauri::async_runtime::spawn(async move {
        let http = reqwest::Client::new();
        tokio::time::sleep(Duration::from_secs(45)).await;
        loop {
            let in_front = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
            if !in_front {
                if let Ok(answer) = agora_server::core::core_request(&http, &link, "/alerts/due", None).await {
                    let mut shown = Vec::new();
                    for item in answer.get("notifications").and_then(|n| n.as_array()).into_iter().flatten() {
                        let (Some(key), Some(title)) = (item.get("key").and_then(|k| k.as_str()), item.get("title").and_then(|t| t.as_str())) else { continue };
                        let body = item.get("body").and_then(|b| b.as_str()).unwrap_or("");
                        if app.notification().builder().title(title).body(body).show().is_ok() {
                            shown.push(key.to_string());
                        }
                    }
                    if !shown.is_empty() {
                        let _ = agora_server::core::core_request(&http, &link, "/alerts/ack", Some(&serde_json::json!({ "keys": shown }))).await;
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

/// Only AgoraOne itself loads inside the window.
fn own(url: &Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(PORT)
}

/// ⌃⌥W from any app (user's choice, 15/11/2026): AgoraOne comes to the front and Watson starts listening.
fn listen(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.eval("window.dispatchEvent(new CustomEvent('agora:listen'))");
    }
}

/// «Oye Watson» (1.5): while the user has it on in Ajustes › Voz, the on-device listener runs and each "wake"
/// it prints works like ⌃⌥W. Off, or the app closing, stops it (its input pipe closes with the app). How it is
/// doing goes to the core for Ajustes › Voz: listening, or why it could not start. After a failure it is not
/// started again (macOS would ask again and again) until the user turns it on again or presses «Reintentar»
/// (the core's «attempt» grows). If the core cannot be read, nothing changes until the next look.
fn wake_loop(app: AppHandle, link: agora_server::core::CoreLink) {
    let helper = bundle_resources().map(|r| r.join("core/helpers/bin/agora-wake")).filter(|p| p.is_file());
    tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        let http = reqwest::Client::new();
        let mut child: Option<tokio::process::Child> = None;
        let mut failed = false;
        let mut said_off = false;
        let mut attempt = 0;
        let mut alive = Arc::new(AtomicBool::new(false));
        loop {
            if let Some(ended) = child.as_mut().and_then(|c| c.try_wait().ok().flatten()) {
                child = None;
                failed = true;
                alive.store(false, Ordering::SeqCst);
                wake_state(&http, &link, wake_failure(ended.code())).await;
            }
            let Ok(settings) = agora_server::core::core_request(&http, &link, "/wake/settings", None).await else {
                tokio::time::sleep(Duration::from_secs(4)).await;
                continue;
            };
            let on = settings.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false);
            // Turned on again (or «Reintentar»): a fresh try after a failure.
            let asked = settings.get("attempt").and_then(|a| a.as_u64()).unwrap_or(0);
            if asked != attempt {
                attempt = asked;
                failed = false;
            }
            if !on {
                // A «ready» still on its way must not say «listening» after this says «off».
                alive.store(false, Ordering::SeqCst);
                if let Some(mut stopping) = child.take() {
                    let _ = stopping.kill().await;
                    said_off = false;
                }
                if !said_off || failed {
                    wake_state(&http, &link, "off").await;
                    said_off = true;
                }
                failed = false;
            } else if child.is_none() && !failed {
                said_off = false;
                match helper.as_ref().map(|h| tokio::process::Command::new(h).stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true).spawn())
                {
                    Some(Ok(mut started)) => {
                        wake_state(&http, &link, "starting").await;
                        alive = Arc::new(AtomicBool::new(true));
                        if let Some(out) = started.stdout.take() {
                            let (app, http, link, alive) = (app.clone(), http.clone(), link.clone(), alive.clone());
                            tauri::async_runtime::spawn(async move {
                                let mut lines = tokio::io::BufReader::new(out).lines();
                                while let Ok(Some(line)) = lines.next_line().await {
                                    match line.trim() {
                                        "ready" if alive.load(Ordering::SeqCst) => wake_state(&http, &link, "listening").await,
                                        "wake" => listen(&app),
                                        _ => {}
                                    }
                                }
                            });
                        }
                        child = Some(started);
                    }
                    other => {
                        failed = true;
                        wake_state(&http, &link, if other.is_none() { "missing" } else { "stopped" }).await;
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(4)).await;
        }
    });
}

/// What the listener's exit code means (see core/helpers/wake-macos.swift).
fn wake_failure(code: Option<i32>) -> &'static str {
    match code {
        Some(2) => "no_speech_permission",
        Some(3) => "mic_failed",
        Some(4) => "no_offline",
        Some(5) => "no_mic_permission",
        _ => "stopped",
    }
}

async fn wake_state(http: &reqwest::Client, link: &agora_server::core::CoreLink, state: &str) {
    let _ = agora_server::core::core_request(http, link, "/internal/wake/status", Some(&serde_json::json!({ "state": state }))).await;
}

fn main() {
    let paths = layout();
    let server = match tauri::async_runtime::block_on(prepare(&paths)) {
        Ok(server) => server,
        Err(error) => alert(&error.to_string()),
    };
    let address: Url = access_url(PORT, &server.token).parse().expect("dirección local");
    let core_link = server.state.core.clone();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let mut stop = Some(stop);
    let mut serving = Some(tauri::async_runtime::spawn(server.serve(async {
        let _ = stopped.await;
    })));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                listen(app);
            }
        }).build())
        .setup(move |app| {
            // Taken by another app: AgoraOne still opens, only without the shortcut.
            let _ = app.global_shortcut().register(Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyW));
            if let Some(link) = core_link.clone() {
                notify_loop(app.handle().clone(), link.clone());
                wake_loop(app.handle().clone(), link.clone());
                youtube_window::youtube_loop(app.handle().clone(), link);
            }
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(address.clone()))
                .title("AgoraOne")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 680.0)
                .on_navigation(|url| {
                    if own(url) {
                        return true;
                    }
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = std::process::Command::new("/usr/bin/open").arg(url.as_str()).status();
                    }
                    false
                })
                .build()?;
            // A termination signal closes the app the normal way, so the core and the bridges stop with it.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tokio::signal::unix::{SignalKind, signal};
                let (Ok(mut terminate), Ok(mut interrupt)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else { return };
                tokio::select! {
                    _ = terminate.recv() => {}
                    _ = interrupt.recv() => {}
                }
                handle.exit(0);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|_| alert("no se pudo abrir la ventana"));
    app.run(move |app, event| {
        // The hidden YouTube window never keeps the app open: closing AgoraOne's window closes it too.
        if let RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = &event
            && label == "main"
        {
            app.exit(0);
        }
        if let RunEvent::Exit = event {
            if let Some(stop) = stop.take() {
                let _ = stop.send(());
            }
            if let Some(serving) = serving.take() {
                let _ = tauri::async_runtime::block_on(async { tokio::time::timeout(Duration::from_secs(15), serving).await });
            }
        }
    });
}
