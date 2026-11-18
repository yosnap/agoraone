//! Ported from server/profile-editor.test.ts and hermes-skills.test.ts: real writes through the built-in
//! Python writer on fictitious profiles.

use std::fs;
use std::path::{Path, PathBuf};

use agora_server::hermes::catalog::{HermesDiscovery, file_revision};
use agora_server::hermes::location::HermesLocation;
use agora_server::hermes::profile_editor::{ProfileEdit, backup_memories, save_profile_file};
use agora_server::hermes::skills::{NewSkill, SkillEdit, create_profile_skill, list_profile_skills, read_profile_skill, save_profile_skill};
use agora_server::platform::{canonicalize, create_test_link as symlink, remove_test_link};
use agora_server::secret_lines::mask_secrets;
use agora_server::security::Failure;
use serde_json::Value;

struct Fixture {
    _dir: tempfile::TempDir,
    base: PathBuf,
    home: PathBuf,
    discovery: HermesDiscovery,
    id: String,
    backups: PathBuf,
}

fn fixture(setup: impl FnOnce(&Path)) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let base = canonicalize(dir.path()).unwrap();
    let home = base.join("hermes/profiles/alpha");
    fs::create_dir_all(&home).unwrap();
    setup(&home);
    let location = HermesLocation { root: base.join("hermes"), installation: "/not-installed".into(), python: PathBuf::new(), source: "test".into() };
    let discovery = HermesDiscovery::new(location);
    let id = discovery.scan(false).profiles.into_iter().find(|p| p.name == "alpha").unwrap().id;
    Fixture { _dir: dir, backups: base.join("backups"), base, home, discovery, id }
}

fn identity(home: &Path) {
    fs::create_dir_all(home.join("memories")).unwrap();
    fs::write(home.join("SOUL.md"), "# Alpha\nVivo en Madrid.\napi_key: CANARY_SOUL").unwrap();
    fs::write(home.join("memories/MEMORY.md"), "Primer recuerdo\n§\nSegundo recuerdo").unwrap();
    fs::write(home.join("config.yaml"), "memory:\n  memory_char_limit: 60\n").unwrap();
}

fn read(path: impl AsRef<Path>) -> String {
    fs::read_to_string(path).unwrap()
}

fn revision_of(path: impl AsRef<Path>) -> Option<String> {
    Some(file_revision(&read(path)))
}

fn text(content: &str, revision: Option<String>) -> ProfileEdit {
    ProfileEdit { content: Some(content.into()), entries: None, revision, revealed: false }
}

fn entries(list: &[&str], revision: Option<String>) -> ProfileEdit {
    ProfileEdit { content: None, entries: Some(list.iter().map(|s| s.to_string()).collect()), revision, revealed: false }
}

fn status<T: std::fmt::Debug>(result: Result<T, Failure>) -> u16 {
    result.unwrap_err().status.as_u16()
}

#[tokio::test]
async fn soul_is_saved_keeping_hidden_lines_with_a_backup() {
    let f = fixture(identity);
    let soul = f.home.join("SOUL.md");
    let before = read(&soul);
    let masked = mask_secrets(&before).text;
    assert!(masked.contains("[línea oculta 1]"));
    let result = save_profile_file(&f.discovery, &f.backups, &f.id, "SOUL.md", text(&masked.replace("Madrid", "Valencia"), revision_of(&soul))).await.unwrap();
    assert_eq!(read(&soul), "# Alpha\nVivo en Valencia.\napi_key: CANARY_SOUL");
    assert_eq!(result["revision"].as_str().map(str::to_string), revision_of(&soul));
    let copies: Vec<_> = fs::read_dir(f.backups.join(&f.id)).unwrap().flatten().collect();
    assert_eq!(read(copies[0].path()), before);
    // Removing a marker deletes that line; inventing one is rejected.
    save_profile_file(&f.discovery, &f.backups, &f.id, "SOUL.md", text("# Alpha\nVivo en Valencia.", revision_of(&soul))).await.unwrap();
    assert!(!read(&soul).contains("CANARY"));
    assert_eq!(status(save_profile_file(&f.discovery, &f.backups, &f.id, "SOUL.md", text("[línea oculta 7]", revision_of(&soul))).await), 400);
}

