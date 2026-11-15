//! Read-only picture of the work Hermes' profiles do: each scheduled task with its latest runs (start, end,
//! status) and the tokens and estimated cost of the session each run opened (`cron_<task>_<date>_<time>`),
//! and every kanban card with its runs and the tokens of its session. Only names, titles (with credential-
//! like text hidden), states, times and counts: never prompts, card bodies, results, summaries or errors.

use std::collections::HashMap;
use std::path::Path;

use serde_json::{Map, Value, json};

use super::activity_log::token;
use super::catalog::ProfileTarget;
use super::database::{HermesDb, with_hermes_database};
use super::safe_read::redact;
use crate::js::{iso, iso_ms, number, parse_date_ms};

const RUNS_PER_TASK: usize = 20;
const WINDOW_DAYS: i64 = 30;
// A run and the session it opened start within seconds; ten minutes covers a slow start or a queue.
const PAIR_WINDOW_S: f64 = 600.0;
const CARDS: i64 = 300;

#[derive(Clone, Default)]
struct Usage {
    input: i64,
    output: i64,
    cost: f64,
    has_cost: bool,
}

impl Usage {
    fn add(&mut self, other: &Usage) {
        self.input += other.input;
        self.output += other.output;
        self.cost += other.cost;
        self.has_cost |= other.has_cost;
    }
    fn json(&self) -> Value {
        json!({ "input": self.input, "output": self.output, "costUsd": if self.has_cost { json!((self.cost * 10_000.0).round() / 10_000.0) } else { Value::Null } })
    }
}

struct Session {
    started: f64,
    ended: Option<f64>,
    usage: Usage,
}

fn seconds_of(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64().filter(|s| s.is_finite()),
        Some(Value::String(s)) => parse_date_ms(s).map(|ms| ms as f64 / 1000.0),
        _ => None,
    }
}

fn usage_of(row: &Map<String, Value>) -> Usage {
    let cost = row.get("cost").and_then(Value::as_f64);
    Usage { input: number(row.get("input")) as i64, output: number(row.get("output")) as i64, cost: cost.unwrap_or(0.0), has_cost: cost.is_some() }
}

/// The columns this reader needs from `sessions`, or None if the table lacks them.
fn session_columns(db: &HermesDb) -> Option<String> {
    let c = db.columns("sessions");
    if !["id", "started_at", "input_tokens", "output_tokens"].iter().all(|k| c.contains(*k)) {
        return None;
    }
    let ended = if c.contains("ended_at") { "ended_at" } else { "NULL" };
    let cost = if c.contains("actual_cost_usd") && c.contains("estimated_cost_usd") {
        "coalesce(actual_cost_usd, estimated_cost_usd)"
    } else if c.contains("estimated_cost_usd") {
        "estimated_cost_usd"
    } else {
        "NULL"
    };
    Some(format!("id, started_at, {ended} AS ended_at, input_tokens AS input, output_tokens AS output, {cost} AS cost"))
}

/// The sessions scheduled tasks opened in this profile, by task id (taken from the session id).
fn cron_sessions(root: &Path, home: &Path, since: f64) -> HashMap<String, Vec<Session>> {
    with_hermes_database(root, &home.join("state.db"), |db| {
        let Some(columns) = session_columns(db) else { return Ok(HashMap::new()) };
        let rows = db.all(&format!("SELECT {columns} FROM sessions WHERE id LIKE 'cron\\_%' ESCAPE '\\' AND started_at > ? ORDER BY started_at DESC LIMIT 2000"), [since])?;
        let mut by_task: HashMap<String, Vec<Session>> = HashMap::new();
        for row in rows {
            let Some(id) = row.get("id").and_then(Value::as_str) else { continue };
            // cron_<task>_<YYYYMMDD>_<HHMMSS>: the task id is what sits between the prefix and the date.
            let parts: Vec<&str> = id.splitn(2, '_').nth(1).unwrap_or("").rsplitn(3, '_').collect();
            if parts.len() != 3 {
                continue;
            }
            let Some(started) = seconds_of(row.get("started_at")) else { continue };
            by_task.entry(parts[2].to_string()).or_default().push(Session { started, ended: seconds_of(row.get("ended_at")), usage: usage_of(&row) });
        }
        Ok(by_task)
    })
    .ok()
    .flatten()
    .unwrap_or_default()
}

