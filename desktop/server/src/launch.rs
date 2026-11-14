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

impl Paths {
    /// The packaged app: everything it needs inside its `Resources`, the user's data outside the app.
    pub fn packaged(resources: &Path, data: PathBuf) -> Self {
        Self {
            data,
            web: resources.join("web"),
            examples: resources.join("library-test"),
            core: Some(CoreLaunch::Bundled { python: resources.join("python/bin/python3"), folder: resources.join("core") }),
        }
    }
}

/// Where the packaged app keeps the user's data: `~/Library/Application Support/AgoraOne`.
pub fn app_support() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("HOME")?).join("Library/Application Support/AgoraOne"))
}

fn is_sqlite(path: &Path) -> bool {
    use std::io::Read;
    let mut header = [0u8; 16];
    std::fs::File::open(path).and_then(|mut file| file.read_exact(&mut header)).is_ok() && &header == b"SQLite format 3\0"
}

/// A consistent copy of a SQLite database that may be open (the core and Hermes use WAL): what is still in
/// its `-wal` file goes in, and nothing half-written does. Opened read-only, so the original and its
/// journal files are left exactly as they were.
fn snapshot(from: &Path, to: &Path) -> rusqlite::Result<()> {
    use rusqlite::{Connection, OpenFlags};
    let target = to.to_str().ok_or(rusqlite::Error::InvalidPath(to.to_path_buf()))?;
    let source = Connection::open_with_flags(from, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    source.busy_timeout(Duration::from_secs(5))?;
    source.execute("VACUUM INTO ?1", [target])?;
    Ok(())
}

/// Copies a database consistently, or, if SQLite cannot read it (damaged, locked or not really SQLite), as
/// plain files together with its journal, as before: the user's data is never left behind.
fn copy_database(from: &Path, to: &Path) -> std::io::Result<()> {
    if snapshot(from, to).is_ok() {
        return Ok(());
    }
    let _ = std::fs::remove_file(to);
    std::fs::copy(from, to)?;
    for journal in ["-wal", "-shm"] {
        let (source, target) = (PathBuf::from(format!("{}{journal}", from.display())), PathBuf::from(format!("{}{journal}", to.display())));
        if std::fs::symlink_metadata(&source).is_ok_and(|m| m.is_file()) {
            std::fs::copy(&source, &target)?;
        }
    }
    Ok(())
}

/// The first time the packaged app starts, the data the user already had in the project's `.agora` is
/// copied (never moved or deleted) to its own folder; later starts leave both alone. Links are not followed.
pub fn copy_first_run(from: &Path, to: &Path) -> std::io::Result<bool> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    if to.exists() || !from.is_dir() {
        return Ok(false);
    }
    let staging = to.with_extension("copiando");
    let _ = std::fs::remove_dir_all(&staging);
    fn copy(from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::DirBuilder::new().mode(0o700).create(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            let target = to.join(entry.file_name());
            if kind.is_dir() {
                copy(&entry.path(), &target)?;
            } else if kind.is_file() {
                let name = entry.file_name().to_string_lossy().to_string();
                let journal = name.strip_suffix("-wal").or_else(|| name.strip_suffix("-shm"));
                if journal.is_some_and(|base| is_sqlite(&from.join(base))) {
                    continue; // copied with its database
                }
                if is_sqlite(&entry.path()) {
                    copy_database(&entry.path(), &target)?;
                } else {
                    std::fs::copy(entry.path(), &target)?;
                }
            }
        }
        Ok(())
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    copy(from, &staging)?;
    std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o700))?;
    // Renamed into place only when complete, so an interrupted copy is redone, never half-used.
    std::fs::rename(&staging, to)?;
    Ok(true)
}

