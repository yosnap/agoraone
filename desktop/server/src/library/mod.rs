//! The library: two fixed example documents (read by id from a registry, never by a client path) and each
//! browser identity's private copies of imported documents (`<data>/library/<owner>/<id>.json`, 0600 in
//! 0700 folders), which can be renamed or deleted only by their owner. Same rules as the former
//! server/library.ts and server/private-library.ts.

pub mod extract;
pub mod routes;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::hermes::safe_read::{decode_utf8, read_hermes_file};
use crate::js::{js_trim, utf16_len};
use crate::secret_lines::CONTROLS;

/// Text documents (and the text extracted from PDF or DOCX) are at most 24 KiB.
pub const MAX_TEXT: usize = 24 * 1024;
const MAX_STORED: u64 = 40_000;
const MAX_COPIES: usize = 100;
pub const UNAVAILABLE: &str = "Documento no disponible o fuera de los permisos de lectura.";

static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^import-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$").unwrap());
static OWNER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-f0-9]{64}$").unwrap());
static BASE64: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$").unwrap());
static PATHLIKE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[/\\\x00-\x1f\x7f]").unwrap());
static EXTENSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(txt|md|markdown|pdf|docx)$").unwrap());

/// The fixed examples: id, title and file name in the examples folder.
pub const EXAMPLES: [(&str, &str, &str); 2] =
    [("welcome", "Bienvenida a la biblioteca", "bienvenida.txt"), ("orbital-garden", "Huerto orbital · ejemplo", "huerto-orbital.txt")];

/// A document as the chat and the library see it.
#[derive(Serialize, Debug, Clone)]
pub struct Document {
    pub id: String,
    pub title: String,
    pub content: String,
    pub revision: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct Listed {
    pub id: String,
    pub title: String,
    pub kind: &'static str,
}

/// Refused or missing: the caller answers with its own generic message.
#[derive(Debug)]
pub struct LibraryError;

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// An imported file's name: 1 to 160 units, no hidden name, no path or control characters, a known extension.
pub fn valid_name(name: &str) -> bool {
    (1..=160).contains(&utf16_len(name)) && !name.starts_with('.') && !PATHLIKE.is_match(name) && EXTENSION.is_match(name)
}

/// A new title for a copy, trimmed: 1 to 160 units, no path or control characters, not `.` or `..`.
pub fn valid_title(title: &str) -> Option<String> {
    let title = js_trim(title);
    ((1..=160).contains(&utf16_len(title)) && !PATHLIKE.is_match(title) && title != "." && title != "..").then(|| title.to_string())
}

/// `Buffer.from(text, 'base64')` that must re-encode to the same text (so nothing is silently dropped).
pub fn canonical_base64(text: &str) -> Option<Vec<u8>> {
    let bytes = STANDARD.decode(text).ok()?;
    (STANDARD.encode(&bytes) == text).then_some(bytes)
}

/// A stored or uploaded text: canonical base64 of 1 to 24 KiB of UTF-8 with some text and no control characters.
pub fn decode_document(base64: &str) -> Result<(String, String), LibraryError> {
    let bytes = canonical_base64(base64).filter(|b| !b.is_empty() && b.len() <= MAX_TEXT).ok_or(LibraryError)?;
    let content = decode_utf8(bytes.clone()).ok_or(LibraryError)?;
    if js_trim(&content).is_empty() || CONTROLS.is_match(&content) {
        return Err(LibraryError);
    }
    Ok((content, sha256_hex(&bytes)))
}

/// One of the fixed examples, read from the examples folder without following links.
pub fn read_example(root: &Path, id: &str) -> Result<Document, LibraryError> {
    let (id, title, file) = EXAMPLES.iter().find(|(known, _, _)| *known == id).ok_or(LibraryError)?;
    let bytes = read_hermes_file(root, &root.join(file), MAX_TEXT as u64).map_err(|_| LibraryError)?;
    let revision = sha256_hex(&bytes);
    let content = decode_utf8(bytes).filter(|c| !c.contains('\0')).ok_or(LibraryError)?;
    Ok(Document { id: id.to_string(), title: title.to_string(), content, revision })
}

pub fn list_examples() -> Vec<Listed> {
    EXAMPLES.iter().map(|(id, title, _)| Listed { id: id.to_string(), title: title.to_string(), kind: "example" }).collect()
}

/// Each browser identity's imported copies.
pub struct PrivateLibrary {
    root: PathBuf,
}

impl PrivateLibrary {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn directory(&self, owner: &str, create: bool) -> Result<PathBuf, LibraryError> {
        if !OWNER.is_match(owner) {
            return Err(LibraryError);
        }
        crate::platform::create_dir_mode(&self.root, true, 0o700).map_err(|_| LibraryError)?;
        if !crate::platform::is_same_real_path(&self.root).map_err(|_| LibraryError)? {
            return Err(LibraryError);
        }
        let directory = self.root.join(owner);
        if create {
            crate::platform::create_dir_mode(&directory, true, 0o700).map_err(|_| LibraryError)?;
        }
        if directory.exists() && !crate::platform::is_same_real_path(&directory).map_err(|_| LibraryError)? {
            return Err(LibraryError);
        }
        Ok(directory)
    }