#[tokio::test]
async fn a_change_made_by_hermes_meanwhile_is_not_overwritten() {
    let f = fixture(identity);
    let soul = f.home.join("SOUL.md");
    let stale = revision_of(&soul);
    fs::write(&soul, "Cambio de Hermes").unwrap();
    assert_eq!(status(save_profile_file(&f.discovery, &f.backups, &f.id, "SOUL.md", text("Mi versión", stale)).await), 409);
    assert_eq!(read(&soul), "Cambio de Hermes");
}

#[tokio::test]
async fn memories_follow_hermes_format_and_limit_and_user_md_can_be_new() {
    let f = fixture(identity);
    let memory = f.home.join("memories/MEMORY.md");
    save_profile_file(&f.discovery, &f.backups, &f.id, "MEMORY.md", entries(&[" Primer recuerdo ", "", "Vive en Valencia", "Primer recuerdo"], revision_of(&memory))).await.unwrap();
    assert_eq!(read(&memory), "Primer recuerdo\n§\nVive en Valencia");
    assert!(f.home.join("memories/MEMORY.md.lock").exists(), "usa el mismo bloqueo que Hermes");
    let long = "x".repeat(61);
    assert_eq!(status(save_profile_file(&f.discovery, &f.backups, &f.id, "MEMORY.md", entries(&[&long], revision_of(&memory))).await), 400);
    let user = f.home.join("memories/USER.md");
    save_profile_file(&f.discovery, &f.backups, &f.id, "USER.md", entries(&["Se llama Ana"], None)).await.unwrap();
    assert_eq!(read(&user), "Se llama Ana");
    assert_eq!(status(save_profile_file(&f.discovery, &f.backups, &f.id, "USER.md", entries(&["Otra"], None)).await), 409);
}

#[tokio::test]
async fn no_writes_through_symlinks_or_to_unknown_profiles() {
    let f = fixture(identity);
    let soul = f.home.join("SOUL.md");
    let outside = f.base.join("fuera.md");
    fs::write(&outside, "Fuera").unwrap();
    fs::remove_file(&soul).unwrap();
    symlink(&outside, &soul).unwrap();
    assert_eq!(status(save_profile_file(&f.discovery, &f.backups, &f.id, "SOUL.md", text("x", Some(file_revision("Fuera")))).await), 400);
    assert_eq!(read(&outside), "Fuera");
    let unknown = format!("profile-{}", "0".repeat(24));
    assert_eq!(status(save_profile_file(&f.discovery, &f.backups, &unknown, "SOUL.md", text("x", None)).await), 404);
}

#[tokio::test]
async fn bom_linked_lock_or_folder_and_editing_with_lines_shown() {
    let f = fixture(identity);
    let soul = f.home.join("SOUL.md");
    fs::write(&soul, "\u{feff}# Con BOM").unwrap();
    save_profile_file(&f.discovery, &f.backups, &f.id, "SOUL.md", text("# Sin BOM", Some(file_revision("# Con BOM")))).await.unwrap();
    assert_eq!(read(&soul), "# Sin BOM");
    // Edited with hidden lines shown: the text is taken as is, so a literal marker stays literal.
    fs::write(&soul, "[línea oculta 1]\npassword: CANARY").unwrap();
    let edit = ProfileEdit { revealed: true, ..text("[línea oculta 1]\npassword: CANARY\nnueva", revision_of(&soul)) };
    save_profile_file(&f.discovery, &f.backups, &f.id, "SOUL.md", edit).await.unwrap();
    assert_eq!(read(&soul), "[línea oculta 1]\npassword: CANARY\nnueva");
    let memory = f.home.join("memories/MEMORY.md");
    let outside = f.base.join("fuera.lock");
    fs::write(&outside, "").unwrap();
    symlink(&outside, f.home.join("memories/MEMORY.md.lock")).unwrap();
    assert!(save_profile_file(&f.discovery, &f.backups, &f.id, "MEMORY.md", entries(&["x"], revision_of(&memory))).await.is_err());
    assert_eq!(read(&memory), "Primer recuerdo\n§\nSegundo recuerdo");
    remove_test_link(f.home.join("memories/MEMORY.md.lock")).unwrap();
    let elsewhere = f.base.join("otra-memoria");
    fs::create_dir(&elsewhere).unwrap();
    fs::write(elsewhere.join("MEMORY.md"), "Ajena").unwrap();
    fs::remove_dir_all(f.home.join("memories")).unwrap();
    symlink(&elsewhere, f.home.join("memories")).unwrap();
    assert!(save_profile_file(&f.discovery, &f.backups, &f.id, "MEMORY.md", entries(&["x"], Some(file_revision("Ajena")))).await.is_err());
    assert_eq!(read(elsewhere.join("MEMORY.md")), "Ajena");
}

