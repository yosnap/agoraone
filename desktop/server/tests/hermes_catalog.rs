//! Ported from server/hermes-catalog.test.ts, mcp-tools.test.ts and resource-discovery.test.ts.

#[path = "support/test_links.rs"]
mod test_links;

use std::fs;
use std::path::{Path, PathBuf};

use agora_server::hermes::catalog::HermesDiscovery;
use agora_server::hermes::location::{HermesLocation, hermes_location};
use agora_server::hermes::mcp_tools::{mcp_fingerprint, read_mcp_tools};
use agora_server::hermes::resources::{mcp_metadata, obsidian_vaults};
use agora_server::hermes::safe_read::redact_str;
use agora_server::platform::canonicalize;
use test_links::{create_test_link as symlink};
use rusqlite::Connection;
use serde_json::{Map, Value, json};

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    discovery: HermesDiscovery,
}

fn object(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

fn profile(root: &Path, name: &str) -> PathBuf {
    let home = if name == "default" { root.to_path_buf() } else { root.join("profiles").join(name) };
    fs::create_dir_all(home.join("memories")).unwrap();
    fs::write(home.join("SOUL.md"), "# Identidad de prueba\nAyudo con proyectos.\npasswd: CANARY_SOUL_SECRET").unwrap();
    fs::write(home.join("memories/MEMORY.md"), "Recuerdo de prueba\napi_key: CANARY_MEMORY_SECRET").unwrap();
    fs::write(home.join(".env"), "KEY=CANARY_ENV_SECRET").unwrap();
    home
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = canonicalize(dir.path()).unwrap();
    let installation = root.join("hermes-agent");
    fs::create_dir_all(&installation).unwrap();
    fs::write(installation.join("pyproject.toml"), "version = \"0.21.4\"").unwrap();
    fs::write(installation.join("run_agent.py"), "").unwrap();
    profile(&root, "default");
    let location = HermesLocation { root: root.clone(), installation, python: PathBuf::new(), source: "test".into() };
    Fixture { _dir: dir, root, discovery: HermesDiscovery::new(location) }
}

fn text(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap()
}

#[test]
fn catalog_lists_live_profiles_without_secrets() {
    let f = fixture();
    let home = profile(&f.root, "coder");
    fs::write(
        home.join("profile.yaml"),
        "display_name: Constructor\ndescription: Desarrollo local\nui_meta:\n  hermes-bots:\n    title: Mi bot\n    sectionName: Trabajo\n    color: \"#abcdef\"",
    )
    .unwrap();
    fs::write(home.join("config.yaml"), "api_key: CANARY_CONFIG_SECRET\nplatforms:\n  telegram:\n    enabled: true\n    token: CANARY_BOT_SECRET").unwrap();
    profile(&f.root, "deleted");
    fs::create_dir_all(f.root.join("profiles/.deleted")).unwrap();
    fs::write(f.root.join("profiles/.deleted/deleted"), "1").unwrap();
    fs::create_dir(f.root.join("profiles/ghost")).unwrap();
    symlink(&home, f.root.join("profiles/linked")).unwrap();
    let before = fs::read(home.join("config.yaml")).unwrap();
    let catalog = f.discovery.scan(false);
    assert_eq!(catalog.profiles.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["default", "coder"]);
    let coder = &catalog.profiles[1];
    assert_eq!(catalog.profiles[0].bot_id, None, "Código de Desktop instalado no acredita un bot registrado");
    assert_eq!(coder.label, "Constructor");
    assert_eq!(coder.bot_label.as_deref(), Some("Mi bot"));
    assert_eq!(coder.color, "#abcdef");
    assert_ne!(coder.id, coder.agent_id);
    assert_ne!(Some(&coder.id), coder.bot_id.as_ref());
    assert_eq!(text(&coder.channels), r#"[{"name":"telegram","enabled":true}]"#);
    assert!(!text(&catalog).contains("CANARY"));
    let detail = f.discovery.detail(&coder.id, false).unwrap();
    assert!(!text(&detail).contains("CANARY"));
    let memory = detail["files"].as_array().unwrap().iter().find(|file| file["name"] == "MEMORY.md").unwrap();
    assert!(memory["content"].as_str().unwrap().contains("Recuerdo de prueba"));
    assert_eq!(memory["hidden"], 1);
    assert!(memory["content"].as_str().unwrap().contains("[línea oculta 1]"));
    assert_eq!(detail["limits"], json!({ "MEMORY.md": 2200, "USER.md": 1375 }));
    // Only an explicit reveal returns the hidden line.
    assert!(text(&f.discovery.detail(&coder.id, true).unwrap()).contains("CANARY_MEMORY_SECRET"));
    assert_eq!(fs::read(home.join("config.yaml")).unwrap(), before);
    assert!(f.discovery.detail("../.env", false).is_err());
    fs::write(f.root.join("profiles/.deleted/coder"), "1").unwrap();
    assert!(f.discovery.detail(&coder.id, false).is_err());
    assert_eq!(f.discovery.scan(true).profiles.len(), 1);
}

#[test]
fn spaces_ignore_session_folders_and_show_declared_projects() {
    let f = fixture();
    let coder = profile(&f.root, "coder");
    for home in [f.root.clone(), coder.clone()] {
        let db = Connection::open(home.join("state.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE sessions(cwd TEXT, system_prompt TEXT); INSERT INTO sessions VALUES('/private/ficticio/proyecto', 'CANARY_PROMPT_SECRET'); INSERT INTO sessions VALUES('/tmp/od-conn-test-falso', 'CANARY_PROMPT_SECRET');",
        )
        .unwrap();
    }
    let db = Connection::open(coder.join("projects.db")).unwrap();
    db.execute_batch("CREATE TABLE projects(id TEXT, name TEXT, primary_path TEXT, archived INTEGER); INSERT INTO projects VALUES('p1','Proyecto declarado','/private/ficticio/proyecto',0); INSERT INTO projects VALUES('p2','Oculto','/private/oculto',1);").unwrap();
    drop(db);
    let catalog = f.discovery.scan(false);
    assert_eq!(catalog.spaces.len(), 1);
    assert_eq!(catalog.spaces[0].profile_ids.len(), 1);
    assert_eq!(catalog.spaces[0].source, "project");
    assert_eq!(catalog.spaces[0].label, "Proyecto declarado");
    assert!(!text(&catalog).contains("/private/"));
    assert!(!text(&catalog).contains("CANARY"));
}

#[test]
fn portable_location_missing_formats_and_rejected_links() {
    let none = |_: &str| None;
    assert_eq!(hermes_location(none, Path::new("/otro-usuario")).root, PathBuf::from("/otro-usuario/.hermes"));
    let hermes = |name: &str| (name == "HERMES_HOME").then(|| "/datos/profiles/coder".to_string());
    assert_eq!(hermes_location(hermes, Path::new("/otro")).root, PathBuf::from("/datos"));
    let agora = |name: &str| (name == "AGORA_HERMES_HOME").then(|| "/datos".to_string());
    assert_eq!(hermes_location(agora, Path::new("/otro")).root, PathBuf::from("/datos"));
    let f = fixture();
    fs::remove_file(f.root.join("SOUL.md")).unwrap();
    symlink(f.root.join(".env"), f.root.join("SOUL.md")).unwrap();
    Connection::open(f.root.join("state.db")).unwrap().execute_batch("CREATE TABLE unknown(id TEXT)").unwrap();
    let catalog = f.discovery.scan(false);
    assert_eq!(catalog.state, "partial");
    assert_eq!(catalog.profiles[0].files[0].state, "unavailable");
    assert!(!text(&catalog).contains("CANARY"));
    fs::remove_dir_all(&f.root).unwrap();
    assert_eq!(f.discovery.scan(true).state, "missing");
    assert!(!redact_str(&format!("{}-abcdef123456\npassword: foo", "sk"), 2000).contains("foo"));
}

#[test]
fn fingerprint_matches_python_json_with_unicode() {
    let config = object(json!({ "command": "python", "args": ["á", "😀"], "tools": { "include": ["z", "a"] } }));
    assert_eq!(mcp_fingerprint(&config), "aa460603bf3e61b9");
}

#[test]
fn cached_tools_per_profile_with_expiry_changes_and_private_fields_left_out() {
    let dir = tempfile::tempdir().unwrap();
    let root = canonicalize(dir.path()).unwrap();
    let config = object(json!({ "command": "test-only" }));
    fs::create_dir(root.join("cache")).unwrap();
    fs::create_dir(root.join("other")).unwrap();
    let cache = root.join("cache/mcp_schema_cache.json");
    let entry = json!({
        "fingerprint": mcp_fingerprint(&config),
        "tools": [{ "name": "find", "description": "Buscar notas\napi_key: CANARY", "inputSchema": { "properties": { "query": { "type": "string", "default": "CANARY" } }, "required": ["query"] }, "hidden": "CANARY" }],
        "utility_tools": [{ "hidden": "CANARY" }], "ttl_ms": 10, "written_at": 1,
    });
    fs::write(&cache, json!({ "demo": entry }).to_string()).unwrap();
    let result = read_mcp_tools(&root, &root, "demo", &config);
    assert_eq!(result.state, "expired");
    assert_eq!(result.tools[0].name, "find");
    assert_eq!(serde_json::to_value(&result.tools[0].parameters).unwrap(), json!([{ "name": "query", "type": "string", "required": true }]));
    assert!(!text(&result).contains("CANARY"));
    assert_eq!(read_mcp_tools(&root, &root.join("other"), "demo", &config).state, "missing");
    let changed = object(json!({ "command": "changed" }));
    assert_eq!(read_mcp_tools(&root, &root, "demo", &changed).state, "changed");
    assert!(read_mcp_tools(&root, &root, "demo", &changed).tools.is_empty());
    let mut fresh = entry.clone();
    fresh["ttl_ms"] = Value::Null;
    fresh["written_at"] = Value::Null;
    fs::write(&cache, json!({ "demo": fresh }).to_string()).unwrap();
    assert_eq!(read_mcp_tools(&root, &root, "demo", &config).state, "cached");
    fs::remove_file(&cache).unwrap();
    symlink(root.join("unreadable"), &cache).unwrap();
    assert!(read_mcp_tools(&root, &root, "demo", &config).tools.is_empty());
}

#[test]
fn mcp_metadata_only_allowed_fields_scoped_per_profile() {
    let config = object(json!({ "mcp_servers": {
        "sentry": { "url": "https://secret.test/?token=CANARY", "headers": { "Authorization": "CANARY" }, "env": { "API_KEY": "CANARY" }, "enabled": "off" },
        "local": { "command": "private-command", "args": ["CANARY"] },
        "zero": { "enabled": 0 }, "yes": { "enabled": "yes" }, "invalid": "CANARY",
    } }));
    let rows = mcp_metadata("a", &config);
    assert_eq!(rows.len(), 4);
    assert_eq!(rows.iter().map(|r| r.enabled).collect::<Vec<_>>(), [false, true, false, true]);
    assert_eq!(rows[0].transport, "http");
    assert_eq!(rows[1].transport, "stdio");
    assert!(rows.iter().all(|r| r.connection == "unverified"));
    assert_ne!(rows[0].id, mcp_metadata("b", &config)[0].id);
    let shown = text(&rows);
    for private in ["CANARY", "secret.test", "private-command", "Authorization", "API_KEY"] {
        assert!(!shown.contains(private), "{private}");
    }
    assert!(mcp_metadata("a", &object(json!({ "mcp_servers": [] }))).is_empty());
}

#[test]
fn obsidian_registry_bounded_without_notes_or_paths() {
    let dir = tempfile::tempdir().unwrap();
    let root = canonicalize(dir.path()).unwrap();
    let vault = root.join("Vault de prueba");
    fs::create_dir(&vault).unwrap();
    fs::write(vault.join("privado.md"), "CANARY_PRIVATE_NOTE").unwrap();
    let registry = root.join("obsidian.json");
    let data = json!({ "vaults": { "a": { "path": vault }, "b": { "path": root.join("disconnected") }, "duplicate": { "path": vault }, "invalid": { "path": "../relative" } }, "auth": "CANARY" });
    fs::write(&registry, data.to_string()).unwrap();
    let result = obsidian_vaults(Some(&registry));
    assert_eq!(result.vaults.len(), 2);
    assert_eq!(result.vaults[0].name, "Vault de prueba");
    assert!(result.vaults[0].available);
    assert!(!result.vaults[1].available);
    let shown = text(&result.vaults);
    assert!(!shown.contains(root.to_str().unwrap()) && !shown.contains("CANARY"));
    assert!(obsidian_vaults(None).vaults.is_empty());
    let linked = root.join("linked.json");
    symlink(&registry, &linked).unwrap();
    assert!(obsidian_vaults(Some(&linked)).vaults.is_empty());
    fs::write(&registry, "{invalid").unwrap();
    assert_eq!(obsidian_vaults(Some(&registry)).warnings.len(), 1);
    fs::write(&registry, " ".repeat(140 * 1024)).unwrap();
    assert!(obsidian_vaults(Some(&registry)).vaults.is_empty());
}

/// Hermes' own Python (November 2026): taken from tools/facts.json only for an installation with its
/// bootstrap, never through a link out of its tools; older installations keep their virtual environment.
#[test]
fn hermes_python_comes_from_its_tools() {
    let dir = tempfile::tempdir().unwrap();
    let home = canonicalize(dir.path()).unwrap();
    let root = home.join(".hermes");
    let installation = root.join("hermes-agent");
    std::fs::create_dir_all(&installation).unwrap();
    std::fs::write(installation.join("run_agent.py"), "").unwrap();
    let none = |_: &str| None::<String>;
    let old = hermes_location(none, &home).python;
    assert!(old.ends_with("bin/python") && old.starts_with(&installation), "without bootstrap, the virtual environment");
    std::fs::write(installation.join("hermes_bootstrap.py"), "").unwrap();
    let tools = root.join("tools");
    std::fs::create_dir_all(tools.join("python-3.14/bin")).unwrap();
    std::fs::write(tools.join("python-3.14/bin/python3"), "").unwrap();
    std::fs::write(tools.join("facts.json"), r#"{"packages":{"python":{"entry":"python-3.14"}}}"#).unwrap();
    assert_eq!(hermes_location(none, &home).python, tools.join("python-3.14/bin/python3"));
    // An entry that tries to leave the folder, or a link that does, is not taken.
    std::fs::write(tools.join("facts.json"), r#"{"packages":{"python":{"entry":"../x"}}}"#).unwrap();
    assert!(!hermes_location(none, &home).python.starts_with(&tools));
    let outside = home.join("fuera/bin");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("python3"), "").unwrap();
    symlink(home.join("fuera"), tools.join("enlace")).unwrap();
    std::fs::write(tools.join("facts.json"), r#"{"packages":{"python":{"entry":"enlace"}}}"#).unwrap();
    assert!(!hermes_location(none, &home).python.starts_with(&tools));
}

/// A SOUL.md heading like «SOUL.md — Sn4p · Perfil principal» gives the name only.
#[test]
fn soul_heading_gives_the_name() {
    use agora_server::hermes::catalog::soul_name;
    assert_eq!(soul_name("SOUL.md — Sn4p · Perfil principal de Hermes"), "Sn4p");
    assert_eq!(soul_name("SOUL.md: Atlas"), "Atlas");
    assert_eq!(soul_name("Hermes, mi asistente"), "Hermes, mi asistente", "otro título se queda como está");
    assert_eq!(soul_name("SOUL.md"), "SOUL.md", "sin nombre detrás, el título");
}
