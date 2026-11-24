//! The isolated Python helpers that write to Hermes with Hermes' own functions. They are the same scripts as
//! before, built into the binary and run with `python -I -c`, a JSON request on stdin and a JSON answer on
//! stdout, with a minimal environment chosen by each caller and a time limit.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Writes one identity or skill file: revision check, backup, Hermes' memory lock, atomic replace.
pub const PROFILE_WRITER: &str = include_str!("../../python/hermes_profile_write.py");
/// Scheduled tasks and kanban cards of one profile, with Hermes' own functions.
pub const MANAGE: &str = include_str!("../../python/hermes_manage.py");
/// One MCP tool of a profile called by hand.
pub const MCP_CALL: &str = include_str!("../../python/hermes_mcp_call.py");

#[derive(Debug, PartialEq)]
pub enum RunError {
    /// Python could not be started.
    Spawn,
    /// It ran past its limit and was stopped (with its process group, when it has one).
    Timeout,
    /// It ended without a JSON answer.
    Output,
}

/// A system Python 3, for the writer (it needs nothing from Hermes).
pub fn system_python() -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].into_iter().map(PathBuf::from).find(|p| p.exists())
    }
    #[cfg(windows)]
    {
        let usable = |p: &Path| {
            !p.to_string_lossy().to_ascii_lowercase().contains("windowsapps")
                && std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() > 0)
        };
        if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
            let core_py = PathBuf::from(manifest).join("../../core/.venv/Scripts/python.exe");
            if usable(&core_py) {
                return crate::platform::canonicalize(&core_py).ok().or(Some(core_py));
            }
        }
        if let Some(paths) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&paths) {
                for name in ["python3.exe", "python.exe"] {
                    let candidate = dir.join(name);
                    if usable(&candidate) {
                        return Some(candidate);
                    }
                }
            }
        }
        None
    }
}

/// The user's PATH (it holds no secrets), or the system one.
pub fn user_path() -> String {
    std::env::var("PATH").ok().filter(|p| !p.is_empty()).unwrap_or_else(crate::platform::default_system_path)
}

pub fn home() -> String {
    crate::platform::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Runs a script. `group` puts it in its own process group, so whatever it starts (an MCP server) is
/// stopped with it on timeout.
pub async fn run_python(python: &Path, source: &str, env: &[(&str, String)], request: &Value, limit: Duration, group: bool) -> Result<Value, RunError> {
    let mut command = Command::new(python);
    command.args(["-X", "utf8", "-I", "-c", source]).env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    for (key, value) in env {
        command.env(key, value);
    }
    crate::platform::apply_minimal_os_env(&mut command);
    let (mut child, proc_group) = if group {
        let (child, proc_group) = crate::platform::spawn_in_group(&mut command).map_err(|_| RunError::Spawn)?;
        (child, Some(proc_group))
    } else {
        (command.spawn().map_err(|_| RunError::Spawn)?, None)
    };
    if let Some(mut stdin) = child.stdin.take() {
        // A script that exits before reading its request simply answers nothing.
        let _ = stdin.write_all(request.to_string().as_bytes()).await;
    }
    match tokio::time::timeout(limit, child.wait_with_output()).await {
        Ok(Ok(output)) => serde_json::from_slice(&output.stdout).map_err(|_| RunError::Output),
        Ok(Err(_)) => Err(RunError::Output),
        Err(_) => {
            if let Some(proc_group) = proc_group {
                proc_group.kill();
            }
            Err(RunError::Timeout)
        }
    }
}
