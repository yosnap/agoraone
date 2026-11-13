//! Access to the Obsidian vaults listed in Obsidian's own registry: reading, searching, and editing or
//! creating notes (writes in write.rs). Clients only ever send opaque ids: vault and note paths are resolved
//! here from a fresh walk, never from the request. Same rules as the former server/vault-notes.ts.

pub mod routes;
mod write;

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

pub use write::{NoteEdit, NoteMove};

use crate::hermes::safe_read::{decode_utf8, read_hermes_file, redact_str};
use crate::js::{digest, iso_ms, js_trim, locale_cmp, slice_utf16};
use crate::secret_lines::{mask_secrets, reveal_secrets};
use crate::security::Failure;

const MAX_NOTES: usize = 5000;
const MAX_DEPTH: usize = 12;
const MAX_ENTRIES: usize = 50_000;
const MAX_NOTE_BYTES: u64 = 256 * 1024;
const MAX_SEARCH_BYTES: u64 = 16 * 1024 * 1024;
const CACHE: Duration = Duration::from_secs(15);
/// Same limit as library documents: a note sent to the model is cut to this size, and says so.
pub const CONSULT_BYTES: usize = 24 * 1024;
const CUT_NOTICE: &str = "\n\n[Nota recortada a 24 KiB para la consulta]";
pub const NOTE_UNAVAILABLE: &str = "Nota no disponible: puede ser demasiado grande, no ser texto UTF-8 o haber cambiado.";

static DIACRITIC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Diacritic}").unwrap());

