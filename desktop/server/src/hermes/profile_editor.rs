//! Edits the real identity files of a Hermes profile, so AgoraOne, Telegram and Desktop share them. The user
//! edits the masked text; hidden credential-like lines are put back from disk, the edit is rejected if the
//! file changed meanwhile, and the previous version is backed up before replacing it.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};

use super::catalog::{HermesDiscovery, file_revision};
use super::python::{PROFILE_WRITER, run_python, system_python, user_path};
use super::safe_read::{decode_utf8, read_hermes_file};
use crate::js::now_iso;
use crate::secret_lines::{CONTROLS, mask_secrets, restore_secrets};
use crate::security::Failure;

/// Hermes' separator between MEMORY.md / USER.md entries.
pub const ENTRY_DELIMITER: &str = "\n§\n";
/// The most AgoraOne reads back from one identity file.
pub const MAX_BYTES: usize = 64 * 1024;

pub struct ProfileEdit {
    pub content: Option<String>,
    pub entries: Option<Vec<String>>,
    pub revision: Option<String>,
    pub revealed: bool,
}

fn conflict() -> Failure {
    Failure::new(409, "El archivo cambió en Hermes mientras lo editabas. Vuelve a cargarlo para ver la versión actual.")
}

/// Same rule as Hermes' memory tool: trimmed, non-empty, first occurrence wins.
pub fn memory_entries(text: &str) -> Vec<String> {
    let mut seen = Vec::new();
    for entry in text.split(ENTRY_DELIMITER).map(str::trim).filter(|e| !e.is_empty()) {
        if !seen.iter().any(|s: &String| s == entry) {
            seen.push(entry.to_string());
        }
    }
    seen
}

/// What the writer answered: `{ok, revision, backup}` or `{ok: false, error}`.
pub async fn write_file(python: &Path, request: Value) -> Value {
    run_python(python, PROFILE_WRITER, &[("PATH", user_path())], &request, Duration::from_secs(15), false).await.unwrap_or_else(|_| json!({ "ok": false }))
}

pub async fn save_profile_file(discovery: &HermesDiscovery, backups: &Path, id: &str, name: &str, edit: ProfileEdit) -> Result<Value, Failure> {
    let target = discovery.edit_target(id, name).map_err(|_| Failure::new(404, "Perfil no disponible."))?;
    let current = if target.path.exists() {
        let data = read_hermes_file(&target.root, &target.path, MAX_BYTES as u64).ok().and_then(decode_utf8);
        Some(data.ok_or_else(|| Failure::new(400, "No se puede editar: el archivo actual no es legible o supera 64 KiB."))?)
    } else {
        None
    };
    if current.as_deref().map(file_revision) != edit.revision {
        return Err(conflict());
    }
    let memory = target.limit.is_some();
    let text = if memory { edit.entries.map(|e| e.join(ENTRY_DELIMITER)) } else { edit.content };
    let text = text.ok_or_else(|| Failure::new(400, "Contenido no válido."))?;
    if CONTROLS.is_match(&text) {
        return Err(Failure::new(400, "El texto contiene caracteres de control."));
    }
    // Text edited with hidden lines shown is already complete: nothing to restore, and a literal marker stays literal.
    let restored = if edit.revealed {
        text
    } else {
        let hidden = current.as_deref().map(|c| mask_secrets(c).hidden).unwrap_or_default();
        restore_secrets(&text, &hidden).map_err(|e| Failure::new(400, e.to_string()))?
    };
    let content = if memory { memory_entries(&restored).join(ENTRY_DELIMITER) } else { restored };
    if let Some(limit) = target.limit
        && content.chars().count() as u64 > limit
    {
        return Err(Failure::new(400, format!("Supera el límite de Hermes para este archivo ({limit} caracteres).")));
    }
    if content.len() > MAX_BYTES {
        return Err(Failure::new(400, "El archivo supera 64 KiB."));
    }
    let python = Some(target.python.clone()).filter(|p| p.exists()).or_else(system_python).ok_or_else(|| {
        Failure::new(500, "No se encontró Python para guardar en Hermes. Instala Python 3 o revisa la instalación de Hermes.")
    })?;
    let request = json!({
        "root": target.root, "path": target.path, "content": content, "expected": edit.revision,
        "backupDir": backups.join(id), "lock": memory, "createParent": memory,
    });
    let result = write_file(&python, request).await;
    match result.get("error").and_then(Value::as_str) {
        Some("conflict") => return Err(conflict()),
        Some("unsafe") => {
            return Err(Failure::new(400, "No se puede editar: el archivo o su carpeta no son archivos normales del perfil (enlace simbólico o enlace duro)."));
        }
        _ => {}
    }
    match (result.get("ok"), result.get("revision").and_then(Value::as_str)) {
        (Some(Value::Bool(true)), Some(revision)) => Ok(json!({ "revision": revision, "backup": result.get("backup").cloned().unwrap_or(Value::Null) })),
        _ => Err(Failure::new(500, "No se pudo guardar el archivo en Hermes.")),
    }
}

/// Before a profile's own agent runs (its memory tool may write MEMORY.md / USER.md once the user allows
/// it), keeps a copy of each memory file in the editor's backup folder, only when it changed since the last
/// copy. Up to 20 copies per file. Failures never block the turn.
pub fn backup_memories(discovery: &HermesDiscovery, backups: &Path, id: &str) {
    for name in ["MEMORY.md", "USER.md"] {
        let _ = backup_one(discovery, backups, id, name);
    }
}

fn backup_one(discovery: &HermesDiscovery, backups: &Path, id: &str, name: &str) -> anyhow::Result<()> {
    let target = discovery.edit_target(id, name)?;
    if !target.path.exists() {
        return Ok(());
    }
    let content = read_hermes_file(&target.root, &target.path, MAX_BYTES as u64)?;
    let folder = backups.join(id);
    crate::platform::create_dir_mode(&folder, true, 0o700)?;
    let mut copies: Vec<String> = fs::read_dir(&folder)?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|f| f.starts_with(&format!("{name}.")) && f.ends_with(".bak"))
        .collect();
    copies.sort();
    if let Some(latest) = copies.last()
        && fs::read(folder.join(latest))? == content
    {
        return Ok(());
    }
    let stamp = now_iso().replace(['-', ':'], "");
    let file = format!("{name}.{stamp}-turno.bak");
    crate::platform::create_mode_file(&folder.join(&file), true, false, 0o600)?.write_all(&content)?;
    copies.push(file);
    copies.sort();
    let excess = copies.len().saturating_sub(20);
    for old in &copies[..excess] {
        fs::remove_file(folder.join(old))?;
    }
    Ok(())
}
