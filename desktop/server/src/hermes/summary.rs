//! What the summary needs from Hermes: tokens and cost per profile and per project (the folder or git
//! repository a session worked in, by name only) and the words the user writes most. Read only; the text of
//! the user's messages is counted here and never leaves this module (user's decision, 13/11/2026).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use super::activity::{StampCache, file_stamp};
use super::catalog::ProfileTarget;
use super::database::with_hermes_database;
use crate::js::{iso_ms, number, slice_utf16, utf16_len};

const DAYS: i64 = 30;
const MAX_MESSAGES: i64 = 5000;
static STOPWORDS: LazyLock<HashSet<String>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../../../shared/stopwords.json")).expect("palabras vacías"));
// Words only: letters, 4 to 20 of them. Keys, tokens and links (digits, symbols, long runs) never count.
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{L}{4,20}").unwrap());
static LOOKS_LIKE_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{L}{21,}|[A-Za-z]+[0-9]|[0-9]+[A-Za-z]").unwrap());

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct WordCount {
    pub word: String,
    pub count: u64,
}

/// Adds the words of some texts to a tally, with the shared rules (the core's, for notes and questions).
pub fn tally_words<'a>(texts: impl IntoIterator<Item = &'a str>, counts: &mut HashMap<String, u64>) {
    for text in texts {
        for piece in text.split(char::is_whitespace).filter(|p| !p.is_empty()) {
            if utf16_len(piece) > 40 || LOOKS_LIKE_KEY.is_match(piece) {
                continue;
            }
            for found in WORD.find_iter(&piece.to_lowercase()) {
                let word = found.as_str();
                let mut chars = word.chars();
                let first = chars.next();
                let repeated = chars.all(|c| Some(c) == first);
                if !STOPWORDS.contains(word) && !repeated {
                    *counts.entry(word.to_string()).or_default() += 1;
                }
            }
        }
    }
}