fn unavailable() -> Failure {
    Failure::new(404, NOTE_UNAVAILABLE)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultNote {
    pub id: String,
    pub title: String,
    pub folder: String,
    pub bytes: u64,
    pub modified_at: String,
    pub readable: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct VaultRef {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Debug)]
pub struct Listing {
    pub vault: VaultRef,
    pub truncated: bool,
    pub notes: Vec<VaultNote>,
}

#[derive(Serialize, Debug)]
pub struct NoteRead {
    #[serde(flatten)]
    pub note: VaultNote,
    pub content: String,
    pub hidden: usize,
    pub revision: String,
}

#[derive(Serialize, Debug)]
pub struct Hit {
    pub id: String,
    pub title: String,
    pub folder: String,
    pub snippet: String,
}

#[derive(Serialize, Debug)]
pub struct Search {
    pub results: Vec<Hit>,
    pub truncated: bool,
}

/// A note as a chat document (the same shape as a library document).
#[derive(Serialize, Debug)]
pub struct NoteDocument {
    pub id: String,
    pub title: String,
    pub content: String,
    pub revision: String,
}

#[derive(Clone)]
struct Vault {
    id: String,
    name: String,
    root: PathBuf,
}

struct Entry {
    note: VaultNote,
    file: PathBuf,
}

struct Index {
    vault: Vault,
    notes: Vec<Entry>,
    truncated: bool,
    at: Instant,
}

/// Case- and accent-insensitive form for search.
fn fold(text: &str) -> String {
    DIACRITIC.replace_all(&text.nfd().collect::<String>(), "").to_lowercase()
}

pub struct VaultNotes {
    registry: Option<PathBuf>,
    indexes: Mutex<HashMap<String, Arc<Index>>>,
    note_vaults: Mutex<HashMap<String, String>>,
}

impl VaultNotes {
    pub fn new(registry: Option<PathBuf>) -> Self {
        Self { registry, indexes: Mutex::default(), note_vaults: Mutex::default() }
    }

    /// The registered vaults that exist; same validation as the catalog: absolute, unique paths only.
    fn vaults(&self) -> Vec<Vault> {
        let Some(registry) = &self.registry else { return vec![] };
        let read = || -> anyhow::Result<Value> {
            let root = fs::canonicalize(registry.parent().unwrap_or(Path::new("/")))?;
            let name = registry.file_name().ok_or_else(|| anyhow::anyhow!("Invalid registry"))?;
            Ok(serde_json::from_slice(&read_hermes_file(&root, &root.join(name), 128 * 1024)?)?)
        };
        let Ok(data) = read() else { return vec![] };
        let Some(Value::Object(entries)) = data.get("vaults") else { return vec![] };
        let mut seen = std::collections::HashSet::new();
        entries
            .values()
            .take(100)
            .filter_map(|value| {
                let path = value.get("path")?.as_str()?;
                if !Path::new(path).is_absolute() || !seen.insert(path.to_string()) {
                    return None;
                }
                let real = fs::canonicalize(path).ok()?;
                if !fs::symlink_metadata(&real).ok()?.is_dir() {
                    return None;
                }
                let base = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                Some(Vault { id: format!("vault-{}", digest(path)), name: redact_str(&base, 100), root: real })
            })
            .collect()
    }

    /// Walks Markdown notes only: no hidden folders (.obsidian, .trash), no symlinks, no attachments.
    fn index(&self, vault_id: &str, fresh: bool) -> Result<Arc<Index>, Failure> {
        if !fresh
            && let Some(cached) = self.indexes.lock().unwrap().get(vault_id)
            && cached.at.elapsed() < CACHE
        {
            return Ok(cached.clone());
        }
        let vault = self.vaults().into_iter().find(|v| v.id == vault_id).ok_or_else(unavailable)?;
        let mut walk = Walk { vault: &vault, notes: vec![], truncated: false, visited: 0 };
        walk.folder(&vault.root, 0);
        let (notes, truncated) = (walk.notes, walk.truncated);
        {
            let mut known = self.note_vaults.lock().unwrap();
            for entry in &notes {
                known.insert(entry.note.id.clone(), vault.id.clone());
            }
        }
        let index = Arc::new(Index { vault, notes, truncated, at: Instant::now() });
        self.indexes.lock().unwrap().insert(vault_id.to_string(), index.clone());
        Ok(index)
    }

    fn forget(&self, vault_id: &str) {
        self.indexes.lock().unwrap().remove(vault_id);
    }

    /// `fresh` skips the 15-second cache (the brain's index wants the vault as it is now).
    pub fn list(&self, vault_id: &str, fresh: bool) -> Result<Listing, Failure> {
        let index = self.index(vault_id, fresh)?;
        Ok(Listing {
            vault: VaultRef { id: index.vault.id.clone(), name: index.vault.name.clone() },
            truncated: index.truncated,
            notes: index.notes.iter().map(|e| e.note.clone()).collect(),
        })
    }

    fn text(index: &Index, entry: &Entry) -> Option<(Vec<u8>, String)> {
        let bytes = read_hermes_file(&index.vault.root, &entry.file, MAX_NOTE_BYTES).ok()?;
        let content = decode_utf8(bytes.clone())?;
        (!content.contains('\0')).then_some((bytes, content))
    }

    pub fn read(&self, vault_id: &str, note_id: &str, reveal: bool) -> Result<NoteRead, Failure> {
        let index = self.index(vault_id, false)?;
        let entry = index.notes.iter().find(|e| e.note.id == note_id).ok_or_else(unavailable)?;
        let (bytes, content) = Self::text(&index, entry).ok_or_else(unavailable)?;
        let masked = mask_secrets(&content);
        Ok(NoteRead {
            note: entry.note.clone(),
            content: if reveal { reveal_secrets(&content) } else { masked.text },
            hidden: masked.hidden.len(),
            revision: sha256_hex(&bytes),
        })
    }

    /// Case- and accent-insensitive search in titles and content; snippets come from the matching line.
    pub fn search(&self, vault_id: &str, query: &str) -> Result<Search, Failure> {
        let index = self.index(vault_id, false)?;
        let needle = fold(query);
        let (mut results, mut read, mut truncated) = (Vec::new(), 0u64, false);
        for entry in &index.notes {
            if results.len() >= 50 {
                truncated = true;
                break;
            }
            let note = &entry.note;
            let title_hit = fold(&note.title).contains(&needle);
            // Content is read only within a total byte budget, so one search cannot stall the server.
            let mut line = None;
            if note.readable && read + note.bytes <= MAX_SEARCH_BYTES {
                read += note.bytes;
                // The snippet is taken from the masked note, so a PEM body or other hidden line never shows.
                if let Some((_, content)) = Self::text(&index, entry)
                    && let Some(at) = content.split('\n').position(|text| fold(text).contains(&needle))
                {
                    line = mask_secrets(&content).text.split('\n').nth(at).map(str::to_string);
                }
            } else if note.readable {
                truncated = true;
            }
            if !title_hit && line.is_none() {
                continue;
            }
            let snippet = slice_utf16(js_trim(line.as_deref().unwrap_or("")), 200);
            results.push(Hit { id: note.id.clone(), title: note.title.clone(), folder: note.folder.clone(), snippet });
        }
        Ok(Search { results, truncated })
    }

    /// A note as a chat document. Only called for an explicit user send; long notes are cut and marked.
    pub fn document(&self, note_id: &str) -> Result<NoteDocument, Failure> {
        // Notes seen in a listing map straight to their vault; otherwise each vault is tried in turn.
        let known = self.note_vaults.lock().unwrap().get(note_id).cloned();
        let mut order: Vec<String> = known.iter().cloned().collect();
        order.extend(self.vaults().into_iter().map(|v| v.id).filter(|id| Some(id) != known.as_ref()));
        for vault_id in order {
            let Ok(index) = self.index(&vault_id, false) else { continue };
            let Some(entry) = index.notes.iter().find(|e| e.note.id == note_id) else { continue };
            let read = self.read(&vault_id, note_id, false)?;
            // The whole document, notice included, stays within the 24 KiB the bridge accepts.
            let content = if read.content.len() > CONSULT_BYTES {
                let head = String::from_utf8_lossy(&read.content.as_bytes()[..CONSULT_BYTES - CUT_NOTICE.len()]).into_owned();
                format!("{}{CUT_NOTICE}", head.strip_suffix('\u{fffd}').unwrap_or(&head))
            } else {
                read.content
            };
            let folder = if entry.note.folder.is_empty() { String::new() } else { format!("{}/", entry.note.folder) };
            return Ok(NoteDocument { id: entry.note.id.clone(), title: format!("{} · {folder}{}", index.vault.name, entry.note.title), content, revision: read.revision });
        }
        Err(unavailable())
    }
}

struct Walk<'a> {
    vault: &'a Vault,
    notes: Vec<Entry>,
    truncated: bool,
    visited: usize,
}

