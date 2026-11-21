//! MCP servers declared in a profile (an explicit allowlist of metadata, never commands, URLs, headers or
//! env) and the Obsidian vaults in Obsidian's own registry (only their roots are looked at).

use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use super::safe_read::{read_hermes_file, redact_str};
use crate::js::{digest, truthy};

#[derive(Serialize, Clone, Debug)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub transport: &'static str,
    pub connection: &'static str,
}

/// Mirrors the installed Hermes `_parse_boolish`; absent or unparseable means enabled.
fn enabled(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !["false", "0", "no", "off"].contains(&s.trim().to_lowercase().as_str()),
        _ => true,
    }
}

/// The opaque id of one MCP server of one profile.
pub fn mcp_id(profile_id: &str, name: &str) -> String {
    format!("mcp-{}", digest(&format!("{profile_id}:{name}")))
}

pub fn mcp_metadata(profile_id: &str, config: &Map<String, Value>) -> Vec<McpServer> {
    let Some(Value::Object(servers)) = config.get("mcp_servers") else { return vec![] };
    servers
        .iter()
        .take(100)
        .filter_map(|(name, value)| {
            let server = value.as_object()?;
            let transport = if truthy(server.get("url")) {
                "http"
            } else if truthy(server.get("command")) {
                "stdio"
            } else {
                "unknown"
            };
            Some(McpServer { id: mcp_id(profile_id, name), name: redact_str(name, 100), enabled: enabled(server.get("enabled")), transport, connection: "unverified" })
        })
        .collect()
}

pub fn obsidian_registry_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("AGORA_OBSIDIAN_REGISTRY")
        && !path.is_empty()
    {
        return Some(PathBuf::from(path));
    }
    let home = crate::platform::home_dir()?;
    if cfg!(target_os = "macos") {
        return Some(home.join("Library/Application Support/obsidian/obsidian.json"));
    }
    if cfg!(windows) {
        let appdata = std::env::var_os("APPDATA").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join("AppData/Roaming"));
        return Some(appdata.join("obsidian/obsidian.json"));
    }
    let config = std::env::var("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|_| home.join(".config"));
    Some(config.join("obsidian/obsidian.json"))
}

#[derive(Serialize, Clone, Debug)]
pub struct Vault {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub source: &'static str,
}

pub struct Vaults {
    pub vaults: Vec<Vault>,
    pub warnings: Vec<String>,
}

pub fn obsidian_vaults(registry: Option<&Path>) -> Vaults {
    let Some(registry) = registry else { return Vaults { vaults: vec![], warnings: vec![] } };
    match read_vaults(registry) {
        Ok(vaults) => Vaults { vaults, warnings: vec![] },
        Err(error) => {
            let missing = error.downcast_ref::<std::io::Error>().is_some_and(|e| e.kind() == ErrorKind::NotFound);
            let warnings = if missing { vec![] } else { vec!["No se pudo leer el registro de Obsidian; no se han explorado carpetas alternativas.".into()] };
            Vaults { vaults: vec![], warnings }
        }
    }
}

fn read_vaults(registry: &Path) -> anyhow::Result<Vec<Vault>> {
    let root = crate::platform::canonicalize(registry.parent().unwrap_or(Path::new("/")))?;
    let name = registry.file_name().ok_or_else(|| anyhow::anyhow!("Invalid registry"))?;
    let data: Value = serde_json::from_slice(&read_hermes_file(&root, &root.join(name), 128 * 1024)?)?;
    let Some(Value::Object(entries)) = data.get("vaults") else { anyhow::bail!("Invalid registry") };
    let mut seen = HashSet::new();
    let mut vaults = Vec::new();
    for value in entries.values().take(100) {
        let Some(path) = value.get("path").and_then(Value::as_str) else { continue };
        if !Path::new(path).is_absolute() || !seen.insert(path.to_string()) {
            continue;
        }
        // Only stat the root; do not enumerate or read notes, attachments or .obsidian.
        let available = fs::metadata(path).map(|meta| meta.is_dir()).unwrap_or(false);
        let base = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        vaults.push(Vault { id: format!("vault-{}", digest(path)), name: redact_str(&base, 100), available, source: "obsidian-registry" });
    }
    Ok(vaults)
}
