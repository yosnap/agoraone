//! The tools of one MCP server as Hermes cached them (cache/mcp_schema_cache.json), valid only while the
//! server's configuration still has the fingerprint Hermes recorded.

use std::io::ErrorKind;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::safe_read::{read_hermes_file, redact, redact_str};
use crate::js::{iso_ms, now_ms, number_text, utf16_len};

fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn json_string(text: &str) -> String {
    let quoted = serde_json::to_string(text).unwrap_or_default();
    let mut out = String::with_capacity(quoted.len());
    for ch in quoted.chars() {
        if (ch as u32) < 0x7f {
            out.push(ch);
        } else {
            for unit in ch.encode_utf16(&mut [0; 2]) {
                out.push_str(&format!("\\u{unit:04x}"));
            }
        }
    }
    out
}

/// Python's `json.dumps(sort_keys=True, separators=(',', ':'))`, ASCII escaped, as Hermes fingerprints.
fn canonical(value: &Value) -> String {
    match value {
        Value::Array(items) => format!("[{}]", items.iter().map(canonical).collect::<Vec<_>>().join(",")),
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|(a, _), (b, _)| utf16_cmp(a, b));
            format!("{{{}}}", entries.iter().map(|(k, v)| format!("{}:{}", json_string(k), canonical(v))).collect::<Vec<_>>().join(","))
        }
        Value::String(s) => json_string(s),
        Value::Number(n) => n.as_f64().map(number_text).unwrap_or_else(|| n.to_string()),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
    }
}

fn sorted(list: Option<&Value>) -> Value {
    let mut items: Vec<Value> = match list {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(s)) => s.chars().map(|c| Value::String(c.to_string())).collect(),
        _ => vec![],
    };
    items.sort_by(|a, b| utf16_cmp(&crate::js::js_string(Some(a)), &crate::js::js_string(Some(b))));
    Value::Array(items)
}

/// Hermes `mcp_schema_cache.config_fingerprint`.
pub fn mcp_fingerprint(config: &Map<String, Value>) -> String {
    let filters = config.get("tools").filter(|v| crate::js::truthy(Some(v)));
    let pick = |key: &str| config.get(key).cloned().unwrap_or(Value::Null);
    let args = config.get("args").filter(|v| crate::js::truthy(Some(v))).cloned().unwrap_or(Value::Array(vec![]));
    let mut raw = Map::new();
    raw.insert("command".into(), pick("command"));
    raw.insert("args".into(), args);
    raw.insert("url".into(), pick("url"));
    raw.insert("transport".into(), pick("transport"));
    raw.insert("tools_include".into(), sorted(crate::js::get(filters, "include").filter(|v| crate::js::truthy(Some(v)))));
    raw.insert("tools_exclude".into(), sorted(crate::js::get(filters, "exclude").filter(|v| crate::js::truthy(Some(v)))));
    hex::encode(Sha256::digest(canonical(&Value::Object(raw)).as_bytes()))[..16].to_string()
}

pub static TOOL_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.:/-]{1,200}$").unwrap());
pub static PARAMETER_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.$-]{1,100}$").unwrap());
static CONTROL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x00-\x1f]").unwrap());

#[derive(Serialize, Clone, Debug)]
pub struct Parameter {
    pub name: String,
    pub required: bool,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub parameters: Vec<Parameter>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpTools {
    pub source: &'static str,
    pub state: &'static str,
    pub recorded_at: Option<String>,
    pub truncated: bool,
    pub tools: Vec<Tool>,
}

fn tool(value: &Value) -> Option<Tool> {
    let name = value.get("name")?.as_str().filter(|n| TOOL_NAME.is_match(n))?;
    let schema = value.get("inputSchema");
    let required: Vec<&Value> = crate::js::get(schema, "required").and_then(Value::as_array).map(|r| r.iter().collect()).unwrap_or_default();
    // Names and parameter keys go back to the server exactly: they must match a strict pattern instead of
    // being masked (a masked name could never be called). Descriptions are free text and stay masked.
    let parameters = match crate::js::get(schema, "properties") {
        Some(Value::Object(properties)) => properties
            .iter()
            .filter(|(key, _)| PARAMETER_NAME.is_match(key))
            .take(100)
            .map(|(key, spec)| Parameter {
                name: key.clone(),
                required: required.iter().any(|r| r.as_str() == Some(key)),
                kind: spec.get("type").and_then(Value::as_str).map(|t| redact_str(t, 40)).unwrap_or_else(|| "no especificado".into()),
                description: spec.get("description").and_then(Value::as_str).map(|d| redact_str(d, 300)),
                options: spec.get("enum").and_then(Value::as_array).map(|items| {
                    items.iter().filter_map(Value::as_str).filter(|s| utf16_len(s) <= 200 && !CONTROL.is_match(s)).take(100).map(str::to_string).collect()
                }),
            })
            .collect(),
        _ => vec![],
    };
    Some(Tool { name: name.into(), description: redact(value.get("description"), 1600), parameters })
}

pub fn read_mcp_tools(root: &Path, home: &Path, name: &str, config: &Map<String, Value>) -> McpTools {
    let empty = |state| McpTools { source: "hermes-cache", state, recorded_at: None, truncated: false, tools: vec![] };
    let cache = match read_hermes_file(root, &home.join("cache/mcp_schema_cache.json"), 4 * 1024 * 1024) {
        Ok(data) => data,
        Err(error) => return empty(if error.kind() == ErrorKind::NotFound { "missing" } else { "unavailable" }),
    };
    let Ok(cache) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&cache)) else { return empty("unavailable") };
    let Some(entry) = cache.as_object().and_then(|c| c.get(name)).filter(|e| e.is_object() || e.is_array()) else { return empty("missing") };
    if entry.get("fingerprint").and_then(Value::as_str) != Some(mcp_fingerprint(config).as_str()) {
        return empty("changed");
    }
    let Some(tools) = entry.get("tools").and_then(Value::as_array) else { return empty("unavailable") };
    let written = entry.get("written_at").and_then(Value::as_f64).map(|s| s * 1000.0).filter(|w| w.is_finite());
    let recorded_at = written.filter(|w| w.abs() < 8.64e15).and_then(|w| iso_ms(w.trunc() as i64));
    let ttl = entry.get("ttl_ms").and_then(Value::as_f64);
    let expired = matches!((ttl, written), (Some(ttl), Some(written)) if now_ms() as f64 - written >= ttl);
    McpTools {
        source: "hermes-cache",
        state: if expired { "expired" } else { "cached" },
        recorded_at,
        truncated: tools.len() > 500,
        tools: tools.iter().take(500).filter_map(tool).collect(),
    }
}