/// An app opened from Finder gets a bare PATH; the user's own program folders are added so the core finds
/// the installed Claude Code and the profiles' MCP launchers are found as in their terminal.
pub fn widen_path() {
    let home = std::env::var("HOME").unwrap_or_default();
    let current = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into());
    let mut parts: Vec<String> = current.split(':').filter(|p| !p.is_empty()).map(str::to_string).collect();
    for extra in [format!("{home}/.local/bin"), "/opt/homebrew/bin".into(), "/usr/local/bin".into()] {
        if !parts.contains(&extra) && Path::new(&extra).is_dir() {
            parts.push(extra);
        }
    }
    // SAFETY: called at start-up, before any other thread reads the environment.
    unsafe { std::env::set_var("PATH", parts.join(":")) };
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
        let asked = std::sync::Arc::new(tokio::sync::Notify::new());
        let signal = asked.clone();
        let graceful = axum::serve(self.listener, router(self.state.clone())).with_graceful_shutdown(async move {
            shutdown.await;
            signal.notify_one();
        });
        // Open streams (a turn's NDJSON, the assistant's events) may hold connections: they get a few seconds,
        // then the core and the bridges are stopped anyway.
        let served = tokio::select! {
            result = graceful => result,
            _ = async {
                asked.notified().await;
                tokio::time::sleep(Duration::from_secs(5)).await;
            } => Ok(()),
        };
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
    fn la_primera_vez_copia_agora_sin_moverla_y_despues_no_toca_nada() {
        let dir = tempfile::tempdir().unwrap();
        let (from, to) = (dir.path().join(".agora"), dir.path().join("Application Support/AgoraOne"));
        std::fs::create_dir_all(from.join("library/dueño")).unwrap();
        std::fs::write(from.join("access-token"), "token").unwrap();
        std::fs::write(from.join("library/dueño/copia.json"), "{}").unwrap();
        std::os::unix::fs::symlink("/etc/hosts", from.join("enlace")).unwrap();
        assert!(copy_first_run(&from, &to).unwrap());
        assert_eq!(std::fs::read_to_string(to.join("library/dueño/copia.json")).unwrap(), "{}");
        assert!(from.join("access-token").exists(), "el original se queda");
        assert!(!to.join("enlace").exists(), "los enlaces no se copian");
        std::fs::write(from.join("access-token"), "otro").unwrap();
        assert!(!copy_first_run(&from, &to).unwrap(), "solo la primera vez");
        assert_eq!(std::fs::read_to_string(to.join("access-token")).unwrap(), "token");
        let empty = dir.path().join("nueva");
        assert!(!copy_first_run(&dir.path().join("no-existe"), &empty).unwrap());
    }

    #[test]
    fn las_bases_sqlite_abiertas_se_copian_completas_y_sin_su_wal() {
        let dir = tempfile::tempdir().unwrap();
        let (live, from, to) = (dir.path().join("viva"), dir.path().join(".agora"), dir.path().join("AgoraOne"));
        std::fs::create_dir_all(&live).unwrap();
        std::fs::create_dir_all(from.join("core")).unwrap();
        // A database in WAL mode, as the core keeps it, with rows that are still only in the -wal file.
        let open = rusqlite::Connection::open(live.join("agora.db")).unwrap();
        open.pragma_update(None, "journal_mode", "WAL").unwrap();
        open.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        open.execute_batch("CREATE TABLE notas(texto TEXT); INSERT INTO notas VALUES ('una'), ('dos');").unwrap();
        // Its files as a writer that died leaves them: nobody else has them open, so the copy is the last
        // connection and must still not checkpoint or delete anything.
        for name in ["agora.db", "agora.db-wal", "agora.db-shm"] {
            std::fs::copy(live.join(name), from.join("core").join(name)).unwrap();
        }
        drop(open);
        // The -shm file is only a shared index that every reader updates; the data is the database and its WAL.
        let read = |path: &Path| ["agora.db", "agora.db-wal"].map(|name| std::fs::read(path.join(name)).unwrap());
        let original = read(&from.join("core"));
        assert!(copy_first_run(&from, &to).unwrap());
        assert_eq!(read(&from.join("core")), original, "el origen y su wal no cambian");
        assert!(from.join("core/agora.db-shm").exists(), "ni se borra su índice");
        assert!(!to.join("core/agora.db-wal").exists() && !to.join("core/agora.db-shm").exists());
        let copy = rusqlite::Connection::open(to.join("core/agora.db")).unwrap();
        let count: i64 = copy.query_row("SELECT count(*) FROM notas", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 2, "lo que estaba en el wal también se copia");
    }

    #[test]
    fn una_base_que_sqlite_no_lee_se_copia_tal_cual() {
        let dir = tempfile::tempdir().unwrap();
        let (from, to) = (dir.path().join(".agora"), dir.path().join("AgoraOne"));
        std::fs::create_dir_all(&from).unwrap();
        let damaged = [b"SQLite format 3\0".as_slice(), &[0xff; 100]].concat();
        std::fs::write(from.join("rota.db"), &damaged).unwrap();
        std::fs::write(from.join("rota.db-wal"), "wal").unwrap();
        assert!(copy_first_run(&from, &to).unwrap());
        assert_eq!(std::fs::read(to.join("rota.db")).unwrap(), damaged);
        assert_eq!(std::fs::read_to_string(to.join("rota.db-wal")).unwrap(), "wal");
    }

    #[test]
    fn rutas_de_la_app_empaquetada() {
        let paths = Paths::packaged(Path::new("/App/Contents/Resources"), PathBuf::from("/datos"));
        assert_eq!(paths.web, Path::new("/App/Contents/Resources/web"));
        assert!(matches!(paths.core, Some(CoreLaunch::Bundled { ref python, .. }) if python.ends_with("python/bin/python3")));
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
