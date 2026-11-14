//! The activity log of a profile (last 24 h): times, origins and names only.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

use super::database::with_hermes_database;
use super::safe_read::redact;
use crate::js::{iso, js_string, parse_date_ms};

/// The activity log covers this window.
pub const EVENT_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9_-]{0,31}$").unwrap());

/// A short lowercase word as Hermes records states and origins; anything else is dropped.
pub fn token(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|s| WORD.is_match(s)).map(str::to_string)
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum EventBody {
    Session { source: String },
    Job { name: String, status: Option<String> },
    Mcp { server: String, calls: i64 },
    Link { name: String, state: &'static str },
}

#[derive(Serialize, Clone, Debug)]
pub struct Event {
    pub at: String,
    #[serde(flatten)]
    pub body: EventBody,
}

fn ms(at: &str) -> i64 {
    parse_date_ms(at).unwrap_or(i64::MIN)
}

fn job_name(job: &Map<String, Value>) -> String {
    let name = redact(job.get("name"), 100);
    if name.is_empty() { "Tarea sin nombre".into() } else { name }
}

/// Scheduled-job runs of the last 24 h: Hermes' execution history plus each job's last run. Names and
/// outcomes only.
pub fn job_runs(root: &Path, home: &Path, jobs: &[Map<String, Value>], now: i64) -> Vec<Event> {
    let since = now - EVENT_WINDOW_MS;
    let names: Vec<(String, String)> = jobs.iter().map(|job| (js_string(job.get("id")), job_name(job))).collect();
    let name_of = |id: &str| names.iter().rev().find(|(key, _)| key == id).map(|(_, name)| name.clone());
    // The job ID only pairs history with jobs.json; it never leaves the backend.
    let mut runs: Vec<(String, Event)> = with_hermes_database(root, &home.join("cron").join("executions.db"), |db| {
        let c = db.columns("executions");
        if !["job_id", "status", "started_at", "finished_at"].iter().all(|k| c.contains(*k)) {
            return Ok(vec![]);
        }
        // Never the error text, process details or delivery target.
        let rows = db.all("SELECT job_id, status, started_at, finished_at FROM executions ORDER BY rowid DESC LIMIT 100", [])?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let at = iso(row.get("finished_at")).or_else(|| iso(row.get("started_at")))?;
                if ms(&at) < since {
                    return None;
                }
                let job_id = js_string(row.get("job_id"));
                let name = name_of(&job_id).unwrap_or_else(|| "Tarea programada".into());
                Some((job_id, Event { at, body: EventBody::Job { name, status: token(row.get("status")) } }))
            })
            .collect())
    })
    .ok()
    .flatten()
    .unwrap_or_default();
    // jobs.json records the latest run even when the execution history does not; add it unless already listed.
    for job in jobs {
        let Some(at) = iso(job.get("last_run_at")) else { continue };
        if ms(&at) < since {
            continue;
        }
        let job_id = js_string(job.get("id"));
        if runs.iter().any(|(id, event)| *id == job_id && (ms(&event.at) - ms(&at)).abs() < 10 * 60_000) {
            continue;
        }
        let name = name_of(&job_id).unwrap_or_default();
        runs.push((job_id, Event { at, body: EventBody::Job { name, status: token(job.get("last_status")) } }));
    }
    runs.into_iter().map(|(_, event)| event).collect()
}

/// Merges a profile's events, newest first, keeping only the log window.
pub fn activity_log(now: i64, lists: Vec<Vec<Event>>) -> Vec<Event> {
    let mut events: Vec<Event> = lists
        .into_iter()
        .flatten()
        .filter(|event| {
            let at = ms(&event.at);
            at >= now - EVENT_WINDOW_MS && at <= now + 60_000 && !matches!(event.body, EventBody::Link { state: "unknown", .. })
        })
        .collect();
    events.sort_by(|a, b| b.at.cmp(&a.at));
    events.truncate(30);
    events
}
