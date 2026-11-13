//! Where Hermes keeps its data and code: `~/.hermes` unless AGORA_HERMES_HOME or HERMES_HOME say otherwise
//! (a HERMES_HOME pointing at one profile is taken back to the data root).

use std::path::{Path, PathBuf};

use super::safe_read::normalize;

#[derive(Clone, Debug)]
pub struct HermesLocation {
    pub root: PathBuf,
    pub installation: PathBuf,
    pub python: PathBuf,
    pub source: String,
}

pub fn hermes_location(env: impl Fn(&str) -> Option<String>, home: &Path) -> HermesLocation {
    let var = |name: &str| env(name).filter(|value| !value.is_empty());
    let expand = |value: &str| normalize(&value.strip_prefix("~/").map(|rest| home.join(rest)).unwrap_or_else(|| PathBuf::from(value)));
    let agora_home = var("AGORA_HERMES_HOME");
    let hermes_home = var("HERMES_HOME");
    let mut root = expand(agora_home.as_deref().or(hermes_home.as_deref()).unwrap_or(&home.join(".hermes").to_string_lossy()));
    if agora_home.is_none() && root.parent().and_then(Path::file_name).is_some_and(|name| name == "profiles") {
        root = root.parent().and_then(Path::parent).map(Path::to_path_buf).unwrap_or(root);
    }
    let candidates: Vec<PathBuf> =
        [var("AGORA_HERMES_PATH").map(|p| expand(&p)), Some(root.join("hermes-agent")), Some(home.join(".hermes/hermes-agent"))].into_iter().flatten().collect();
    let installation = candidates.iter().find(|path| path.join("run_agent.py").exists()).unwrap_or(&candidates[0]).clone();
    let python = var("AGORA_HERMES_PYTHON").map(PathBuf::from).unwrap_or_else(|| installation.join("venv/bin/python"));
    let source = if agora_home.is_some() {
        "AGORA_HERMES_HOME"
    } else if hermes_home.is_some() {
        "HERMES_HOME"
    } else {
        "Directorio Hermes del usuario"
    };
    HermesLocation { root, installation, python, source: source.into() }
}

/// The location from this process' environment and the user's home.
pub fn from_env() -> HermesLocation {
    let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
    hermes_location(|name| std::env::var(name).ok(), &home)
}