#[test]
fn an_entry_ending_in_a_bare_key_does_not_merge_with_the_next() {
    let masked = mask_secrets("Correo del banco, contraseña:\n§\nVive en Valencia").text;
    assert_eq!(masked.split("\n§\n").count(), 2);
    assert!(masked.contains("Vive en Valencia"));
}

#[test]
fn turn_backup_copies_memory_only_when_changed_and_never_soul() {
    let f = fixture(identity);
    backup_memories(&f.discovery, &f.backups, &f.id);
    backup_memories(&f.discovery, &f.backups, &f.id);
    let folder = f.backups.join(&f.id);
    let names = || {
        let mut names: Vec<String> = fs::read_dir(&folder).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    };
    assert_eq!(names().len(), 1, "sin cambios no se repite la copia; USER.md no existe y no se inventa");
    fs::write(f.home.join("memories/MEMORY.md"), "Primer recuerdo\n§\nTercer recuerdo").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    backup_memories(&f.discovery, &f.backups, &f.id);
    let copies = names();
    assert_eq!(copies.len(), 2);
    assert!(copies.iter().all(|n| n.starts_with("MEMORY.md.")));
    assert_eq!(read(folder.join(&copies[1])), "Primer recuerdo\n§\nTercer recuerdo");
    backup_memories(&f.discovery, &f.backups, "profile-desconocido");
}

const CANARY: &str = "api_key: SKILLS_CANARY";

fn skills(home: &Path) {
    fs::write(home.join("config.yaml"), "memory: {}\n").unwrap();
    let skill = |relative: &str, content: &str| {
        let path = home.join("skills").join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    };
    skill("redaccion/SKILL.md", &format!("---\nname: redaccion\ndescription: \"Tono de los textos.\"\n---\n\n# Redaccion\n{CANARY}\n"));
    skill("redaccion/correo/SKILL.md", "---\nname: correo\ndescription: \"Correos cortos.\"\n---\n\n# Correo\n");
    skill("redaccion/DESCRIPTION.md", "# Solo una categoria\n");
    skill("redaccion/notas.md", "# Sin frontmatter\n");
    skill(".hidden/SKILL.md", "---\nname: oculta\ndescription: \"No se muestra.\"\n---\n");
    skill("node_modules/dependencia/SKILL.md", "---\nname: dependencia\ndescription: \"Se excluye.\"\n---\n");
    let outside = home.join("../../../fuera");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("SKILL.md"), "---\nname: fuera\ndescription: \"Enlazada.\"\n---\n").unwrap();
    symlink(canonicalize(&outside).unwrap(), home.join("skills/enlazada")).unwrap();
}

fn skill_id(f: &Fixture, name: &str) -> String {
    list_profile_skills(&f.discovery, &f.id).unwrap().skills.into_iter().find(|s| s.name == name).unwrap().id
}

#[test]
fn skills_listing_sees_real_folders_two_levels_with_name_and_description() {
    let f = fixture(skills);
    let listing = list_profile_skills(&f.discovery, &f.id).unwrap();
    assert!(!listing.truncated);
    let mut names: Vec<&str> = listing.skills.iter().map(|s| s.name.as_str()).collect();
    names.sort();
    assert_eq!(names, ["correo", "redaccion"]);
    let correo = listing.skills.iter().find(|s| s.name == "correo").unwrap();
    assert_eq!(correo.category, "redaccion");
    assert_eq!(correo.description, "Correos cortos.");
    assert!(regex::Regex::new(r"^skill-[a-f0-9]{24}$").unwrap().is_match(&correo.id));
}

