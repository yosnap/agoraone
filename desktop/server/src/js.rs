//! Small helpers that keep the Rust port answering exactly like the former Node backend: JavaScript
//! truthiness and string conversion of JSON values, UTF-16 lengths, dates as `toISOString()` prints them,
//! and the short digests used for opaque identifiers.

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// First 24 hex characters of SHA-256: profile, MCP, space and vault identifiers, and file revisions.
pub fn digest(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))[..24].to_string()
}

/// JavaScript truthiness of an optional JSON value (`undefined` is None).
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `a || b` for JSON values.
pub fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if truthy(a) { a } else { b }
}

/// `value?.[key]` when `value` is an object.
pub fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|v| v.as_object()).and_then(|map| map.get(key))
}

/// A number as JavaScript prints it (integers without a decimal point).
pub fn number_text(f: f64) -> String {
    if f.is_nan() {
        "NaN".into()
    } else if f.is_infinite() {
        if f > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else if f.fract() == 0.0 && f.abs() < 1e21 {
        format!("{}", f as i128)
    } else {
        format!("{f}")
    }
}

/// `String(value)`.
pub fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.as_f64().map(number_text).unwrap_or_else(|| n.to_string()),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items.iter().map(|v| if v.is_null() { String::new() } else { js_string(Some(v)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `Number(value) || 0` for SQLite results.
pub fn number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().filter(|f| !f.is_nan()).unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(0.0),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    }
}

/// An integer JSON number (`Number.isInteger`).
pub fn integer(value: Option<&Value>) -> Option<i64> {
    let f = value?.as_f64()?;
    (f.fract() == 0.0 && f.is_finite() && f.abs() < 9.0e15).then_some(f as i64)
}

pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `text.slice(0, max)` counted in UTF-16 units, never splitting a character.
pub fn slice_utf16(text: &str, max: usize) -> String {
    let mut used = 0;
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        used += ch.len_utf16();
        if used > max {
            return text[..index].to_string();
        }
        end = index + ch.len_utf8();
    }
    text[..end].to_string()
}

/// Spanish order for ties: accents count less than letters, and «ñ» goes between «n» and «o».
pub fn spanish_key(word: &str) -> String {
    word.chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' => "a".into(),
            'é' | 'è' | 'ë' | 'ê' => "e".into(),
            'í' | 'ì' | 'ï' | 'î' => "i".into(),
            'ó' | 'ò' | 'ö' | 'ô' => "o".into(),
            'ú' | 'ù' | 'ü' | 'û' => "u".into(),
            'ç' => "c".into(),
            'ñ' => "n{".into(),
            other => other.to_string(),
        })
        .collect()
}

const MAX_MS: i64 = 8_640_000_000_000_000;

/// `Date.parse` for the formats Hermes writes: ISO with or without offset (none means local time, like
/// JavaScript), a plain date (UTC) and the space-separated variant.
pub fn parse_date_ms(text: &str) -> Option<i64> {
    let text = text.trim();
    if let Ok(date) = DateTime::parse_from_rfc3339(text) {
        return Some(date.timestamp_millis());
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f%z", "%Y-%m-%d %H:%M:%S%.f%z"] {
        if let Ok(date) = DateTime::parse_from_str(text, format) {
            return Some(date.timestamp_millis());
        }
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(text, format) {
            return Local.from_local_datetime(&naive).earliest().map(|d| d.timestamp_millis());
        }
    }
    NaiveDate::parse_from_str(text, "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(0, 0, 0)).map(|d| d.and_utc().timestamp_millis())
}

/// `new Date(ms).toISOString()`.
pub fn iso_ms(ms: i64) -> Option<String> {
    if ms.abs() > MAX_MS {
        return None;
    }
    Utc.timestamp_millis_opt(ms).single().map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// Hermes timestamps: epoch seconds (state.db, legacy records) or ISO strings with offset.
pub fn iso(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::Number(n)) => {
            let ms = n.as_f64()? * 1000.0;
            if !ms.is_finite() {
                return None;
            }
            iso_ms(ms.trunc() as i64)
        }
        Some(Value::String(s)) => parse_date_ms(s).and_then(iso_ms),
        _ => None,
    }
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

pub fn now_iso() -> String {
    iso_ms(now_ms()).unwrap_or_default()
}
