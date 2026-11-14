//! `agoraone`: starts AgoraOne from the project folder (or `AGORA_ROOT`) and prints the private access link
//! to this terminal only; `agoraone abrir` opens that link in the default browser, and
//! `agoraone comprobar-hermes` checks once that Hermes and the provider answer.

use std::path::PathBuf;

use agora_server::access;
use agora_server::launch::{Paths, access_url, load_dotenv, prepare};

/// The interface the link points to: Vite in development (5173), or this server when it serves `dist`.
fn web_port() -> u16 {
    std::env::var("AGORA_WEB_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(5173)
}

async fn shutdown() {
    use tokio::signal::unix::{SignalKind, signal};
    let (mut interrupt, mut terminate, mut hangup) = (
        signal(SignalKind::interrupt()).expect("señal"),
        signal(SignalKind::terminate()).expect("señal"),
        signal(SignalKind::hangup()).expect("señal"),
    );
    tokio::select! {
        _ = interrupt.recv() => {}
        _ = terminate.recv() => {}
        _ = hangup.recv() => {}
    }
}

#[tokio::main]
async fn main() {
    let root = std::env::var_os("AGORA_ROOT").map(PathBuf::from).unwrap_or_else(|| std::env::current_dir().expect("carpeta actual"));
    let paths = Paths::project(&root);
    if std::env::args().nth(1).as_deref() == Some("abrir") {
        let token = match access::load_token(&paths.data.join("access-token")) {
            Ok(token) => token,
            Err(_) => return eprintln!("AgoraOne: no se pudo leer el enlace de acceso."),
        };
        let opened = std::process::Command::new("/usr/bin/open").arg(access_url(web_port(), &token)).status();
        return match opened {
            Ok(status) if status.success() => println!("AgoraOne abierto en el navegador con el enlace de acceso."),
            _ => eprintln!("AgoraOne: no se pudo abrir el navegador."),
        };
    }
    load_dotenv(&root.join(".env"));
    if std::env::args().nth(1).as_deref() == Some("comprobar-hermes") {
        let location = agora_server::hermes::location::from_env();
        println!("{}", agora_server::hermes_readiness_at(&location));
        return match agora_server::chat::check_hermes(&location, &paths.data).await {
            Ok(answer) => println!("{answer}"),
            Err(message) => {
                eprintln!("{message}");
                std::process::exit(1);
            }
        };
    }
    let server = match prepare(&paths).await {
        Ok(server) => server,
        Err(error) => {
            eprintln!("AgoraOne: {error}.");
            std::process::exit(1);
        }
    };
    println!("AgoraOne: http://127.0.0.1:{}", agora_server::PORT);
    // Printed only to the user's own terminal: the link that lets this browser in (once; then a cookie remembers it).
    println!("Abre AgoraOne con este enlace: {}", access_url(web_port(), &server.token));
    if let Err(error) = server.serve(shutdown()).await {
        eprintln!("AgoraOne: {error}.");
        std::process::exit(1);
    }
}
