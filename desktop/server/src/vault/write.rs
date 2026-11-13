//! Editing and creating notes in the user's real vaults (user's decision, 18/10/2026): revision-checked,
//! backed up first, written in place through a handle that never follows links, and never overwriting.

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use super::{Index, MAX_NOTE_BYTES, VaultNotes, sha256_hex};
use crate::hermes::safe_read::decode_utf8;
use crate::js::{digest, js_trim, now_iso};
use crate::secret_lines::{CONTROLS, mask_secrets, restore_secrets};
use crate::security::Failure;

const KEEP_BACKUPS: usize = 20;
// Characters Obsidian does not accept in a note name, plus path separators.
static BAD_TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[\\/:*?"<>|#^\[\]\x00-\x1f]"#).unwrap());
static INVISIBLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{Cf}\u{2028}\u{2029}]").unwrap());
const LINKED_FOLDER: &str = "La carpeta de la nota es un enlace y no se escribe en ella.";
const LINKED: &str = "La carpeta es un enlace y no se escribe en ella.";

fn conflict() -> Failure {
    Failure::new(409, "La nota cambió (en Obsidian o en otro sitio) mientras la editabas. Vuelve a cargarla para ver la versión actual.")
}

fn refused(message: &str) -> Failure {
    Failure::new(400, message)
}

fn internal<E>(_: E) -> Failure {
    Failure::new(500, "No se pudo guardar la nota.")
}

pub struct NoteEdit {
    pub content: String,
    pub revision: String,
    pub revealed: bool,
}

pub struct NoteMove {
    pub folder: String,
    pub title: String,
    pub revision: String,
}

#[derive(Serialize, Debug)]
pub struct Saved {
    pub id: String,
    pub revision: String,
}

#[derive(Serialize, Debug)]
pub struct Created {
    pub id: String,
    pub folder: String,
    pub title: String,
}

/// A valid note name (NFC) from a title, or a refusal saying what a title may hold.
fn note_name(title: &str) -> Result<String, Failure> {
    let name: String = js_trim(title).nfc().collect();
    if name.is_empty() || name.starts_with('.') || BAD_TITLE.is_match(&name) || INVISIBLE.is_match(&name) || name.len() + 3 > 255 {
        return Err(refused("Usa un título corto (hasta 250 bytes) sin / \\ : * ? \" < > | # ^ [ ], caracteres invisibles ni punto inicial."));
    }
    Ok(name)
}

/// A folder that already holds notes (or the vault's top level), and that is no link.
fn folder_of(index: &Index, folder: &str) -> Result<PathBuf, Failure> {
    if !folder.is_empty() && !index.notes.iter().any(|e| e.note.folder == folder || e.note.folder.starts_with(&format!("{folder}/"))) {
        return Err(Failure::new(404, "Esa carpeta no existe en el vault."));
    }
    let directory = folder.split('/').filter(|p| !p.is_empty()).fold(index.vault.root.clone(), |path, part| path.join(part));
    if fs::canonicalize(&directory).map_err(internal)? != directory {
        return Err(refused(LINKED));
    }
    Ok(directory)
}

fn check(content: &str) -> Result<(), Failure> {
    if CONTROLS.is_match(content) {
        return Err(refused("El texto contiene caracteres de control."));
    }
    if content.len() as u64 > MAX_NOTE_BYTES {
        return Err(refused("La nota supera 256 KiB."));
    }
    Ok(())
}

/// The note must still be a plain file (no link, one name) inside the vault, in a folder that is no link either.
fn safe_target(index: &Index, file: &Path) -> Result<fs::Metadata, Failure> {
    let meta = fs::symlink_metadata(file).map_err(|_| conflict())?;
    if !meta.is_file() || meta.nlink() != 1 {
        return Err(refused("Esta nota no se puede editar: es un enlace."));
    }
    let folder = file.parent().unwrap_or(Path::new("/"));
    if fs::canonicalize(folder).map_err(internal)? != folder || !folder.starts_with(&index.vault.root) {
        return Err(refused(LINKED_FOLDER));
    }
    Ok(meta)
}

