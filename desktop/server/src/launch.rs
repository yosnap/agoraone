//! Starting AgoraOne: the access token, the Python core, the brain's index sync and the server on
//! 127.0.0.1:4317 (a busy port is reported, never swapped for another), and stopping all of it together.
//! Used by the `agoraone` binary and by the desktop app.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::chat::worker;
use crate::core::{CoreLaunch, CoreLink, start};
use crate::hermes::{location, resources};
use crate::library::extract::Extractor;
use crate::{AppState, Config, PORT, access, router};

/// Where AgoraOne's pieces are. In development everything hangs from the project folder.
#[derive(Clone, Debug)]
pub struct Paths {
    pub data: PathBuf,
    pub web: PathBuf,
    pub examples: PathBuf,
    /// The core: its folder (run with uv) or a bundled Python.
    pub core: Option<CoreLaunch>,
}

impl Paths {
    /// The project folder layout: `.agora`, `dist`, `resources/library-test` and `core` (run with uv).
    pub fn project(root: &Path) -> Self {
        let core = root.join("core");
        Self {
            data: root.join(".agora"),
            web: root.join("dist"),
            examples: root.join("resources/library-test"),
            core: core.join("pyproject.toml").exists().then_some(CoreLaunch::Uv { folder: core }),
        }
    }
}

/// `KEY=value` lines of a dotenv file, for variables not already set (like `node --env-file`). Values are
/// never printed.
pub fn load_dotenv(file: &Path) {
    let Ok(text) = std::fs::read_to_string(file) else { return };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.strip_prefix("export ").unwrap_or(line).split_once('=') else { continue };
        let key = key.trim();
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') || std::env::var_os(key).is_some() {
            continue;
        }
        let value = value.trim();
        let value = [('"', '"'), ('\'', '\'')].iter().find_map(|(a, b)| value.strip_prefix(*a).and_then(|v| v.strip_suffix(*b))).unwrap_or(value);
        // SAFETY: called at start-up, before any other thread reads the environment.
        unsafe { std::env::set_var(key, value) };
    }
}

fn exit_message(code: i32) -> String {
    match code {
        2 => "falta el secreto de arranque".into(),
        3 => "el puerto 4318 está ocupado; comprueba quién lo usa con «lsof -iTCP:4318 -sTCP:LISTEN»".into(),
        other => format!("código {other}"),
    }
}

/// A prepared AgoraOne: its token, state and listening socket, with the core already running.
pub struct Server {
    pub token: String,
    pub state: std::sync::Arc<AppState>,
    listener: TcpListener,
    stop_core: Option<oneshot::Sender<()>>,
    core_done: Option<oneshot::Receiver<()>>,
}

