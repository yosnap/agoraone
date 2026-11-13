//! Reading Hermes' files without following links out of its folder, without hard links and with a size cap;
//! YAML metadata parsed from those reads; and the masking applied to user-authored text shown without asking.

use std::fs::{self, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::js::slice_utf16;
use crate::secret_lines::CONTROLS;

fn unavailable() -> io::Error {
    io::Error::other("Unavailable")
}

/// `path.resolve`: absolute and without `.` or `..`, purely lexical.
pub fn normalize(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
    let mut out = PathBuf::from("/");
    for part in absolute.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => out.push(name),
            _ => {}
        }
    }
    out
}

pub fn within(root: &Path, file: &Path) -> bool {
    normalize(file).starts_with(normalize(root))
}

/// Reads one regular file under `root`: no symlinks, a single hard link, at most `limit` bytes. A missing
/// file answers NotFound; anything else that is refused answers a generic error.
pub fn read_hermes_file(root: &Path, file: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let target = normalize(file);
    if !within(root, &target) {
        return Err(unavailable());
    }
    // Do not follow symlinks into a credential file or another collection.
    if fs::canonicalize(&target)? != target {
        return Err(unavailable());
    }
    let handle = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(&target)?;
    let meta = handle.metadata()?;
    if !meta.is_file() || meta.nlink() != 1 || meta.len() > limit {
        return Err(unavailable());
    }
    let mut data = Vec::new();
    handle.take(limit + 1).read_to_end(&mut data)?;
    if data.len() as u64 > limit {
        return Err(unavailable());
    }
    Ok(data)
}

/// YAML from the reader above turned into JSON values (keys as strings, like the former parser).
pub fn yaml_to_json(value: serde_norway::Value) -> Value {
    use serde_norway::Value as Y;
    match value {
        Y::Null => Value::Null,
        Y::Bool(b) => Value::Bool(b),
        Y::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::from(i)
            } else if let Some(u) = n.as_u64() {
                Value::from(u)
            } else {
                n.as_f64().and_then(serde_json::Number::from_f64).map(Value::Number).unwrap_or(Value::Null)
            }
        }
        Y::String(s) => Value::String(s),
        Y::Sequence(items) => Value::Array(items.into_iter().map(yaml_to_json).collect()),
        Y::Mapping(map) => {
            let mut out = Map::new();
            for (key, value) in map {
                let key = match yaml_to_json(key) {
                    Value::String(s) => s,
                    Value::Null => String::new(),
                    other => crate::js::js_string(Some(&other)),
                };
                out.insert(key, yaml_to_json(value));
            }
            Value::Object(out)
        }
        Y::Tagged(tagged) => yaml_to_json(tagged.value),
    }
}

/// A YAML metadata file (up to 512 KiB) as an object; anything that is not a mapping is empty.
pub fn read_metadata(root: &Path, file: &Path) -> anyhow::Result<Map<String, Value>> {
    let text = String::from_utf8(read_hermes_file(root, file, 512 * 1024)?)?;
    let value: serde_norway::Value = serde_norway::from_str(&text)?;
    Ok(match yaml_to_json(value) {
        Value::Object(map) => map,
        _ => Map::new(),
    })
}

static PEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)-----BEGIN .*?-----END [^-]+-----").unwrap());
static CREDENTIAL_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?imR)^.*(?:api[_ -]?key|token|authorization|password|contraseña|clave(?: de api)?|secret(?:[_ -]?key)?|private[_ -]?key|credential)\s*[:=].*$").unwrap()
});
static KNOWN_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?-u:\b)(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_\-]+").unwrap());
static LONG_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?-u:\b)[A-Za-z0-9_+/=-]{40,}(?-u:\b)").unwrap());
static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://[^\s)]+").unwrap());

/// Defence in depth for user-authored Markdown; never reads .env/auth/secret stores.
pub fn redact_str(text: &str, max: usize) -> String {
    let text = CONTROLS.replace_all(text, "");
    let text = PEM.replace_all(&text, "[contenido reservado]");
    let text = CREDENTIAL_LINE.replace_all(&text, "[credencial omitida]");
    let text = KNOWN_KEY.replace_all(&text, "[credencial omitida]");
    let text = LONG_RUN.replace_all(&text, "[cadena reservada]");
    let text = LINK.replace_all(&text, "[enlace omitido]");
    slice_utf16(&text, max)
}

/// `redact(value, max)`: anything that is not a string is empty.
pub fn redact(value: Option<&Value>, max: usize) -> String {
    match value {
        Some(Value::String(s)) => redact_str(s, max),
        _ => String::new(),
    }
}
