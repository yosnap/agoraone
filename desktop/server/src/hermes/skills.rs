//! The real skills of a Hermes profile (its home's skills/ folder), browsed, edited and created from the
//! profile's sheet (user's decision, 20/10/2026). Listing and reading are local and never reach the model;
//! edits and creates are revision-checked, backed up first and written atomically by the same isolated
//! Python writer as the identity files.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::catalog::{HermesDiscovery, file_revision};
use super::profile_editor::write_file;
use super::python::system_python;
use super::safe_read::{decode_utf8, read_hermes_file, redact, redact_str, yaml_to_json};
use crate::js::spanish_key;
use crate::secret_lines::{CONTROLS, mask_secrets, restore_secrets};
use crate::security::Failure;

pub static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9_-]{0,63}$").unwrap());
static FRONTMATTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^---\r?\n((?s:.*?))\r?\n---(?:\r?\n|$)").unwrap());
const EXCLUDED: [&str; 15] = [
    "node_modules", ".venv", "venv", "site-packages", "__pycache__", ".git", ".hub", ".archive", ".curator_backups", ".locks", ".tox", ".nox", ".pytest_cache",
    ".mypy_cache", ".ruff_cache",
];
/// Frontmatter is read from the start of the file.
const LIST_BYTES: u64 = 32 * 1024;
/// Full size AgoraOne reads back, same as the identity files.
const MAX_BYTES: u64 = 64 * 1024;
const MAX_SKILLS: usize = 300;

fn conflict() -> Failure {
    Failure::new(409, "La skill cambió en Hermes mientras la editabas. Vuelve a cargarla para ver la versión actual.")
}

fn generic(error: anyhow::Error) -> Failure {
    error.downcast::<Failure>().unwrap_or_else(|_| Failure::new(500, "No se pudo completar la operación con la skill."))
}

struct Found {
    path: PathBuf,
    category: String,
    name: String,
    bytes: u64,
}

fn real_dir(path: &Path) -> bool {
    crate::platform::is_real_dir(path)
}

/// Visible, not excluded, real subfolders, in Spanish order.
fn folders(directory: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(directory) else { return vec![] };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| !crate::platform::dir_entry_is_link(e) && e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.') && !EXCLUDED.contains(&n.as_str()))
        .collect();
    names.sort_by(|a, b| spanish_key(a).cmp(&spanish_key(b)).then_with(|| a.cmp(b)));
    names.into_iter().filter(|n| real_dir(&directory.join(n))).collect()
}

/// The SKILL.md files under the profile's skills/ folder, two levels deep: category/skill or skill.
fn scan_skills(home: &Path) -> Vec<Found> {
    let root = home.join("skills");
    if !root.exists() || !real_dir(&root) {
        return vec![];
    }
    let mut found = Vec::new();
    let mut take = |directory: &Path, category: &str, name: &str| {
        let file = directory.join("SKILL.md");
        if let Ok(info) = crate::platform::inspect_path_nofollow(&file)
            && info.is_file
            && info.nlink <= 1
        {
            found.push(Found { path: file, category: category.into(), name: name.into(), bytes: info.len });
        }
    };
    for entry in folders(&root) {
        let directory = root.join(&entry);
        take(&directory, "", &entry);
        for inner in folders(&directory) {
            take(&directory.join(&inner), &entry, &inner);
        }
    }
    found
}