/// Sessions by id from a profile's state.db (the kanban cards' worker sessions).
fn sessions_by_id(root: &Path, home: &Path, ids: &[String]) -> HashMap<String, Usage> {
    if ids.is_empty() {
        return HashMap::new();
    }
    with_hermes_database(root, &home.join("state.db"), |db| {
        let Some(columns) = session_columns(db) else { return Ok(HashMap::new()) };
        let mut found = HashMap::new();
        for chunk in ids.chunks(100) {
            let marks = vec!["?"; chunk.len()].join(",");
            for row in db.all(&format!("SELECT {columns} FROM sessions WHERE id IN ({marks})"), rusqlite::params_from_iter(chunk.iter()))? {
                if let Some(id) = row.get("id").and_then(Value::as_str) {
                    found.insert(id.to_string(), usage_of(&row));
                }
            }
        }
        Ok(found)
    })
    .ok()
    .flatten()
    .unwrap_or_default()
}

fn executions(root: &Path, home: &Path, since: f64) -> HashMap<String, Vec<Map<String, Value>>> {
    with_hermes_database(root, &home.join("cron").join("executions.db"), |db| {
        let c = db.columns("executions");
        if !["job_id", "status", "started_at", "finished_at"].iter().all(|k| c.contains(*k)) {
            return Ok(HashMap::new());
        }
        // Never the error text, process details or delivery target.
        let mut by_task: HashMap<String, Vec<Map<String, Value>>> = HashMap::new();
        for row in db.all("SELECT job_id, status, started_at, finished_at FROM executions ORDER BY rowid DESC LIMIT 2000", [])? {
            let Some(task) = row.get("job_id").and_then(Value::as_str).map(str::to_string) else { continue };
            if seconds_of(row.get("started_at")).or_else(|| seconds_of(row.get("finished_at"))).is_some_and(|s| s >= since) {
                by_task.entry(task).or_default().push(row);
            }
        }
        // Newest first by when they ran, not by insertion order.
        let at = |row: &Map<String, Value>| seconds_of(row.get("started_at")).or_else(|| seconds_of(row.get("finished_at"))).unwrap_or(0.0);
        for runs in by_task.values_mut() {
            runs.sort_by(|a, b| at(b).total_cmp(&at(a)));
        }
        Ok(by_task)
    })
    .ok()
    .flatten()
    .unwrap_or_default()
}

/// Totals over the last day, week and month of a list of (start in seconds, duration, usage).
fn totals(runs: &[(f64, Option<f64>, Option<Usage>)], now_s: f64) -> Value {
    let mut out = Map::new();
    for (key, days) in [("24h", 1.0), ("7d", 7.0), ("30d", 30.0)] {
        let since = now_s - days * 86_400.0;
        let chosen: Vec<_> = runs.iter().filter(|(start, _, _)| *start >= since).collect();
        let mut usage = Usage::default();
        let mut measured = 0;
        for (_, _, run_usage) in &chosen {
            if let Some(u) = run_usage {
                usage.add(u);
                measured += 1;
            }
        }
        out.insert(
            key.into(),
            json!({ "runs": chosen.len(), "seconds": chosen.iter().filter_map(|(_, d, _)| *d).sum::<f64>().round(), "measured": measured, "tokens": usage.json() }),
        );
    }
    Value::Object(out)
}

