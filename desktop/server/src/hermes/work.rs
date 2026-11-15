//! Read-only picture of the work Hermes' profiles do: each scheduled task with its runs (start, end, status)
//! and the tokens and estimated cost of the session each run opened (`cron_<task>_<date>_<time>`), and every
//! kanban card, on every board, with its runs and the tokens of the worker sessions (`source = 'kanban'`) of
//! the profile that ran them. A session Hermes continued after compressing its context counts with it. Only
//! names, titles (credential-like text hidden), states, times and counts: never prompts, card bodies,
//! results, summaries or errors.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::activity_log::token;
use super::catalog::ProfileTarget;
use super::database::{HermesDb, with_hermes_database};
use super::safe_read::redact;
use crate::js::{iso, iso_ms, number, parse_date_ms};

const RUNS_SHOWN: usize = 20;
const TASKS: usize = 200;
const WINDOW_DAYS: i64 = 30;
// A run and the session it opened start within seconds; ten minutes covers a slow start or a queue.
const PAIR_WINDOW_S: f64 = 600.0;
const CARDS: i64 = 300;
const PER_TASK: i64 = 2000;
const CONTINUATIONS: usize = 5;

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
    id: String,
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

/// Sessions matching `condition`, each with the tokens of the sessions Hermes continued it in.
fn load_sessions(db: &HermesDb, condition: &str, params: &[&dyn rusqlite::ToSql]) -> rusqlite::Result<Vec<Session>> {
    let Some(columns) = session_columns(db) else { return Ok(vec![]) };
    let mut found: Vec<Session> = db
        .all(&format!("SELECT {columns} FROM sessions WHERE {condition} ORDER BY started_at DESC LIMIT {PER_TASK}"), params)?
        .into_iter()
        .filter_map(|row| {
            Some(Session { id: row.get("id")?.as_str()?.to_string(), started: seconds_of(row.get("started_at"))?, ended: seconds_of(row.get("ended_at")), usage: usage_of(&row) })
        })
        .collect();
    if !db.columns("sessions").contains("parent_session_id") || found.is_empty() {
        return Ok(found);
    }
    // A compressed conversation goes on in a child session: its tokens belong to the run that opened the first.
    let mut root_of: HashMap<String, usize> = found.iter().enumerate().map(|(index, s)| (s.id.clone(), index)).collect();
    let mut frontier: Vec<String> = found.iter().map(|s| s.id.clone()).collect();
    for _ in 0..CONTINUATIONS {
        let mut next = Vec::new();
        for chunk in frontier.chunks(100) {
            let marks = vec!["?"; chunk.len()].join(",");
            let rows = db.all(&format!("SELECT {columns}, parent_session_id AS parent FROM sessions WHERE parent_session_id IN ({marks})"), rusqlite::params_from_iter(chunk.iter()))?;
            for row in rows {
                let (Some(id), Some(parent)) = (row.get("id").and_then(Value::as_str), row.get("parent").and_then(Value::as_str)) else { continue };
                let Some(&root) = root_of.get(parent) else { continue };
                if root_of.contains_key(id) {
                    continue;
                }
                found[root].usage.add(&usage_of(&row));
                if let Some(end) = seconds_of(row.get("ended_at")) {
                    found[root].ended = Some(found[root].ended.map_or(end, |e| e.max(end)));
                }
                root_of.insert(id.to_string(), root);
                next.push(id.to_string());
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    Ok(found)
}

/// Escapes `%`, `_` and `\` for a LIKE pattern with `ESCAPE '\'`.
fn like_literal(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// The task id inside a cron session id: cron_<task>_<YYYYMMDD>_<HHMMSS> (the task id may hold underscores).
fn task_of_session(id: &str) -> Option<&str> {
    let rest = id.strip_prefix("cron_")?;
    let mut parts = rest.rsplitn(3, '_');
    let (_time, _date, task) = (parts.next()?, parts.next()?, parts.next()?);
    Some(task)
}

/// The nearest session that started around `start`; each session pairs with one run only.
fn take_nearest(sessions: &mut Vec<Session>, start: f64) -> Option<Session> {
    let index = sessions
        .iter()
        .enumerate()
        .filter(|(_, session)| (session.started - start).abs() <= PAIR_WINDOW_S)
        .min_by(|a, b| (a.1.started - start).abs().total_cmp(&(b.1.started - start).abs()))
        .map(|(index, _)| index)?;
    Some(sessions.swap_remove(index))
}

/// Totals over the last day, week and month of (start in seconds, duration, usage) entries.
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

fn is_running(status: Option<&str>) -> bool {
    matches!(status, Some("running" | "claimed"))
}

/// One scheduled task's runs in the window, newest first, each paired with its session.
fn task_runs(root: &Path, home: &Path, task: &str, since: f64, now_s: f64) -> (Vec<Value>, Value) {
    let rows = with_hermes_database(root, &home.join("cron").join("executions.db"), |db| {
        let c = db.columns("executions");
        if !["job_id", "status", "started_at", "finished_at"].iter().all(|k| c.contains(*k)) {
            return Ok(vec![]);
        }
        let claimed = if c.contains("claimed_at") { "claimed_at" } else { "NULL AS claimed_at" };
        // Never the error text, process details or delivery target.
        db.all(&format!("SELECT status, started_at, finished_at, {claimed} FROM executions WHERE job_id = ? ORDER BY rowid DESC LIMIT {PER_TASK}"), [task])
    })
    .ok()
    .flatten()
    .unwrap_or_default();
    let pattern = format!("cron\\_{}\\_%", like_literal(task));
    let mut sessions: Vec<Session> = with_hermes_database(root, &home.join("state.db"), |db| {
        load_sessions(db, "id LIKE ? ESCAPE '\\' AND started_at > ?", &[&pattern, &(since - PAIR_WINDOW_S)])
    })
    .ok()
    .flatten()
    .unwrap_or_default()
    .into_iter()
    .filter(|s| task_of_session(&s.id) == Some(task))
    .collect();
    let mut runs: Vec<(f64, Map<String, Value>)> = rows
        .into_iter()
        .filter_map(|row| {
            let at = seconds_of(row.get("started_at")).or_else(|| seconds_of(row.get("claimed_at"))).or_else(|| seconds_of(row.get("finished_at")))?;
            (at >= since).then_some((at, row))
        })
        .collect();
    runs.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut measured = Vec::new();
    let mut shown = Vec::new();
    for (at, row) in runs {
        let started = seconds_of(row.get("started_at"));
        let finished = seconds_of(row.get("finished_at"));
        let status = token(row.get("status"));
        let session = started.and_then(|s| take_nearest(&mut sessions, s));
        let seconds = match (started, finished) {
            (Some(s), Some(f)) if f >= s => Some(f - s),
            (Some(s), None) if is_running(status.as_deref()) => Some((now_s - s).max(0.0)),
            _ => session.as_ref().and_then(|x| Some(x.ended? - x.started)).filter(|d| *d >= 0.0),
        };
        let usage = session.map(|x| x.usage);
        if shown.len() < RUNS_SHOWN {
            shown.push(json!({
                "startedAt": iso(row.get("started_at")).or_else(|| iso(row.get("claimed_at"))),
                "finishedAt": iso(row.get("finished_at")),
                "status": status,
                "seconds": seconds.map(f64::round),
                "tokens": usage.as_ref().map(Usage::json),
            }));
        }
        measured.push((at, seconds, usage));
    }
    (shown, totals(&measured, now_s))
}

fn task_list(root: &Path, profile: &ProfileTarget, now_s: f64) -> Value {
    let since = now_s - (WINDOW_DAYS * 86_400) as f64;
    let Some(data) = super::activity::raw_jobs(root, &profile.home, TASKS) else { return Value::Null };
    Value::Array(
        data.iter()
            .map(|job| {
                let id = job.get("id").and_then(Value::as_str).filter(|id| super::activity::valid_id(id));
                let (runs, totals) = match id {
                    Some(id) => task_runs(root, &profile.home, id, since, now_s),
                    None => (vec![], totals(&[], now_s)),
                };
                let name = redact(job.get("name"), 100);
                json!({
                    "id": id,
                    "name": if name.is_empty() { "Tarea sin nombre".into() } else { name },
                    "enabled": job.get("enabled") == Some(&Value::Bool(true)),
                    "state": token(job.get("state")).unwrap_or_else(|| "unknown".into()),
                    "schedule": redact(job.get("schedule_display"), 80),
                    "lastStatus": token(job.get("last_status")),
                    "lastRunAt": iso(job.get("last_run_at")),
                    "nextRunAt": iso(job.get("next_run_at")),
                    "runs": runs,
                    "totals": totals,
                })
            })
            .collect(),
    )
}

/// Every board's database: `default` at the root (as Hermes keeps it), the others under kanban/boards/<slug>.
fn boards(root: &Path) -> Vec<(String, PathBuf)> {
    let mut found = vec![("default".to_string(), root.join("kanban.db"))];
    if let Ok(entries) = fs::read_dir(root.join("kanban").join("boards")) {
        let mut others: Vec<(String, PathBuf)> = entries
            .flatten()
            .filter_map(|entry| {
                let slug = entry.file_name().to_string_lossy().to_string();
                (super::activity::valid_id(&slug) && slug != "default").then(|| (slug, entry.path().join("kanban.db")))
            })
            .collect();
        others.sort();
        found.extend(others);
    }
    found
}

type BoardRows = (Vec<Map<String, Value>>, Vec<Map<String, Value>>);

fn board_rows(root: &Path, file: &Path, since: f64) -> Option<BoardRows> {
    with_hermes_database(root, file, |db| {
        let c = db.columns("tasks");
        if !["id", "title", "assignee", "status", "created_at"].iter().all(|k| c.contains(*k)) {
            return Ok(None);
        }
        let pick = |name: &str| if c.contains(name) { name.to_string() } else { format!("NULL AS {name}") };
        // Title and state only: never the body, the result or the failure text.
        let sql = format!(
            "SELECT id, title, assignee, status, created_at, {}, {}, {}, {} FROM tasks \
             WHERE status != 'archived' OR coalesce(completed_at, created_at) > ? ORDER BY created_at DESC LIMIT {CARDS}",
            pick("priority"), pick("created_by"), pick("started_at"), pick("completed_at")
        );
        let tasks = db.all(&sql, [since])?;
        let r = db.columns("task_runs");
        let runs = if ["task_id", "status", "started_at"].iter().all(|k| r.contains(*k)) {
            let pick = |name: &str| if r.contains(name) { name.to_string() } else { format!("NULL AS {name}") };
            db.all(&format!("SELECT task_id, {}, status, {}, started_at, {} FROM task_runs WHERE started_at > ? ORDER BY id DESC LIMIT 5000", pick("profile"), pick("outcome"), pick("ended_at")), [since])?
        } else {
            vec![]
        };
        Ok(Some((tasks, runs)))
    })
    .ok()
    .flatten()
    .flatten()
}

fn board(root: &Path, profiles: &[ProfileTarget], now_s: f64) -> Value {
    let since = now_s - (WINDOW_DAYS * 86_400) as f64;
    let read: Vec<(String, BoardRows)> = boards(root).into_iter().filter_map(|(slug, file)| Some((slug, board_rows(root, &file, since)?))).collect();
    if read.is_empty() {
        return Value::Null;
    }
    // Worker sessions of each profile that ran a card, to pair with each run by its start.
    let mut workers: HashMap<String, Vec<Session>> = HashMap::new();
    for (_, (_, runs)) in &read {
        for run in runs {
            if let Some(name) = token(run.get("profile")) {
                if workers.contains_key(&name) {
                    continue;
                }
                let home = profiles.iter().find(|p| p.name == name).map(|p| p.home.clone());
                let found = home
                    .and_then(|home| {
                        with_hermes_database(root, &home.join("state.db"), |db| {
                            if !db.columns("sessions").contains("source") {
                                return Ok(vec![]);
                            }
                            load_sessions(db, "source = 'kanban' AND started_at > ?", &[&(since - PAIR_WINDOW_S)])
                        })
                        .ok()
                        .flatten()
                    })
                    .unwrap_or_default();
                workers.insert(name, found);
            }
        }
    }
    let mut cards: Vec<(f64, Value)> = Vec::new();
    for (slug, (tasks, runs)) in read {
        let mut runs_by_task: HashMap<String, Vec<Map<String, Value>>> = HashMap::new();
        for run in runs {
            if let Some(id) = run.get("task_id").and_then(Value::as_str) {
                runs_by_task.entry(id.to_string()).or_default().push(run);
            }
        }
        for task in tasks {
            let id = task.get("id").and_then(Value::as_str).unwrap_or("");
            let assignee = token(task.get("assignee"));
            let profile_id = assignee.as_deref().and_then(|name| profiles.iter().find(|p| p.name == name)).map(|p| p.id.clone());
            let mut usage = Usage::default();
            let mut paired = false;
            let mut total: Option<f64> = None;
            let card_runs: Vec<Value> = runs_by_task
                .remove(id)
                .unwrap_or_default()
                .into_iter()
                .enumerate()
                .filter_map(|(index, run)| {
                    let started = seconds_of(run.get("started_at"));
                    let ended = seconds_of(run.get("ended_at"));
                    let status = token(run.get("status"));
                    let seconds = match (started, ended) {
                        (Some(s), Some(e)) if e >= s => Some((e - s).round()),
                        (Some(s), None) if is_running(status.as_deref()) => Some((now_s - s).max(0.0).round()),
                        _ => None,
                    };
                    if let Some(d) = seconds {
                        total = Some(total.unwrap_or(0.0) + d);
                    }
                    let profile = token(run.get("profile"));
                    if let (Some(name), Some(s)) = (profile.as_deref(), started)
                        && let Some(session) = workers.get_mut(name).and_then(|list| take_nearest(list, s))
                    {
                        usage.add(&session.usage);
                        paired = true;
                    }
                    (index < RUNS_SHOWN).then(|| {
                        json!({ "profile": profile, "status": status, "outcome": token(run.get("outcome")),
                            "startedAt": iso(run.get("started_at")), "endedAt": iso(run.get("ended_at")), "seconds": seconds })
                    })
                })
                .collect();
            let title = redact(task.get("title"), 160);
            let created = seconds_of(task.get("created_at")).unwrap_or(0.0);
            cards.push((
                created,
                json!({
                    "id": Some(id).filter(|id| super::activity::valid_id(id)),
                    "board": slug,
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
                    "seconds": total,
                    "tokens": if paired { usage.json() } else { Value::Null },
                }),
            ));
        }
    }
    cards.sort_by(|a, b| b.0.total_cmp(&a.0));
    json!({ "cards": cards.into_iter().map(|(_, card)| card).collect::<Vec<_>>() })
}

/// The work of every profile and of every kanban board, read-only.
pub fn read_work(root: &Path, profiles: &[ProfileTarget], now_ms: i64) -> Value {
    let now_s = now_ms as f64 / 1000.0;
    let mut by_profile = Map::new();
    for profile in profiles {
        by_profile.insert(profile.id.clone(), json!({ "name": profile.name, "tasks": task_list(root, profile, now_s) }));
    }
    json!({ "schema": 1, "readAt": iso_ms(now_ms), "profiles": by_profile, "board": board(root, profiles, now_s) })
}