impl Walk<'_> {
    fn folder(&mut self, folder: &Path, depth: usize) {
        if depth > MAX_DEPTH {
            self.truncated = true;
            return;
        }
        // An unreadable or vanished folder is skipped, not fatal for the whole vault.
        let Ok(listing) = fs::read_dir(folder) else {
            self.truncated = true;
            return;
        };
        let mut entries: Vec<_> = listing.flatten().map(|e| (e.file_name().to_string_lossy().into_owned(), e)).collect();
        entries.sort_by(|a, b| locale_cmp(&a.0, &b.0));
        for (name, entry) in entries {
            self.visited += 1;
            if self.visited > MAX_ENTRIES {
                self.truncated = true;
                return;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if name.starts_with('.') || kind.is_symlink() {
                continue;
            }
            let file = entry.path();
            if kind.is_dir() {
                self.folder(&file, depth + 1);
            } else if kind.is_file() && name.to_lowercase().ends_with(".md") {
                if self.notes.len() >= MAX_NOTES {
                    self.truncated = true;
                    return;
                }
                let Ok(meta) = fs::symlink_metadata(&file) else { continue };
                let path = file.strip_prefix(&self.vault.root).unwrap_or(&file).to_string_lossy().into_owned();
                let folder = path.rsplit_once('/').map(|(f, _)| f.to_string()).unwrap_or_default();
                // Node rounds the milliseconds; the brain's index compares these dates, so they must match.
                let modified = (meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1e6).round() as i64;
                self.notes.push(Entry {
                    note: VaultNote {
                        id: format!("note-{}", digest(&format!("{}:{path}", self.vault.id))),
                        title: name[..name.len() - 3].to_string(),
                        folder,
                        bytes: meta.len(),
                        modified_at: iso_ms(modified).unwrap_or_default(),
                        readable: meta.len() <= MAX_NOTE_BYTES && meta.nlink() == 1,
                    },
                    file,
                });
            }
        }
    }
}