fn task_list(root: &Path, profile: &ProfileTarget, now_s: f64) -> Value {
    let since = now_s - (WINDOW_DAYS * 86_400) as f64;
    let Some(data) = super::activity::raw_jobs(root, &profile.home) else { return Value::Null };
    let mut runs_by_task = executions(root, &profile.home, since);
    let mut sessions = cron_sessions(root, &profile.home, since);
    Value::Array(
        data.iter()
            .map(|job| {
                let id = job.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                let mut task_sessions = sessions.remove(&id).unwrap_or_default();
                let mut measured: Vec<(f64, Option<f64>, Option<Usage>)> = Vec::new();
                let mut runs = Vec::new();
                for row in runs_by_task.remove(&id).unwrap_or_default().into_iter().take(RUNS_PER_TASK) {
                    let started = seconds_of(row.get("started_at"));
                    let finished = seconds_of(row.get("finished_at"));
                    // The nearest session that started around the run; each session pairs with one run.
                    let pair = started.and_then(|s| {
                        task_sessions
                            .iter()
                            .enumerate()
                            .filter(|(_, session)| (session.started - s).abs() <= PAIR_WINDOW_S)
                            .min_by(|a, b| (a.1.started - s).abs().total_cmp(&(b.1.started - s).abs()))
                            .map(|(index, _)| index)
                    });
                    let session = pair.map(|index| task_sessions.swap_remove(index));
                    let seconds = match (started, finished) {
                        (Some(s), Some(f)) if f >= s => Some(f - s),
                        _ => session.as_ref().and_then(|x| Some(x.ended? - x.started)).filter(|d| *d >= 0.0),
                    };
                    let usage = session.as_ref().map(|x| x.usage.clone());
                    if let Some(start) = started.or(finished) {
                        measured.push((start, seconds, usage.clone()));
                    }
                    runs.push(json!({
                        "startedAt": iso(row.get("started_at")),
                        "finishedAt": iso(row.get("finished_at")),
                        "status": token(row.get("status")),
                        "seconds": seconds.map(f64::round),
                        "tokens": usage.as_ref().map(Usage::json),
                    }));
                }
                let name = redact(job.get("name"), 100);
                json!({
                    "id": Some(id.as_str()).filter(|id| super::activity::valid_id(id)),
                    "name": if name.is_empty() { "Tarea sin nombre".into() } else { name },
                    "enabled": job.get("enabled") == Some(&Value::Bool(true)),
                    "state": token(job.get("state")).unwrap_or_else(|| "unknown".into()),
                    "schedule": redact(job.get("schedule_display"), 80),
                    "lastStatus": token(job.get("last_status")),
                    "lastRunAt": iso(job.get("last_run_at")),
                    "nextRunAt": iso(job.get("next_run_at")),
                    "runs": runs,
                    "totals": totals(&measured, now_s),
                })
            })
            .collect(),
    )
}