/// Reads or creates the token, binds the port and starts the core.
pub async fn prepare(paths: &Paths) -> anyhow::Result<Server> {
    let token = access::load_token(&paths.data.join("access-token"))?;
    let listener = TcpListener::bind(("127.0.0.1", PORT)).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::AddrInUse {
            anyhow::anyhow!("el puerto {PORT} está ocupado; comprueba quién lo usa con «lsof -iTCP:{PORT} -sTCP:LISTEN»")
        } else {
            anyhow::anyhow!("no se pudo escuchar en 127.0.0.1:{PORT} ({error})")
        }
    })?;
    let link = CoreLink { url: crate::core::CORE_URL.into(), secret: access::random_hex() };
    let (mut stop_core, mut core_done, mut core) = (None, None, None);
    match &paths.core {
        None => eprintln!("AgoraOne: no se encuentra el núcleo (carpeta core); se sigue sin él."),
        Some(launch) => match start(launch, &link, &paths.data.join("core")) {
            Err(_) => eprintln!("AgoraOne: no se pudo arrancar el núcleo; instala uv (https://docs.astral.sh/uv/) y reinicia."),
            Ok(mut child) => {
                let (stop, stopped) = oneshot::channel::<()>();
                let (done, finished) = oneshot::channel::<()>();
                tokio::spawn(async move {
                    tokio::select! {
                        status = child.wait() => {
                            if let Ok(status) = status && let Some(code) = status.code().filter(|c| *c != 0) {
                                eprintln!("AgoraOne: el núcleo se detuvo ({}).", exit_message(code));
                            }
                        }
                        _ = stopped => {
                            // SAFETY: a plain signal to the core this process started.
                            if let Some(pid) = child.id() { unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) }; }
                            if tokio::time::timeout(Duration::from_secs(5), child.wait()).await.is_err() {
                                let _ = child.kill().await;
                            }
                        }
                    }
                    let _ = done.send(());
                });
                (stop_core, core_done, core) = (Some(stop), Some(finished), Some(launch.clone()));
            }
        },
    }
    let config = Config {
        data: paths.data.clone(),
        web: paths.web.clone(),
        hosts: vec![format!("127.0.0.1:{PORT}"), "127.0.0.1:5173".into()],
        hermes: location::from_env(),
        obsidian_registry: resources::obsidian_registry_path(),
        examples: paths.examples.clone(),
        extractor: core.as_ref().map(Extractor::from_launch),
    };
    let state = AppState::new(config, &token, core.is_some().then_some(link));
    Ok(Server { token, state, listener, stop_core, core_done })
}

impl Server {
    /// Serves until `shutdown` resolves, keeping the brain's index in step; then stops the core and the
    /// conversation bridges so nothing is left running.
    pub async fn serve(mut self, shutdown: impl Future<Output = ()> + Send + 'static) -> anyhow::Result<()> {
        let sync = self.state.brain_sync().map(|sync| sync.start());
        let served = axum::serve(self.listener, router(self.state.clone())).with_graceful_shutdown(shutdown).await;
        if let Some(sync) = sync {
            sync.abort();
        }
        worker::close_all();
        if let Some(stop) = self.stop_core.take() {
            let _ = stop.send(());
        }
        if let Some(done) = self.core_done.take() {
            let _ = tokio::time::timeout(Duration::from_secs(8), done).await;
        }
        served.map_err(Into::into)
    }
}

/// The browser address that lets this browser in (the token goes in the fragment, never to a server log).
pub fn access_url(port: u16, token: &str) -> String {
    format!("http://127.0.0.1:{port}/#acceso={token}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dotenv_sin_pisar_lo_definido_y_con_comillas() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("variables-de-prueba");
        std::fs::write(&file, "# comentario\nAGORA_PRUEBA_UNO=\"valor uno\"\nexport AGORA_PRUEBA_DOS='dos'\nAGORA_PRUEBA_TRES=nuevo\nmal formada\n").unwrap();
        // SAFETY: variables only this test uses.
        unsafe { std::env::set_var("AGORA_PRUEBA_TRES", "previo") };
        load_dotenv(&file);
        assert_eq!(std::env::var("AGORA_PRUEBA_UNO").unwrap(), "valor uno");
        assert_eq!(std::env::var("AGORA_PRUEBA_DOS").unwrap(), "dos");
        assert_eq!(std::env::var("AGORA_PRUEBA_TRES").unwrap(), "previo", "no pisa lo ya definido");
    }

    #[test]
    fn el_enlace_lleva_el_token_en_el_fragmento() {
        assert_eq!(access_url(5173, "abc"), "http://127.0.0.1:5173/#acceso=abc");
    }

    #[test]
    fn rutas_del_proyecto() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::project(dir.path());
        assert!(paths.core.is_none(), "sin carpeta core no hay núcleo");
        assert_eq!(paths.data, dir.path().join(".agora"));
        std::fs::create_dir(dir.path().join("core")).unwrap();
        std::fs::write(dir.path().join("core/pyproject.toml"), "").unwrap();
        assert!(matches!(Paths::project(dir.path()).core, Some(CoreLaunch::Uv { .. })));
    }
}
