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
pub const PROFILE_WRITER: &str = include_str!("../../../../server/hermes_profile_write.py");
/// Scheduled tasks and kanban cards of one profile, with Hermes' own functions.
pub const MANAGE: &str = include_str!("../../../../server/hermes_manage.py");
/// One MCP tool of a profile called by hand.
pub const MCP_CALL: &str = include_str!("../../../../server/hermes_mcp_call.py");

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
    ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].into_iter().map(PathBuf::from).find(|p| p.exists())
}

/// The user's PATH (it holds no secrets), or the system one.
pub fn user_path() -> String {
    std::env::var("PATH").ok().filter(|p| !p.is_empty()).unwrap_or_else(|| "/usr/bin:/bin".into())
}

pub fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// Runs a script. `group` puts it in its own process group, so whatever it starts (an MCP server) is
/// stopped with it on timeout.
pub async fn run_python(python: &Path, source: &str, env: &[(&str, String)], request: &Value, limit: Duration, group: bool) -> Result<Value, RunError> {
    let mut command = Command::new(python);
    command.arg("-I").arg("-c").arg(source).env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    for (key, value) in env {
        command.env(key, value);
    }
    if group {
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|_| RunError::Spawn)?;
    let pid = child.id();
    if let Some(mut stdin) = child.stdin.take() {
        // A script that exits before reading its request simply answers nothing.
        let _ = stdin.write_all(request.to_string().as_bytes()).await;
    }
    match tokio::time::timeout(limit, child.wait_with_output()).await {
        Ok(Ok(output)) => serde_json::from_slice(&output.stdout).map_err(|_| RunError::Output),
        Ok(Err(_)) => Err(RunError::Output),
        Err(_) => {
            if group && let Some(pid) = pid {
                // SAFETY: signals only the process group this call created.
                unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
            }
            Err(RunError::Timeout)
        }
    }
}