fn board(root: &Path, profiles: &[ProfileTarget], now_s: f64) -> Value {
    let read = with_hermes_database(root, &root.join("kanban.db"), |db| {
        let c = db.columns("tasks");
        if !["id", "title", "assignee", "status", "created_at"].iter().all(|k| c.contains(*k)) {
            return Ok(None);
        }
        let pick = |name: &str| if c.contains(name) { name.to_string() } else { format!("NULL AS {name}") };
        // Title and state only: never the body, the result or the failure text.
        let sql = format!(
            "SELECT id, title, assignee, status, created_at, {}, {}, {}, {}, {} FROM tasks \
             WHERE status != 'archived' OR coalesce(completed_at, created_at) > ? ORDER BY created_at DESC LIMIT {CARDS}",
            pick("priority"), pick("created_by"), pick("started_at"), pick("completed_at"), pick("session_id")
        );
        let tasks = db.all(&sql, [now_s - (WINDOW_DAYS * 86_400) as f64])?;
        let r = db.columns("task_runs");
        let runs = if ["task_id", "status", "started_at"].iter().all(|k| r.contains(*k)) {
            let ended = if r.contains("ended_at") { "ended_at" } else { "NULL AS ended_at" };
            let outcome = if r.contains("outcome") { "outcome" } else { "NULL AS outcome" };
            let profile = if r.contains("profile") { "profile" } else { "NULL AS profile" };
            db.all(&format!("SELECT task_id, {profile}, status, {outcome}, started_at, {ended} FROM task_runs ORDER BY id DESC LIMIT 2000"), [])?
        } else {
            vec![]
        };
        Ok(Some((tasks, runs)))
    });
    let Ok(Some(Some((tasks, runs)))) = read else { return Value::Null };
    let mut runs_by_task: HashMap<String, Vec<Map<String, Value>>> = HashMap::new();
    for run in runs {
        if let Some(id) = run.get("task_id").and_then(Value::as_str) {
            runs_by_task.entry(id.to_string()).or_default().push(run);
        }
    }
    // Each card's worker session lives in the state.db of the profile that took it.
    let home_of = |name: &str| profiles.iter().find(|p| p.name == name).map(|p| p.home.clone());
    let mut wanted: HashMap<String, Vec<String>> = HashMap::new();
    for task in &tasks {
        if let (Some(assignee), Some(session)) = (task.get("assignee").and_then(Value::as_str), task.get("session_id").and_then(Value::as_str)) {
            wanted.entry(assignee.to_string()).or_default().push(session.to_string());
        }
    }
    let mut usage: HashMap<String, Usage> = HashMap::new();
    for (assignee, ids) in wanted {
        if let Some(home) = home_of(&assignee) {
            usage.extend(sessions_by_id(root, &home, &ids));
        }
    }
    let cards: Vec<Value> = tasks
        .iter()
        .map(|task| {
            let id = task.get("id").and_then(Value::as_str).unwrap_or("");
            let assignee = token(task.get("assignee"));
            let profile_id = assignee.as_deref().and_then(|name| profiles.iter().find(|p| p.name == name)).map(|p| p.id.clone());
            let card_runs: Vec<Value> = runs_by_task
                .remove(id)
                .unwrap_or_default()
                .into_iter()
                .take(RUNS_PER_TASK)
                .map(|run| {
                    let started = seconds_of(run.get("started_at"));
                    let ended = seconds_of(run.get("ended_at"));
                    let seconds = match (started, ended) {
                        (Some(s), Some(e)) if e >= s => Some((e - s).round()),
                        (Some(s), None) if token(run.get("status")).as_deref() == Some("running") => Some((now_s - s).max(0.0).round()),
                        _ => None,
                    };
                    json!({ "profile": token(run.get("profile")), "status": token(run.get("status")), "outcome": token(run.get("outcome")),
                        "startedAt": iso(run.get("started_at")), "endedAt": iso(run.get("ended_at")), "seconds": seconds })
                })
                .collect();
            let total: f64 = card_runs.iter().filter_map(|r| r.get("seconds").and_then(Value::as_f64)).sum();
            let title = redact(task.get("title"), 160);
            json!({
                "id": Some(id).filter(|id| super::activity::valid_id(id)),
                "title": if title.is_empty() { "Tarea sin título".into() } else { title },
                "assignee": assignee,
                "profileId": profile_id,
                "status": token(task.get("status")).unwrap_or_else(|| "unknown".into()),
                "priority": task.get("priority").and_then(Value::as_i64).unwrap_or(0),
                "createdBy": token(task.get("created_by")),
                "createdAt": iso(task.get("created_at")),
                "startedAt": iso(task.get("started_at")),
                "completedAt": iso(task.get("completed_at")),
                "runs": card_runs,
                "seconds": if total > 0.0 { json!(total) } else { Value::Null },
                "tokens": task.get("session_id").and_then(Value::as_str).and_then(|s| usage.get(s)).map(Usage::json),
            })
        })
        .collect();
    json!({ "cards": cards })
}

/// The work of every profile and the shared kanban board, read-only.
pub fn read_work(root: &Path, profiles: &[ProfileTarget], now_ms: i64) -> Value {
    let now_s = now_ms as f64 / 1000.0;
    let mut by_profile = Map::new();
    for profile in profiles {
        by_profile.insert(profile.id.clone(), json!({ "name": profile.name, "tasks": task_list(root, profile, now_s) }));
    }
    json!({ "schema": 1, "readAt": iso_ms(now_ms), "profiles": by_profile, "board": board(root, profiles, now_s) })
}