#[test]
fn skills_reading_hides_key_lines_and_reveal_shows_them() {
    let f = fixture(skills);
    let id = skill_id(&f, "redaccion");
    let masked = read_profile_skill(&f.discovery, &f.id, &id, false).unwrap();
    let content = masked["content"].as_str().unwrap();
    assert!(!content.contains("SKILLS_CANARY") && content.contains("[línea oculta 1]"));
    assert_eq!(masked["hidden"], 1);
    assert!(read_profile_skill(&f.discovery, &f.id, &id, true).unwrap()["content"].as_str().unwrap().contains("SKILLS_CANARY"));
    assert_eq!(masked["revision"].as_str().map(str::to_string), revision_of(f.home.join("skills/redaccion/SKILL.md")));
}

#[tokio::test]
async fn skills_saving_keeps_hidden_lines_needs_the_revision_and_backs_up() {
    let f = fixture(skills);
    let id = skill_id(&f, "redaccion");
    let path = f.home.join("skills/redaccion/SKILL.md");
    let before = read(&path);
    let edit = SkillEdit { content: mask_secrets(&before).text.replace("Redaccion", "Estilo"), revision: file_revision(&before), revealed: false };
    let result = save_profile_skill(&f.discovery, &f.backups, &f.id, &id, edit).await.unwrap();
    assert!(read(&path).contains("SKILLS_CANARY") && read(&path).contains("Estilo"));
    assert_eq!(result["revision"].as_str().map(str::to_string), revision_of(&path));
    let copies: Vec<_> = fs::read_dir(f.backups.join(&f.id).join("skills/redaccion")).unwrap().flatten().collect();
    assert_eq!(read(copies[0].path()), before);
    let stale = SkillEdit { content: "Otra".into(), revision: "0".repeat(24), revealed: false };
    assert_eq!(status(save_profile_skill(&f.discovery, &f.backups, &f.id, &id, stale).await), 409);
    let control = SkillEdit { content: "B\u{7}ad".into(), revision: file_revision(&read(&path)), revealed: false };
    assert_eq!(status(save_profile_skill(&f.discovery, &f.backups, &f.id, &id, control).await), 400);
    let missing = SkillEdit { content: "x".into(), revision: "0".repeat(24), revealed: false };
    assert_eq!(status(save_profile_skill(&f.discovery, &f.backups, &f.id, &format!("skill-{}", "0".repeat(24)), missing).await), 404);
}

fn new_skill(category: &str, name: &str, description: &str) -> NewSkill {
    NewSkill { category: category.into(), name: name.into(), description: description.into(), body: "Mantén el tono cercano.".into() }
}

#[tokio::test]
async fn skills_creation_writes_hermes_frontmatter_never_overwrites_and_rejects_bad_names() {
    let f = fixture(skills);
    let result = create_profile_skill(&f.discovery, &f.backups, &f.id, new_skill("nuevo", "tono-telegram", "Respuestas breves \"con comillas\".")).await.unwrap();
    let created = f.home.join("skills/nuevo/tono-telegram/SKILL.md");
    assert_eq!(read(&created), "---\nname: tono-telegram\ndescription: \"Respuestas breves \\\"con comillas\\\".\"\n---\n\nMantén el tono cercano.");
    let root = canonicalize(&f.base.join("hermes")).unwrap();
    assert_eq!(result["id"], Value::String(format!("skill-{}", file_revision(&format!("{}:skills/nuevo/tono-telegram/SKILL.md", root.display())))));
    assert_eq!(status(create_profile_skill(&f.discovery, &f.backups, &f.id, new_skill("nuevo", "tono-telegram", "")).await), 409);
    assert_eq!(status(create_profile_skill(&f.discovery, &f.backups, &f.id, new_skill("a/b", "x", "")).await), 400);
    assert_eq!(status(create_profile_skill(&f.discovery, &f.backups, &f.id, new_skill("nuevo", "tono Telegram", "")).await), 400);
}

#[tokio::test]
async fn skills_in_linked_folders_are_neither_listed_nor_written() {
    let f = fixture(skills);
    assert!(!list_profile_skills(&f.discovery, &f.id).unwrap().skills.iter().any(|s| s.name == "fuera"), "la carpeta enlazada no se lista");
    let root = canonicalize(&f.base.join("hermes")).unwrap();
    let id = format!("skill-{}", file_revision(&format!("{}:skills/enlazada/SKILL.md", root.display())));
    let edit = SkillEdit { content: "x".into(), revision: "0".repeat(24), revealed: false };
    assert_eq!(status(save_profile_skill(&f.discovery, &f.backups, &f.id, &id, edit).await), 404);
}