/// Spanish order for ties: accents count less than letters, and «ñ» goes between «n» and «o».
fn spanish_key(word: &str) -> String {
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

pub fn top_words(counts: &HashMap<String, u64>, top: usize) -> Vec<WordCount> {
    let mut list: Vec<(&String, &u64)> = counts.iter().collect();
    list.sort_by(|a, b| b.1.cmp(a.1).then_with(|| spanish_key(a.0).cmp(&spanish_key(b.0))).then_with(|| a.0.cmp(b.0)));
    list.into_iter().take(top).map(|(word, count)| WordCount { word: word.clone(), count: *count }).collect()
}

fn project_name(place: Option<&Value>) -> Option<String> {
    let path = place?.as_str()?.trim().trim_end_matches('/');
    Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    pub project: String,
    pub tokens: f64,
    pub cost_usd: f64,
    pub sessions: f64,
}

#[derive(Clone)]
struct Read {
    profile: String,
    tokens: f64,
    cost_usd: f64,
    sessions: f64,
    last: Option<f64>,
    projects: Vec<ProjectUsage>,
    words: HashMap<String, u64>,
    messages: usize,
}

static CACHE: StampCache<Read> = LazyLock::new(Default::default);

fn add_project(list: &mut Vec<ProjectUsage>, name: &str, tokens: f64, cost: f64, sessions: f64) {
    match list.iter_mut().find(|p| p.project == name) {
        Some(p) => {
            p.tokens += tokens;
            p.cost_usd += cost;
            p.sessions += sessions;
        }
        None => list.push(ProjectUsage { project: name.into(), tokens, cost_usd: cost, sessions }),
    }
}

fn read_profile(root: &Path, profile: &str, home: &Path, now: i64) -> anyhow::Result<Option<Read>> {
    let file = home.join("state.db");
    let key = [file_stamp(&file), file_stamp(&home.join("state.db-wal")), (now / 600_000).to_string()].join("|");
    if let Some((cached_key, value)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&file)
        && *cached_key == key
    {
        return Ok(value.clone());
    }
    let value = with_hermes_database(root, &file, |db| {
        let s = db.columns("sessions");
        let m = db.columns("messages");
        if !s.contains("started_at") || !s.contains("id") {
            return Ok(None);
        }
        let since = (now - DAYS * 86_400_000) as f64 / 1000.0;
        let has = |column: &str| if s.contains(column) { column.to_string() } else { "0".into() };
        let tokens = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"]
            .iter()
            .map(|c| format!("coalesce({}, 0)", has(c)))
            .collect::<Vec<_>>()
            .join(" + ");
        let cost = if s.contains("actual_cost_usd") || s.contains("estimated_cost_usd") {
            format!("coalesce({}, {}, 0)", has("actual_cost_usd"), has("estimated_cost_usd"))
        } else {
            "0".into()
        };
        let place = if s.contains("git_repo_root") {
            "coalesce(nullif(git_repo_root, ''), cwd)"
        } else if s.contains("cwd") {
            "cwd"
        } else {
            "NULL"
        };
        let last = if s.contains("last_activity_at") { "coalesce(last_activity_at, started_at)" } else { "started_at" };
        let rows = db.all(
            &format!("SELECT {place} AS place, count(*) AS sessions, sum({tokens}) AS tokens, sum({cost}) AS cost, max({last}) AS last FROM sessions WHERE started_at > ? GROUP BY place"),
            [since],
        )?;
        let mut read = Read { profile: profile.into(), tokens: 0.0, cost_usd: 0.0, sessions: 0.0, last: None, projects: vec![], words: HashMap::new(), messages: 0 };
        for row in rows {
            let (used, spent, count) = (number(row.get("tokens")), number(row.get("cost")), number(row.get("sessions")));
            read.tokens += used;
            read.cost_usd += spent;
            read.sessions += count;
            if let Some(at) = row.get("last").and_then(Value::as_f64) {
                read.last = Some(read.last.unwrap_or(0.0).max(at));
            }
            if let Some(name) = project_name(row.get("place")) {
                add_project(&mut read.projects, &name, used, spent, count);
            }
        }
        if m.contains("role") && m.contains("content") && m.contains("timestamp") {
            // Only the tally is kept: the text is dropped as soon as it is counted.
            let texts: Vec<String> = db
                .all("SELECT content FROM messages WHERE role = 'user' AND timestamp > ? AND typeof(content) = 'text' ORDER BY timestamp DESC LIMIT ?", rusqlite::params![since, MAX_MESSAGES])?
                .into_iter()
                .map(|row| slice_utf16(row.get("content").and_then(Value::as_str).unwrap_or(""), 4000))
                .collect();
            tally_words(texts.iter().map(String::as_str), &mut read.words);
            read.messages = texts.len();
        }
        Ok(Some(read))
    })?
    .flatten();
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(file, (key, value.clone()));
    Ok(value)
}

fn cents(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

pub fn read_hermes_summary(root: &Path, profiles: &[ProfileTarget], now: i64) -> Value {
    let reads: Vec<Read> = profiles.iter().filter_map(|p| read_profile(root, &p.name, &p.home, now).ok().flatten()).collect();
    let mut projects = Vec::new();
    let mut words = HashMap::new();
    for read in &reads {
        for item in &read.projects {
            add_project(&mut projects, &item.project, item.tokens, item.cost_usd, item.sessions);
        }
        for (word, count) in &read.words {
            *words.entry(word.clone()).or_default() += count;
        }
    }
    let mut by_profile: Vec<Value> = reads
        .iter()
        .map(|r| {
            serde_json::json!({
                "profile": r.profile, "tokens": r.tokens, "costUsd": cents(r.cost_usd), "sessions": r.sessions,
                "lastActivityAt": r.last.filter(|s| s.is_finite()).and_then(|s| iso_ms((s * 1000.0).trunc() as i64)),
            })
        })
        .collect();
    by_profile.sort_by(|a, b| number(b.get("tokens")).total_cmp(&number(a.get("tokens"))));
    for p in &mut projects {
        p.cost_usd = cents(p.cost_usd);
    }
    projects.sort_by(|a, b| b.tokens.total_cmp(&a.tokens));
    projects.truncate(20);
    serde_json::json!({
        "readAt": iso_ms(now), "days": DAYS, "profiles": by_profile, "projects": projects,
        "words": top_words(&words, 40), "messagesCounted": reads.iter().map(|r| r.messages).sum::<usize>(),
    })
}
