//! The catalog of Hermes profiles and declared spaces, read from Hermes' data folder (never its code), with
//! identity files masked line by line. Clients only ever name opaque ids; paths are resolved here against a
//! fresh scan, so removing or tombstoning a profile revokes access at once.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::database::read_hermes_database;
use super::location::HermesLocation;
use super::mcp_tools::{McpTools, read_mcp_tools};
use super::resources::{McpServer, mcp_id, mcp_metadata};
use super::safe_read::{decode_utf8, read_hermes_file, read_metadata, redact, redact_str};
use crate::js::{digest, get, js_string, now_iso, or, slice_utf16, truthy};
use crate::secret_lines::{is_hidden_marker, mask_secrets, reveal_secrets};

const MARKERS: [&str; 6] = ["config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db"];
const COLORS: [&str; 5] = ["#81b8cf", "#aa9be0", "#8dbb98", "#d98f75", "#e7bd6a"];
pub const IDENTITY_FILES: [&str; 3] = ["SOUL.md", "MEMORY.md", "USER.md"];
static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9_-]{0,63}$").unwrap());
static COLOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^#[0-9a-f]{6}$").unwrap());
static PLATFORM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9_-]{1,64}$").unwrap());
static VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?m)^version\s*=\s*["']([^"']+)"#).unwrap());
static HEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^#\s+(.+)$").unwrap());
static HEADINGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^#+\s+.*$").unwrap());

/// The name in a SOUL.md heading used as the main profile's label when Hermes has no display name:
/// «SOUL.md — Sn4p · Perfil principal de Hermes» reads «Sn4p»; any other heading stays as written.
pub fn soul_name(heading: &str) -> String {
    let Some(rest) = heading.strip_prefix("SOUL.md").or_else(|| heading.strip_prefix("Soul.md")) else { return heading.to_string() };
    let rest = rest.trim_start_matches(|c: char| c.is_whitespace() || matches!(c, '—' | '–' | '-' | ':' | '·' | '|'));
    let name = rest.split([' ', '\u{a0}']).collect::<Vec<_>>().join(" ");
    let cut = [" · ", " — ", " – ", " - ", " | "].iter().filter_map(|sep| name.find(sep)).min().unwrap_or(name.len());
    let name = name[..cut].trim().to_string();
    if name.is_empty() { heading.to_string() } else { name }
}
static EMPHASIS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[*_`]").unwrap());

/// Revision of an identity file; the profile editor and its Python writer compute the same value.
pub fn file_revision(text: &str) -> String {
    digest(text)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HermesFile {
    pub name: &'static str,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_chars: Option<usize>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Channel {
    pub name: String,
    pub enabled: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HermesProfile {
    pub id: String,
    pub name: String,
    pub label: String,
    pub description: String,
    pub description_source: String,
    pub color: String,
    pub active: bool,
    pub files: Vec<HermesFile>,
    pub agent_id: String,
    pub mcp: Vec<McpServer>,
    pub bot_id: Option<String>,
    pub bot_label: Option<String>,
    pub section: Option<String>,
    pub channels: Vec<Channel>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HermesSpace {
    pub id: String,
    pub label: String,
    pub profile_ids: Vec<String>,
    pub source: String,
    pub description: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Installation {
    pub detected: bool,
    pub version: Option<String>,
    pub source: String,
    pub compatibility: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HermesCatalog {
    pub schema: u8,
    pub state: &'static str,
    pub scanned_at: String,
    pub installation: Installation,
    pub profiles: Vec<HermesProfile>,
    pub spaces: Vec<HermesSpace>,
    pub warnings: Vec<String>,
}

/// A profile's folder, for reading its activity.
#[derive(Clone, Debug)]
pub struct ProfileTarget {
    pub id: String,
    pub name: String,
    pub home: PathBuf,
    pub mcp: Vec<String>,
}

/// One identity file of a profile, for the editor.
pub struct EditTarget {
    pub root: PathBuf,
    pub path: PathBuf,
    /// Hermes' character limit (memory files only).
    pub limit: Option<u64>,
    pub python: PathBuf,
}

/// One MCP server of a profile, resolved from an opaque id.
pub struct McpTarget {
    pub root: PathBuf,
    pub home: PathBuf,
    pub profile: String,
    pub server: String,
    pub config: Map<String, Value>,
}

pub struct HermesDiscovery {
    location: HermesLocation,
    cached: Mutex<Option<(Instant, HermesCatalog)>>,
}

fn unknown(what: &str) -> anyhow::Error {
    anyhow::anyhow!("Unknown {what}")
}

impl HermesDiscovery {
    pub fn new(location: HermesLocation) -> Self {
        Self { location, cached: Mutex::new(None) }
    }

    pub fn location(&self) -> &HermesLocation {
        &self.location
    }

    fn root(&self) -> std::io::Result<PathBuf> {
        crate::platform::canonicalize(&self.location.root)
    }

    fn profile_home(&self, root: &Path, name: &str) -> anyhow::Result<PathBuf> {
        if name != "default" && !NAME.is_match(name) {
            return Err(unknown("profile"));
        }
        let home = if name == "default" { root.to_path_buf() } else { root.join("profiles").join(name) };
        if !crate::platform::is_real_dir(&home) {
            return Err(unknown("profile"));
        }
        if name != "default" && root.join("profiles/.deleted").join(name).exists() {
            anyhow::bail!("Deleted profile");
        }
        if !MARKERS.iter().any(|marker| home.join(marker).exists()) {
            return Err(unknown("profile"));
        }
        Ok(home)
    }

    /// Content is masked line by line unless the user explicitly asks to reveal it; the model only ever
    /// gets the masked text.
    fn files(&self, root: &Path, home: &Path, with_content: bool, reveal: bool) -> Vec<HermesFile> {
        IDENTITY_FILES
            .iter()
            .map(|&name| {
                let file = if name == "SOUL.md" { home.join(name) } else { home.join("memories").join(name) };
                let blank = HermesFile { name, state: "", bytes: None, revision: None, content: None, hidden: None, hidden_chars: None };
                let read = read_hermes_file(root, &file, 65536).ok().and_then(decode_utf8);
                let Some(content) = read else {
                    return HermesFile { state: if file.exists() || fs::symlink_metadata(&file).is_ok() { "unavailable" } else { "missing" }, ..blank };
                };
                let base = HermesFile { state: "available", bytes: Some(content.len()), revision: Some(file_revision(&content)), ..blank };
                if !with_content {
                    return base;
                }
                let masked = mask_secrets(&content);
                // How many more characters the hidden lines take than their markers, so the editor counts like Hermes.
                let hidden_chars = if reveal { 0 } else { content.chars().count().saturating_sub(masked.text.chars().count()) };
                HermesFile {
                    content: Some(if reveal { reveal_secrets(&content) } else { masked.text }),
                    hidden: Some(masked.hidden.len()),
                    hidden_chars: Some(hidden_chars),
                    ..base
                }
            })
            .collect()
    }

    fn find(&self, id: &str) -> anyhow::Result<(PathBuf, HermesProfile, PathBuf)> {
        let root = self.root()?;
        // Resolve against a fresh registry; removal or tombstoning revokes access immediately.
        let profile = self.scan(true).profiles.into_iter().find(|p| p.id == id).ok_or_else(|| unknown("profile"))?;
        let home = self.profile_home(&root, &profile.name)?;
        Ok((root, profile, home))
    }

    pub fn detail(&self, id: &str, reveal: bool) -> anyhow::Result<Value> {
        let (root, profile, home) = self.find(id)?;
        let (memory, user) = self.memory_limits(&root, &home);
        Ok(json!({ "profile": profile, "files": self.files(&root, &home, true, reveal), "limits": { "MEMORY.md": memory, "USER.md": user } }))
    }

    /// Hermes' own caps for MEMORY.md and USER.md (memory.*_char_limit in the profile's config.yaml).
    pub fn memory_limits(&self, root: &Path, home: &Path) -> (u64, u64) {
        let config = read_metadata(root, &home.join("config.yaml")).unwrap_or_default();
        let memory = config.get("memory");
        let limit = |key: &str, fallback: u64| get(memory, key).and_then(|v| crate::js::integer(Some(v))).filter(|v| *v > 0).map(|v| v as u64).unwrap_or(fallback);
        (limit("memory_char_limit", 2200), limit("user_char_limit", 1375))
    }

    /// Where one identity file of a profile lives, for the editor. The client only names the profile id and
    /// the file.
    pub fn edit_target(&self, id: &str, name: &str) -> anyhow::Result<EditTarget> {
        let (root, _, home) = self.find(id)?;
        let path = if name == "SOUL.md" { home.join(name) } else { home.join("memories").join(name) };
        let limit = match name {
            "SOUL.md" => None,
            "MEMORY.md" => Some(self.memory_limits(&root, &home).0),
            _ => Some(self.memory_limits(&root, &home).1),
        };
        Ok(EditTarget { root, path, limit, python: self.location.python.clone() })
    }

    /// Where a profile's skills live, for the skills sheet. The client only names the profile id.
    pub fn skill_home(&self, id: &str) -> anyhow::Result<(PathBuf, PathBuf, String)> {
        let (root, profile, home) = self.find(id)?;
        Ok((root, home, profile.name))
    }

    /// Where to read activity from. Profiles come from the catalog; the client never names a path.
    pub fn activity_targets(&self) -> anyhow::Result<(PathBuf, Vec<ProfileTarget>)> {
        let root = self.root()?;
        let profiles = self
            .scan(false)
            .profiles
            .into_iter()
            .filter_map(|p| {
                let home = self.profile_home(&root, &p.name).ok()?;
                Some(ProfileTarget { id: p.id, name: p.name, home, mcp: p.mcp.into_iter().map(|s| s.name).collect() })
            })
            .collect();
        Ok((root, profiles))
    }

    pub fn mcp_tools(&self, profile_id: &str, server_id: &str) -> anyhow::Result<McpTools> {
        let target = self.mcp_server(profile_id, server_id)?;
        Ok(read_mcp_tools(&target.root, &target.home, &target.server, &target.config))
    }

    /// The profile and server an opaque MCP id names, resolved against fresh config; never a path or name
    /// from the client.
    pub fn mcp_server(&self, profile_id: &str, server_id: &str) -> anyhow::Result<McpTarget> {
        let (root, profile, home) = self.find(profile_id)?;
        let config = read_metadata(&root, &home.join("config.yaml"))?;
        if let Some(Value::Object(servers)) = config.get("mcp_servers") {
            for (name, value) in servers {
                if let Value::Object(server) = value
                    && mcp_id(profile_id, name) == server_id
                {
                    return Ok(McpTarget { root, home, profile: profile.name, server: name.clone(), config: server.clone() });
                }
            }
        }
        Err(unknown("MCP"))
    }

    pub fn scan(&self, force: bool) -> HermesCatalog {
        let mut cached = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        if !force
            && let Some((at, catalog)) = cached.as_ref()
            && at.elapsed() < Duration::from_secs(20)
        {
            return catalog.clone();
        }
        let catalog = self.read_catalog();
        *cached = Some((Instant::now(), catalog.clone()));
        catalog
    }

    fn read_catalog(&self) -> HermesCatalog {
        let mut result = HermesCatalog {
            schema: 1,
            state: "missing",
            scanned_at: now_iso(),
            installation: Installation {
                detected: false,
                version: None,
                source: self.location.source.clone(),
                compatibility: "Lectura por capacidades; conversación aislada sujeta al contrato verificado de AIAgent, sin herramientas.".into(),
            },
            profiles: vec![],
            spaces: vec![],
            warnings: vec![],
        };
        let Ok(root) = self.root() else {
            result.warnings.push("No se encuentra el directorio de datos de Hermes. Configura AGORA_HERMES_HOME si está en otra ubicación.".into());
            return result;
        };
        let version = crate::platform::canonicalize(&self.location.installation).and_then(|installation| {
            result.installation.detected = installation.join("run_agent.py").exists();
            read_hermes_file(&installation, &installation.join("pyproject.toml"), 131072)
        });
        match version {
            Ok(data) => result.installation.version = VERSION.captures(&String::from_utf8_lossy(&data)).map(|c| c[1].to_string()),
            Err(_) => result.warnings.push("No se pudo comprobar la versión del código instalado; se muestran solo estructuras reconocidas.".into()),
        }
        let active = read_hermes_file(&root, &root.join("active_profile"), 256).map(|d| String::from_utf8_lossy(&d).trim().to_string()).unwrap_or_else(|_| "default".into());
        let mut names = vec!["default".to_string()];
        if let Ok(entries) = fs::read_dir(root.join("profiles")) {
            let mut found: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n != "default" && NAME.is_match(n)).collect();
            found.sort();
            names.extend(found);
        }
        if names.len() > 100 {
            result.warnings.push("Se muestran los primeros 100 perfiles.".into());
        }
        let mut spaces: Vec<(String, HermesSpace)> = Vec::new();
        for name in names.iter().take(100) {
            let Ok(home) = self.profile_home(&root, name) else { continue };
            let id = format!("profile-{}", digest(&format!("{}:{name}", root.display())));
            let (mut meta, mut config) = (Map::new(), Map::new());
            for (file, is_meta) in [("profile.yaml", true), ("config.yaml", false)] {
                if !home.join(file).exists() {
                    continue;
                }
                match read_metadata(&root, &home.join(file)) {
                    Ok(value) if is_meta => meta = value,
                    Ok(value) => config = value,
                    Err(_) => result.warnings.push(format!("Metadatos no legibles en el perfil {name}.")),
                }
            }
            result.profiles.push(self.profile(&root, &home, name, &id, &active, &meta, &config));
            // Session cwd values are historical execution metadata, not current spaces.
            let file = home.join("projects.db");
            match read_hermes_database(&root, &file, "projects") {
                Ok(read) => {
                    if file.exists() && !read.supported {
                        result.warnings.push(format!("Esquema projects.db no reconocido en {name}."));
                    }
                    for row in read.rows {
                        add_space(&mut spaces, &root, &home, &id, &row);
                    }
                }
                Err(_) => result.warnings.push(format!("No se pudo leer projects.db de {name}; no se ha modificado.")),
            }
        }
        if spaces.len() > 300 {
            result.warnings.push("Se muestran los primeros 300 espacios registrados.".into());
        }
        result.spaces = spaces.into_iter().take(300).map(|(_, space)| space).collect();
        result.warnings.push("Perfiles encontrados en el directorio de datos local. No se ha verificado el listado actual de Desktop. Los bots solo se identifican por metadatos explícitos en profile.yaml.".into());
        result.state = if result.profiles.is_empty() {
            "missing"
        } else if result.warnings.is_empty() {
            "available"
        } else {
            "partial"
        };
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn profile(&self, root: &Path, home: &Path, name: &str, id: &str, active: &str, meta: &Map<String, Value>, config: &Map<String, Value>) -> HermesProfile {
        let meta_value = Value::Object(meta.clone());
        let bot = get(get(Some(&meta_value), "ui_meta"), "hermes-bots");
        let files = self.files(root, home, false, false);
        // The description shown without asking comes from SOUL with credential-like lines removed first.
        let soul = read_hermes_file(root, &home.join("SOUL.md"), 65536)
            .map(|data| {
                let masked = mask_secrets(&String::from_utf8_lossy(&data)).text;
                redact_str(&masked.split('\n').filter(|line| !is_hidden_marker(line)).collect::<Vec<_>>().join("\n"), 2000)
            })
            .unwrap_or_default();
        let heading = HEADING.captures(&soul).map(|c| soul_name(&slice_utf16(EMPHASIS.replace_all(&c[1], "").trim(), 100))).filter(|h| !h.is_empty());
        let declared = or(meta.get("description"), get(bot, "description"));
        let mut description = redact(declared, 700);
        if description.is_empty() {
            description = slice_utf16(HEADINGS.replace_all(&soul, "").trim(), 500);
        }
        let mut label = redact(or(meta.get("display_name"), get(bot, "title")), 100);
        if label.is_empty() {
            label = if name == "default" { heading.unwrap_or_else(|| "Hermes principal".into()) } else { name.into() };
        }
        let color = get(bot, "color").and_then(Value::as_str).filter(|c| COLOR.is_match(c)).map(str::to_string).unwrap_or_else(|| {
            let index = usize::from_str_radix(&digest(name)[..4], 16).unwrap_or(0) % COLORS.len();
            COLORS[index].into()
        });
        let has_bot = truthy(bot);
        let channels = match config.get("platforms") {
            Some(Value::Object(platforms)) => platforms
                .iter()
                .filter(|(platform, settings)| PLATFORM.is_match(platform) && settings.is_object())
                .take(30)
                .map(|(platform, settings)| Channel { name: platform.clone(), enabled: settings.get("enabled") == Some(&Value::Bool(true)) })
                .collect(),
            _ => vec![],
        };
        let section = redact(get(bot, "sectionName"), 100);
        let bot_title = redact(get(bot, "title"), 100);
        HermesProfile {
            id: id.into(),
            name: name.into(),
            description_source: if truthy(declared) {
                "profile.yaml"
            } else if !soul.is_empty() {
                "Extracto literal de SOUL.md"
            } else {
                "Sin descripción"
            }
            .into(),
            label: label.clone(),
            description,
            color,
            active: name == active,
            files,
            agent_id: format!("identity-{}", digest(id)),
            mcp: mcp_metadata(id, config),
            bot_id: has_bot.then(|| format!("desktop-bot-{}", digest(id))),
            bot_label: has_bot.then_some(if bot_title.is_empty() { label } else { bot_title }),
            section: (!section.is_empty()).then_some(section),
            channels,
        }
    }
}

fn add_space(spaces: &mut Vec<(String, HermesSpace)>, root: &Path, home: &Path, profile_id: &str, row: &Map<String, Value>) {
    let path = row.get("path").and_then(Value::as_str).map(str::trim).unwrap_or("");
    if Path::new(path) == root || Path::new(path) == home || path == "/" {
        return;
    }
    let key = if path.is_empty() { digest(&format!("{profile_id}:{}", js_string(row.get("id")))) } else { digest(&format!("{}:{path}", root.display())) };
    let source = row.get("source").and_then(Value::as_str).unwrap_or("").to_string();
    if let Some((_, existing)) = spaces.iter_mut().find(|(k, _)| *k == key) {
        if !existing.profile_ids.iter().any(|p| p == profile_id) {
            existing.profile_ids.push(profile_id.into());
        }
        if source == "project" && existing.source != "project" {
            existing.source = "project".into();
            let label = redact(row.get("label"), 100);
            if !label.is_empty() {
                existing.label = label;
            }
            existing.description = "Proyecto declarado en Hermes. Su contenido no se ha leído.".into();
        }
        return;
    }
    let mut label = redact(row.get("label"), 100);
    if label.is_empty() {
        label = redact_str(&Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), 100);
    }
    if label.is_empty() {
        label = "Proyecto sin carpeta".into();
    }
    let description = if source == "workspace" {
        "Carpeta registrada en sesiones de Hermes; actividad actual no comprobada."
    } else {
        "Recurso registrado por Hermes. Su contenido no se ha leído."
    };
    spaces.push((key.clone(), HermesSpace { id: format!("space-{key}"), label, profile_ids: vec![profile_id.into()], source, description: description.into() }));
}
