//! The text of an uploaded PDF or DOCX, extracted by the core's Python (`agora_core.extract`, pypdf and
//! python-docx) in its own process: bytes on stdin, JSON on stdout, no credentials in its environment, at
//! most two at a time, 15 seconds and 100 000 bytes of output. On macOS it runs sandboxed: no network, no
//! file writes, no child processes and no reading the contents of the user's files (only its own Python and
//! the core's folder), so a flaw in a parser stays contained.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::Semaphore;

use super::{MAX_TEXT, canonical_base64, decode_document};
use crate::core::CoreLaunch;

const MAX_BINARY: usize = 5 * 1024 * 1024;
const MAX_OUTPUT: u64 = 100_000;
const LIMIT: Duration = Duration::from_secs(15);
const SANDBOX: &str = "/usr/bin/sandbox-exec";
/// Everything is allowed except what a parser never needs: the network, writing files, new processes and
/// the contents of the user's files (homes, other disks and temporary folders). File names and sizes stay
/// visible, which Python needs to resolve its own paths.
const SANDBOX_BASE: &str = "(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write-data (literal \"/dev/null\"))(deny process-fork)\
(deny file-read-data (subpath \"/Users\") (subpath \"/Volumes\") (subpath \"/private/var/folders\") (subpath \"/private/tmp\"))";
static RUNNING: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(2));

const SIZE: &str = "Tamaño o codificación no válidos. TXT/Markdown: 24 KiB; PDF/DOCX: 5 MiB.";
const FAILED: &str = "No se pudo extraer el texto. Comprueba que el archivo no esté protegido o dañado, contenga texto seleccionable y no supere 100 páginas PDF ni 24 KiB de texto. No se aplica OCR.";

/// Which Python runs the extractor, and from which folder (the core's).
#[derive(Clone, Debug)]
pub struct Extractor {
    pub python: PathBuf,
    pub folder: PathBuf,
}

impl Extractor {
    pub fn from_launch(launch: &CoreLaunch) -> Self {
        match launch {
            CoreLaunch::Uv { folder } => Self { python: folder.join(".venv/bin/python"), folder: folder.clone() },
            CoreLaunch::Bundled { python, folder } => Self { python: python.clone(), folder: folder.clone() },
        }
    }
}

/// The sandbox profile that lets `program` (and the Python installation it belongs to) and `readable` be read.
pub fn sandbox_profile(program: &Path, readable: &[&Path]) -> String {
    let mut allowed: Vec<PathBuf> = readable.iter().filter_map(|path| std::fs::canonicalize(path).ok()).collect();
    // A venv's python is a link to the real installation, whose standard library lives two levels up. A
    // shallow one (a python straight in ~/bin) would open the whole home, so it is not added.
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    if let Some(root) = std::fs::canonicalize(program).ok().and_then(|real| real.parent()?.parent().map(Path::to_path_buf))
        && root.components().count() >= 4
        && !home.starts_with(&root)
    {
        allowed.push(root);
    }
    let quoted: Vec<String> = allowed.iter().map(|path| format!("(subpath \"{}\")", path.display().to_string().replace('\\', "\\\\").replace('"', "\\\""))).collect();
    if quoted.is_empty() { SANDBOX_BASE.to_string() } else { format!("{SANDBOX_BASE}(allow file-read-data {})", quoted.join(" ")) }
}

/// A command run inside the sandbox when the system has one; besides the system, it reads only its own
/// Python and `readable`.
pub fn sandboxed(program: &Path, readable: &[&Path]) -> Command {
    if Path::new(SANDBOX).exists() {
        let mut command = Command::new(SANDBOX);
        command.arg("-p").arg(sandbox_profile(program, readable)).arg(program);
        command
    } else {
        Command::new(program)
    }
}

pub fn is_binary(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".pdf") || lower.ends_with(".docx")
}

/// The upload as text in base64, ready to store: text files are checked as they are, PDF and DOCX are
/// extracted. The error is the message for the user.
pub async fn extract_upload(extractor: Option<&Extractor>, name: &str, base64: &str) -> Result<String, String> {
    let binary = is_binary(name);
    let bytes = canonical_base64(base64).filter(|b| !b.is_empty() && b.len() <= if binary { MAX_BINARY } else { MAX_TEXT }).ok_or(SIZE)?;
    if !binary {
        decode_document(base64).map_err(|_| SIZE)?;
        return Ok(base64.to_string());
    }
    let _turn = RUNNING.try_acquire().map_err(|_| "Hay dos importaciones en curso. Inténtalo de nuevo en unos segundos.")?;
    let extractor = extractor.ok_or("No se pudo iniciar la extracción.")?;
    let kind = if name.to_lowercase().ends_with(".pdf") { "pdf" } else { "docx" };
    let content = run(extractor, kind, bytes).await?;
    let encoded = STANDARD.encode(content.as_bytes());
    decode_document(&encoded).map_err(|_| FAILED)?;
    Ok(encoded)
}

async fn run(extractor: &Extractor, kind: &str, bytes: Vec<u8>) -> Result<String, String> {
    let mut command = sandboxed(&extractor.python, &[&extractor.folder]);
    command
        .args(["-E", "-s", "-B", "-m", "agora_core.extract", kind])
        .current_dir(&extractor.folder)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "en_US.UTF-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| "No se pudo iniciar la extracción.")?;
    let pid = child.id();
    let (mut stdin, stdout) = (child.stdin.take(), child.stdout.take());
    let work = async {
        // The extractor reads all its input before answering; one that stops early just ends the write.
        let feed = async {
            if let Some(stdin) = stdin.as_mut() {
                let _ = stdin.write_all(&bytes).await;
            }
            drop(stdin);
        };
        let read = async {
            let mut output = Vec::new();
            if let Some(stdout) = stdout {
                stdout.take(MAX_OUTPUT + 1).read_to_end(&mut output).await.ok()?;
            }
            Some(output)
        };
        let ((), output) = tokio::join!(feed, read);
        if output.as_ref().is_none_or(|o| o.len() as u64 > MAX_OUTPUT) {
            // Too much output: stop it now rather than at the time limit.
            let _ = child.start_kill();
        }
        let status = child.wait().await.ok()?;
        let output = output.filter(|o| o.len() as u64 <= MAX_OUTPUT && status.success())?;
        let answer: serde_json::Value = serde_json::from_slice(&output).ok()?;
        answer.get("content")?.as_str().map(str::to_string)
    };
    match tokio::time::timeout(LIMIT, work).await {
        Ok(Some(content)) => Ok(content),
        Ok(None) => Err(FAILED.into()),
        Err(_) => {
            if let Some(pid) = pid {
                // SAFETY: signals only the process group this call created.
                unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
            }
            Err(FAILED.into())
        }
    }
}