fn backup(backups: &Path, vault_id: &str, note_id: &str, bytes: &[u8]) -> std::io::Result<()> {
    let folder = backups.join(vault_id);
    DirBuilder::new().recursive(true).mode(0o700).create(&folder)?;
    let name = format!("{note_id}.{}.bak", now_iso().replace(['-', ':'], ""));
    let mut copy = OpenOptions::new().write(true).create_new(true).mode(0o600).open(folder.join(name))?;
    copy.write_all(bytes)?;
    copy.sync_all()?;
    let prefix = format!("{note_id}.");
    let mut copies: Vec<String> = fs::read_dir(&folder)?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|f| f.starts_with(&prefix) && f.ends_with(".bak"))
        .collect();
    copies.sort();
    for old in &copies[..copies.len().saturating_sub(KEEP_BACKUPS)] {
        fs::remove_file(folder.join(old))?;
    }
    Ok(())
}

impl VaultNotes {
    /// Saves an edited note. The text the user edited is the masked one: hidden credential-like lines are put
    /// back from disk unless they were shown while editing. The note is written in place, through one handle
    /// opened without following links, so it keeps its creation date, mode and attributes in Obsidian: just
    /// before writing, that handle must still be the vault's note (same inode, folder no link) and its bytes
    /// must still be the revision the user opened. The previous version is copied to the backups folder
    /// first. Line endings and a leading BOM are kept as they were.
    pub fn save(&self, vault_id: &str, note_id: &str, edit: NoteEdit, backups: &Path) -> Result<Saved, Failure> {
        let index = self.index(vault_id, true)?;
        let entry = index
            .notes
            .iter()
            .find(|e| e.note.id == note_id && e.note.readable)
            .ok_or_else(|| Failure::new(404, "Esta nota no se puede editar: no existe, es demasiado grande o es un enlace."))?;
        let listed = safe_target(&index, &entry.file)?;
        let mut handle = OpenOptions::new().read(true).write(true).custom_flags(libc::O_NOFOLLOW).open(&entry.file).map_err(|_| conflict())?;
        let opened = handle.metadata().map_err(internal)?;
        if !opened.is_file() || opened.nlink() != 1 || opened.ino() != listed.ino() || opened.len() > MAX_NOTE_BYTES {
            return Err(refused("Esta nota no se puede editar: es un enlace o cambió de archivo."));
        }
        let folder = entry.file.parent().unwrap_or(Path::new("/"));
        if fs::canonicalize(folder).map_err(internal)? != folder || fs::symlink_metadata(&entry.file).map_err(internal)?.ino() != opened.ino() {
            return Err(refused(LINKED_FOLDER));
        }
        let mut bytes = Vec::new();
        (&mut handle).take(opened.len()).read_to_end(&mut bytes).map_err(internal)?;
        if sha256_hex(&bytes) != edit.revision {
            return Err(conflict());
        }
        let current = decode_utf8(bytes.clone()).ok_or_else(|| refused("La nota actual no es texto UTF-8."))?;
        // Hidden-line masking drops control characters, so such a note would lose them: edit it in Obsidian instead.
        if CONTROLS.is_match(&current) {
            return Err(refused("Esta nota contiene caracteres de control y se edita mejor en Obsidian, para no alterarlos."));
        }
        let content = if edit.revealed { edit.content } else { restore_secrets(&edit.content, &mask_secrets(&current).hidden).map_err(|e| refused(&e.to_string()))? };
        let mut content = content.replace("\r\n", "\n");
        if current.matches("\r\n").count() * 2 > current.matches('\n').count() {
            content = content.replace('\n', "\r\n");
        }
        check(&content)?;
        let bom: &[u8] = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) { &bytes[..3] } else { &[] };
        let output = [bom, content.as_bytes()].concat();
        backup(backups, vault_id, note_id, &bytes).map_err(internal)?;
        handle.write_all_at(&output, 0).map_err(internal)?;
        handle.set_len(output.len() as u64).map_err(internal)?;
        handle.sync_all().map_err(internal)?;
        self.forget(vault_id);
        Ok(Saved { id: note_id.to_string(), revision: sha256_hex(&output) })
    }

    /// Creates a new note in a folder that already holds notes (or the vault's top level); never overwrites.
    pub fn create(&self, vault_id: &str, folder: &str, title: &str, content: &str) -> Result<Created, Failure> {
        let index = self.index(vault_id, true)?;
        let name = note_name(title)?;
        check(content)?;
        let directory = folder_of(&index, folder)?;
        let linked = || fs::canonicalize(&directory).map(|real| real != directory);
        let file = directory.join(format!("{name}.md"));
        let mut handle = OpenOptions::new().write(true).create_new(true).custom_flags(libc::O_NOFOLLOW).mode(0o644).open(&file).map_err(|error| {
            if error.kind() == ErrorKind::AlreadyExists {
                Failure::new(409, "Ya existe una nota con ese título en esta carpeta.")
            } else {
                refused("No se pudo crear la nota en esa carpeta.")
            }
        })?;
        // The folder was swapped for a link between the check and the creation: undo and stop.
        if linked().unwrap_or(true) {
            let _ = fs::remove_file(&file);
            return Err(refused(LINKED));
        }
        handle.write_all(content.as_bytes()).map_err(internal)?;
        handle.sync_all().map_err(internal)?;
        self.forget(vault_id);
        Ok(created(&index, vault_id, &file, folder, name))
    }

    /// Moves a note to another folder of the vault and/or gives it a new title (user's decision, 13/11/2026).
    /// The user confirmed the revision they saw; the previous version is copied first. The note keeps its
    /// file (a hard link to the new name, then the old name is removed), so Obsidian keeps its creation date,
    /// and an existing note is never overwritten. Links to it from other notes are not rewritten.
    pub fn move_note(&self, vault_id: &str, note_id: &str, target: NoteMove, backups: &Path) -> Result<Created, Failure> {
        let index = self.index(vault_id, true)?;
        let entry = index
            .notes
            .iter()
            .find(|e| e.note.id == note_id && e.note.readable)
            .ok_or_else(|| Failure::new(404, "Esta nota no se puede mover: no existe, es demasiado grande o es un enlace."))?;
        let name = note_name(&target.title)?;
        if target.folder == entry.note.folder && name == entry.note.title {
            return Err(refused("La nota ya tiene ese título y está en esa carpeta."));
        }
        let listed = safe_target(&index, &entry.file)?;
        let directory = folder_of(&index, &target.folder)?;
        let file = directory.join(format!("{name}.md"));
        let handle = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&entry.file).map_err(|_| conflict())?;
        let opened = handle.metadata().map_err(internal)?;
        if !opened.is_file() || opened.nlink() != 1 || opened.ino() != listed.ino() || opened.len() > MAX_NOTE_BYTES {
            return Err(refused("Esta nota no se puede mover: es un enlace o cambió de archivo."));
        }
        let mut bytes = Vec::new();
        handle.take(opened.len()).read_to_end(&mut bytes).map_err(internal)?;
        if sha256_hex(&bytes) != target.revision {
            return Err(conflict());
        }
        backup(backups, vault_id, note_id, &bytes).map_err(internal)?;
        if let Err(error) = fs::hard_link(&entry.file, &file) {
            // Same file under another spelling (only case or accents change on a case-insensitive disk): a plain rename.
            let exists = error.kind() == ErrorKind::AlreadyExists;
            if exists && fs::symlink_metadata(&file).is_ok_and(|m| m.ino() == listed.ino()) {
                fs::rename(&entry.file, &file).map_err(internal)?;
                self.forget(vault_id);
                return Ok(created(&index, vault_id, &file, &target.folder, name));
            }
            return Err(if exists { Failure::new(409, "Ya existe una nota con ese título en esa carpeta.") } else { refused("No se pudo mover la nota en este disco.") });
        }
        // The destination folder was swapped for a link meanwhile: undo and stop.
        if fs::canonicalize(&directory).map(|real| real != directory).unwrap_or(true) {
            let _ = fs::remove_file(&file);
            return Err(refused(LINKED));
        }
        if let Err(error) = fs::remove_file(&entry.file) {
            let _ = fs::remove_file(&file);
            return Err(internal(error));
        }
        self.forget(vault_id);
        Ok(created(&index, vault_id, &file, &target.folder, name))
    }
}

fn created(index: &Index, vault_id: &str, file: &Path, folder: &str, title: String) -> Created {
    let path = file.strip_prefix(&index.vault.root).unwrap_or(file).to_string_lossy().into_owned();
    Created { id: format!("note-{}", digest(&format!("{vault_id}:{path}"))), folder: folder.to_string(), title }
}
