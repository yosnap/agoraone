//! AgoraOne's desktop app: starts the server and the core in this process (launch.rs) and opens a window
//! on them that is let in without a visible link or token (the window has no address bar and the page
//! trades the token for its cookie and drops it from the address at once). The page gets no access to the
//! app's native commands. Links to other sites open in the default browser, never inside the window.
//! Closing the app stops the server, the core and the conversation bridges.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::time::Duration;

use agora_server::PORT;
use agora_server::launch::{Paths, access_url, app_support, copy_first_run, load_dotenv, prepare, widen_path};
use tauri::{RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

/// The project folder in development (`AGORA_ROOT`, or the repository this app was built from); the
/// packaged app will carry its own layout.
fn root() -> PathBuf {
    std::env::var_os("AGORA_ROOT").map(PathBuf::from).unwrap_or_else(|| {
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        std::fs::canonicalize(&repository).unwrap_or(repository)
    })
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
        let project = root();
        // The first start copies (never moves) what the user already had in the project.
        if let Err(error) = copy_first_run(&project.join(".agora"), &data) {
            alert(&format!("no se pudieron copiar tus datos de .agora ({error})"));
        }
        let settings = data.join(".env");
        if !settings.exists() && project.join(".env").is_file() && std::fs::copy(project.join(".env"), &settings).is_ok() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&settings, std::fs::Permissions::from_mode(0o600));
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

/// Only AgoraOne itself loads inside the window.
fn own(url: &Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(PORT)
}

fn main() {
    let paths = layout();
    let server = match tauri::async_runtime::block_on(prepare(&paths)) {
        Ok(server) => server,
        Err(error) => alert(&error.to_string()),
    };
    let address: Url = access_url(PORT, &server.token).parse().expect("dirección local");
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let mut stop = Some(stop);
    let mut serving = Some(tauri::async_runtime::spawn(server.serve(async {
        let _ = stopped.await;
    })));
    let app = tauri::Builder::default()
        .setup(move |app| {
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
    app.run(move |_, event| {
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