    pub fn list(&self, owner: &str) -> Vec<Listed> {
        let Ok(directory) = self.directory(owner, false) else { return vec![] };
        let Ok(entries) = fs::read_dir(directory) else { return vec![] };
        entries
            .flatten()
            .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".json")).map(str::to_string))
            .filter_map(|id| self.read(&id, owner).ok())
            .map(|doc| Listed { id: doc.id, title: doc.title, kind: "private" })
            .collect()
    }

    /// Stores an imported text (already extracted for PDF and DOCX) as a new private copy.
    pub fn import(&self, name: &str, base64: &str, owner: &str) -> Result<Document, LibraryError> {
        if !valid_name(name) || !(4..=32_768).contains(&base64.len()) || !BASE64.is_match(base64) {
            return Err(LibraryError);
        }
        let (content, revision) = decode_document(base64)?;
        let directory = self.directory(owner, true)?;
        if fs::read_dir(&directory).map_err(|_| LibraryError)?.count() >= MAX_COPIES {
            return Err(LibraryError);
        }
        let id = format!("import-{}", uuid_v4());
        let mut stored = Map::new();
        for (key, value) in [("name", name), ("base64", base64), ("id", &id), ("owner", owner)] {
            stored.insert(key.into(), value.into());
        }
        write_new(&directory.join(format!("{id}.json")), &Value::Object(stored))?;
        Ok(Document { id, title: name.to_string(), content, revision })
    }

    pub fn read(&self, id: &str, owner: &str) -> Result<Document, LibraryError> {
        let stored = self.read_stored(id, owner)?;
        let title = stored.get("title").or_else(|| stored.get("name")).and_then(Value::as_str).unwrap_or_default().to_string();
        let (content, revision) = decode_document(stored["base64"].as_str().unwrap_or_default())?;
        Ok(Document { id: id.to_string(), title, content, revision })
    }

    /// A new title; id and content stay. Written to a temporary file and renamed over the copy.
    pub fn rename(&self, id: &str, owner: &str, title: &str) -> Result<Document, LibraryError> {
        let mut stored = self.read_stored(id, owner)?;
        stored.insert("title".into(), title.into());
        let file = self.directory(owner, false)?.join(format!("{id}.json"));
        let temporary = file.with_extension(format!("json.{}.tmp", uuid_v4()));
        write_new(&temporary, &Value::Object(stored.clone()))?;
        if fs::rename(&temporary, &file).is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(LibraryError);
        }
        let (content, revision) = decode_document(stored["base64"].as_str().unwrap_or_default())?;
        Ok(Document { id: id.to_string(), title: title.to_string(), content, revision })
    }

    pub fn delete(&self, id: &str, owner: &str) -> Result<(), LibraryError> {
        self.read_stored(id, owner)?;
        fs::remove_file(self.directory(owner, false)?.join(format!("{id}.json"))).map_err(|_| LibraryError)
    }

    /// The stored envelope, only if it is a plain file of this owner with exactly the expected fields.
    fn read_stored(&self, id: &str, owner: &str) -> Result<Map<String, Value>, LibraryError> {
        if !ID.is_match(id) {
            return Err(LibraryError);
        }
        let directory = self.directory(owner, false)?;
        let bytes = read_hermes_file(&directory, &directory.join(format!("{id}.json")), MAX_STORED).map_err(|_| LibraryError)?;
        let text = String::from_utf8(bytes).map_err(|_| LibraryError)?;
        let Ok(Value::Object(stored)) = serde_json::from_str::<Value>(text.strip_prefix('\u{feff}').unwrap_or(&text)) else { return Err(LibraryError) };
        let text_field = |key: &str| stored.get(key).and_then(Value::as_str);
        let shape = stored.keys().all(|k| ["name", "base64", "id", "owner", "title"].contains(&k.as_str()))
            && text_field("name").is_some_and(valid_name)
            && text_field("base64").is_some_and(|b| (4..=32_768).contains(&b.len()) && BASE64.is_match(b))
            && text_field("id") == Some(id)
            && text_field("owner") == Some(owner)
            && match stored.get("title") {
                None => true,
                Some(Value::String(title)) => valid_title(title).is_some(),
                Some(_) => false,
            };
        if !shape {
            return Err(LibraryError);
        }
        decode_document(text_field("base64").unwrap_or_default())?;
        Ok(stored)
    }
}

/// Creates a new 0600 file (never an existing one, never through a link) with this JSON.
fn write_new(file: &Path, value: &Value) -> Result<(), LibraryError> {
    let mut handle = crate::platform::create_new_nofollow(file, 0o600).map_err(|_| LibraryError)?;
    if handle.write_all(value.to_string().as_bytes()).and_then(|_| handle.sync_all()).is_err() {
        drop(handle);
        let _ = fs::remove_file(file);
        return Err(LibraryError);
    }
    Ok(())
}

/// A random version 4 UUID, as `crypto.randomUUID()` prints it.
pub fn uuid_v4() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}