fn frontmatter(text: &str) -> Map<String, Value> {
    let Some(block) = FRONTMATTER.captures(text) else { return Map::new() };
    match serde_norway::from_str::<serde_norway::Value>(&block[1]).map(yaml_to_json) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct Skill {
    pub id: String,
    pub relative: String,
    pub name: String,
    pub category: String,
    pub bytes: u64,
    pub readable: bool,
    pub description: String,
}

#[derive(Serialize, Debug)]
pub struct Listing {
    pub skills: Vec<Skill>,
    pub truncated: bool,
}

/// Names of the profile's skills with their frontmatter description; opaque ids, no absolute paths.
pub fn list_profile_skills(discovery: &HermesDiscovery, profile_id: &str) -> anyhow::Result<Listing> {
    let (root, home, _) = discovery.skill_home(profile_id)?;
    let found = scan_skills(&home);
    let truncated = found.len() > MAX_SKILLS;
    let skills = found
        .into_iter()
        .take(MAX_SKILLS)
        .map(|item| {
            let text = read_hermes_file(&root, &item.path, LIST_BYTES).ok().and_then(decode_utf8).unwrap_or_default();
            let meta = frontmatter(&text);
            let name = match meta.get("name").and_then(Value::as_str) {
                Some(name) if !name.trim().is_empty() => redact_str(name, 100),
                _ => item.name.clone(),
            };
            let category = if item.category.is_empty() { String::new() } else { format!("{}/", item.category) };
            let relative = format!("skills/{category}{}/SKILL.md", item.name);
            Skill {
                id: format!("skill-{}", file_revision(&format!("{}:{relative}", root.display()))),
                relative,
                name,
                category: item.category,
                bytes: item.bytes,
                readable: item.bytes <= MAX_BYTES,
                description: redact(meta.get("description").filter(|d| d.is_string()), 300),
            }
        })
        .collect();
    Ok(Listing { skills, truncated })
}

struct Resolved {
    root: PathBuf,
    path: PathBuf,
    name: String,
    category: String,
}

fn resolve(discovery: &HermesDiscovery, profile_id: &str, skill_id: &str) -> Result<Resolved, Failure> {
    let listing = list_profile_skills(discovery, profile_id).map_err(generic)?;
    let item = listing.skills.into_iter().find(|s| s.id == skill_id).ok_or_else(|| Failure::new(404, "Skill no disponible."))?;
    let (root, home, _) = discovery.skill_home(profile_id).map_err(generic)?;
    Ok(Resolved { path: home.join(&item.relative), root, name: item.name, category: item.category })
}

pub fn read_profile_skill(discovery: &HermesDiscovery, profile_id: &str, skill_id: &str, reveal: bool) -> Result<Value, Failure> {
    let target = resolve(discovery, profile_id, skill_id)?;
    let data = read_hermes_file(&target.root, &target.path, MAX_BYTES)
        .map_err(|_| Failure::new(404, "Skill no disponible: puede ser demasiado grande o haber cambiado."))?;
    let bytes = data.len();
    let content = decode_utf8(data).ok_or_else(|| generic(anyhow::anyhow!("Invalid text")))?;
    let masked = mask_secrets(&content);
    let hidden_chars = if reveal { 0 } else { content.chars().count().saturating_sub(masked.text.chars().count()) };
    Ok(json!({
        "id": skill_id, "name": target.name, "category": target.category, "bytes": bytes, "readable": true,
        "revision": file_revision(&content), "content": if reveal { content.clone() } else { masked.text },
        "hidden": masked.hidden.len(), "hiddenChars": hidden_chars,
    }))
}

async fn write(request: Value) -> Value {
    match system_python() {
        Some(python) => write_file(&python, request).await,
        None => json!({ "ok": false, "error": "write_failed" }),
    }
}

pub struct SkillEdit {
    pub content: String,
    pub revision: String,
    pub revealed: bool,
}

pub async fn save_profile_skill(discovery: &HermesDiscovery, backups: &Path, profile_id: &str, skill_id: &str, edit: SkillEdit) -> Result<Value, Failure> {
    let target = resolve(discovery, profile_id, skill_id)?;
    let current = read_hermes_file(&target.root, &target.path, MAX_BYTES).ok().and_then(decode_utf8).ok_or_else(|| generic(anyhow::anyhow!("Unavailable")))?;
    if file_revision(&current) != edit.revision {
        return Err(conflict());
    }
    if CONTROLS.is_match(&edit.content) {
        return Err(Failure::new(400, "El texto contiene caracteres de control."));
    }
    let restored = if edit.revealed { edit.content } else { restore_secrets(&edit.content, &mask_secrets(&current).hidden).map_err(|e| Failure::new(400, e.to_string()))? };
    if restored.len() as u64 > MAX_BYTES {
        return Err(Failure::new(400, "La skill supera 64 KiB."));
    }
    let request = json!({
        "root": target.root, "path": target.path, "content": restored, "expected": edit.revision,
        "backupDir": backups.join(profile_id).join("skills").join(&target.name), "lock": false, "createParent": false,
    });
    let result = write(request).await;
    match result.get("error").and_then(Value::as_str) {
        Some("conflict") => return Err(conflict()),
        Some("unsafe") => {
            return Err(Failure::new(400, "No se puede guardar: la skill o su carpeta no son archivos normales del perfil (enlace simbólico o enlace duro)."));
        }
        _ => {}
    }
    match (result.get("ok"), result.get("revision").and_then(Value::as_str)) {
        (Some(Value::Bool(true)), Some(revision)) => Ok(json!({ "revision": revision, "backup": result.get("backup").cloned().unwrap_or(Value::Null) })),
        _ => Err(Failure::new(500, "No se pudo guardar la skill en Hermes.")),
    }
}

pub struct NewSkill {
    pub category: String,
    pub name: String,
    pub description: String,
    pub body: String,
}

pub async fn create_profile_skill(discovery: &HermesDiscovery, backups: &Path, profile_id: &str, skill: NewSkill) -> Result<Value, Failure> {
    if !NAME.is_match(&skill.category) || !NAME.is_match(&skill.name) {
        return Err(Failure::new(400, "Categoría y nombre: 1 a 64 caracteres, empezando por letra o número, sin espacios."));
    }
    let (root, home, _) = discovery.skill_home(profile_id).map_err(generic)?;
    let skills_root = home.join("skills");
    for directory in [skills_root.join(&skill.category), skills_root.join(&skill.category).join(&skill.name)] {
        if directory.exists() {
            if !real_dir(&directory) {
                return Err(Failure::new(400, "No se puede crear: el camino lleva una carpeta no normal (enlace simbólico o enlace duro)."));
            }
        } else {
            crate::platform::create_dir_mode(&directory, false, 0o700).map_err(|e| generic(e.into()))?;
        }
    }
    let path = skills_root.join(&skill.category).join(&skill.name).join("SKILL.md");
    if path.exists() {
        return Err(Failure::new(409, "Ya existe una skill con ese nombre en esa categoría."));
    }
    if CONTROLS.is_match(&skill.body) {
        return Err(Failure::new(400, "El texto contiene caracteres de control."));
    }
    let description = skill.description.replace('\\', "\\\\").replace('"', "\\\"").replace(['\r', '\n'], " ");
    let content = format!("---\nname: {}\ndescription: \"{description}\"\n---\n\n{}", skill.name, skill.body);
    if content.len() as u64 > MAX_BYTES {
        return Err(Failure::new(400, "La skill supera 64 KiB."));
    }
    let request = json!({
        "root": root, "path": path, "content": content, "expected": null,
        "backupDir": backups.join(profile_id).join("skills").join(&skill.name), "lock": false, "createParent": false,
    });
    let result = write(request).await;
    if result.get("error").and_then(Value::as_str) == Some("unsafe") {
        return Err(Failure::new(400, "No se puede crear: el camino no es una carpeta normal del perfil."));
    }
    if result.get("ok") != Some(&Value::Bool(true)) || !result.get("revision").is_some_and(Value::is_string) {
        return Err(Failure::new(500, "No se pudo crear la skill en Hermes."));
    }
    let id = file_revision(&format!("{}:skills/{}/{}/SKILL.md", root.display(), skill.category, skill.name));
    Ok(json!({ "id": format!("skill-{id}"), "name": skill.name, "category": skill.category }))
}
