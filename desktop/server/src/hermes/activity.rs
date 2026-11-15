//! Read-only snapshot of what Hermes records about its own activity: gateway state, platform links per
//! profile, sessions by origin, tool and MCP usage, scheduled jobs and kanban. Never message content,
//! prompts, chat ids or session titles.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::activity_log::{EVENT_WINDOW_MS, Event, EventBody, activity_log, job_runs, token};
use super::catalog::ProfileTarget;
use super::database::with_hermes_database;
use super::safe_read::{decode_utf8, read_hermes_file, redact};
use crate::js::{get, integer, iso, iso_ms, number, parse_date_ms};

// Hermes itself treats its runtime status as stale after 120 s (gateway/status.py).
const STALE_AFTER_MS: i64 = 120_000;
const USAGE_DAYS: i64 = 30;
static TOOL_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,96}$").unwrap());
static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,80}$").unwrap());
static SERVER_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9_]").unwrap());

/// Hermes registers MCP tools as `mcp__<server>__<tool>`, with non-alphanumerics in the server name replaced by `_`.
pub fn mcp_server_key(name: &str) -> String {
    SERVER_KEY.replace_all(name, "_").into_owned()
}

fn json_file(root: &Path, file: &Path, limit: u64) -> Option<Value> {
    let data = read_hermes_file(root, file, limit).ok()?;
    let value: Value = serde_json::from_str(&decode_utf8(data)?).ok()?;
    (value.is_object() || value.is_array()).then_some(value)
}

fn alive(pid: Option<&Value>) -> bool {
    let Some(pid) = integer(pid).filter(|p| *p > 1 && *p <= i32::MAX as i64) else { return false };
    // SAFETY: kill with signal 0 only checks whether the process exists.
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(x), Some(y)) => x == y,
        (None, None) => true,
        _ => false,
    }
}

struct Gateway {
    info: Value,
    state: Option<Value>,
    fresh: bool,
}

fn missing_gateway() -> Gateway {
    Gateway { info: json!({ "state": "missing", "detail": null, "updatedAt": null, "activeAgents": null }), state: None, fresh: false }
}

fn gateway(root: &Path, now: i64) -> Gateway {
    let Some(state) = json_file(root, &root.join("gateway_state.json"), 256 * 1024) else { return missing_gateway() };
    let beat = json_file(root, &root.join("state").join("gateway.heartbeat"), 4096);
    let beat_at = if same(get(beat.as_ref(), "pid"), state.get("pid")) { get(beat.as_ref(), "updated_at") } else { None };
    let updated = [state.get("updated_at"), beat_at].into_iter().flatten().filter_map(Value::as_str).filter_map(parse_date_ms).max();
    let fresh = updated.is_some_and(|u| now - u < STALE_AFTER_MS);
    let phase = token(state.get("gateway_state"));
    let serving = matches!(phase.as_deref(), Some("running" | "degraded"));
    let is_alive = alive(state.get("pid"));
    let running = is_alive && serving;
    let label = if !is_alive {
        "stopped"
    } else if !fresh {
        "stale"
    } else if running {
        "running"
    } else {
        "stopped"
    };
    let agents = integer(state.get("active_agents")).filter(|n| running && fresh && *n >= 0);
    let info = json!({
        "state": label,
        "detail": phase.filter(|p| p != "running"),
        "updatedAt": updated.and_then(iso_ms),
        "activeAgents": agents,
    });
    Gateway { info, state: Some(state), fresh: fresh && running }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct PlatformLink {
    name: String,
    state: &'static str,
    updated_at: Option<String>,
}

fn platforms(state: Option<&Value>, fresh: bool, profile: &str) -> Vec<PlatformLink> {
    let Some(Value::Object(entries)) = get(state, "platforms") else { return vec![] };
    entries
        .iter()
        .filter_map(|(key, value)| {
            // Keys are "telegram" for the default profile and "<profile>:telegram" for the others.
            let (owner, name) = if key.contains(':') {
                let mut parts = key.split(':');
                (parts.next().unwrap_or(""), parts.next().unwrap_or(""))
            } else {
                ("default", key.as_str())
            };
            let name = token(Some(&Value::String(name.into())))?;
            if owner != profile || !value.is_object() {
                return None;
            }
            let raw = token(value.get("state"));
            let link = if !fresh {
                "unknown"
            } else if value.get("needs_attention") == Some(&Value::Bool(true)) {
                "attention"
            } else {
                match raw.as_deref() {
                    Some("connected") => "connected",
                    Some("retrying" | "connecting") => "retrying",
                    _ => "disconnected",
                }
            };
            Some(PlatformLink { name, state: link, updated_at: iso(value.get("updated_at")) })
        })
        .take(20)
        .collect()
}

struct Sessions {
    last_activity_at: Option<String>,
    recent: Vec<Value>,
    started: Vec<Event>,
}

fn sessions(root: &Path, home: &Path, now: i64) -> anyhow::Result<Option<Sessions>> {
    Ok(with_hermes_database(root, &home.join("state.db"), |db| {
        let c = db.columns("sessions");
        if !c.contains("source") || !c.contains("started_at") {
            return Ok(None);
        }
        // Only timestamps and origin counts: no titles, content, prompts or chat identifiers.
        let at = if c.contains("last_activity_at") { "coalesce(last_activity_at, started_at)" } else { "started_at" };
        let last = db.get(&format!("SELECT max({at}) AS last FROM sessions"), [])?;
        let day = (now - 86_400_000) as f64 / 1000.0;
        let recent = db
            .all(&format!("SELECT source, count(*) AS sessions FROM sessions WHERE {at} > ? GROUP BY source ORDER BY sessions DESC LIMIT 12"), [day])?
            .into_iter()
            .filter_map(|row| Some(json!({ "source": token(row.get("source"))?, "sessions": number(row.get("sessions")) as i64 })))
            .collect();
        let window = (now - EVENT_WINDOW_MS) as f64 / 1000.0;
        let started = db
            .all("SELECT source, started_at FROM sessions WHERE started_at > ? ORDER BY started_at DESC LIMIT 30", [window])?
            .into_iter()
            .filter_map(|row| Some(Event { at: iso(row.get("started_at"))?, body: EventBody::Session { source: token(row.get("source"))? } }))
            .collect();
        Ok(Some(Sessions { last_activity_at: iso(last.as_ref().and_then(|r| r.get("last"))), recent, started }))
    })?
    .flatten())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ToolUse {
    name: String,
    calls: i64,
    last_used_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct McpUse {
    name: String,
    calls: i64,
    last_used_at: Option<String>,
    tools: Vec<ToolUse>,
}

#[derive(Clone)]
struct ToolRecords {
    usage: Value,
    mcp_hours: Vec<Event>,
}

// state.db only changes when its file or WAL changes; reuse the aggregate meanwhile (10-minute window granularity).
/// A per-file cache keyed by the file's stamp: the stamp it was read at and what was read.
pub type StampCache<T> = LazyLock<Mutex<HashMap<PathBuf, (String, Option<T>)>>>;
static USAGE_CACHE: StampCache<ToolRecords> = LazyLock::new(Default::default);

pub fn file_stamp(file: &Path) -> String {
    fs::metadata(file)
        .map(|m| format!("{}:{}", m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0), m.len()))
        .unwrap_or_else(|_| "-".into())
}

/// Splits `mcp__<server>__<tool>` using the declared server keys first, so names containing `__` resolve correctly.
fn split_mcp(name: &str, declared: &[String]) -> Option<(String, String)> {
    if let Some(key) = declared.iter().find(|server| name.starts_with(&format!("mcp__{server}__"))) {
        return Some((key.clone(), name[key.len() + 7..].to_string()));
    }
    let rest = name.strip_prefix("mcp__")?;
    // Lazy `(.+?)__(.+)`: the first "__" after at least one character, with something after it.
    let at = rest.char_indices().skip(1).find(|(i, _)| rest[*i..].starts_with("__") && rest.len() > i + 2).map(|(i, _)| i)?;
    Some((rest[..at].to_string(), rest[at + 2..].to_string()))
}

fn by_recent(a: &(i64, Option<String>), b: &(i64, Option<String>)) -> std::cmp::Ordering {
    let text = |v: &Option<String>| v.clone().unwrap_or_else(|| "null".into());
    b.0.cmp(&a.0).then_with(|| text(&b.1).cmp(&text(&a.1)))
}

fn tool_records(root: &Path, home: &Path, declared_names: &[String], now: i64) -> anyhow::Result<Option<ToolRecords>> {
    let file = home.join("state.db");
    let mut declared: Vec<String> = declared_names.iter().map(|n| mcp_server_key(n)).collect();
    declared.sort_by_key(|server| std::cmp::Reverse(server.len()));
    let key = [file_stamp(&file), file_stamp(&home.join("state.db-wal")), (now / 600_000).to_string(), declared.join(",")].join("|");
    if let Some((cached_key, value)) = USAGE_CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&file)
        && *cached_key == key
    {
        return Ok(value.clone());
    }
    let value = with_hermes_database(root, &file, |db| {
        let c = db.columns("messages");
        if !["tool_name", "timestamp", "role"].iter().all(|k| c.contains(*k)) {
            return Ok(None);
        }
        // Compaction leaves cloned rows behind: count each call once by its call ID when Hermes records it.
        let call = if c.contains("tool_call_id") && c.contains("session_id") { "session_id || '|' || coalesce(tool_call_id, rowid)" } else { "rowid" };
        // Tool names and call times only: never arguments, results or message content.
        let since = (now - USAGE_DAYS * 86_400_000) as f64 / 1000.0;
        let rows: Vec<ToolUse> = db
            .all(&format!("SELECT tool_name AS name, count(DISTINCT CASE WHEN timestamp > ? THEN {call} END) AS calls, max(timestamp) AS last FROM messages WHERE role = 'tool' AND tool_name IS NOT NULL AND tool_name != '' GROUP BY tool_name LIMIT 500"), [since])?
            .into_iter()
            .filter_map(|row| {
                let name = row.get("name").and_then(Value::as_str).filter(|n| TOOL_NAME.is_match(n))?;
                Some(ToolUse { name: name.into(), calls: number(row.get("calls")) as i64, last_used_at: iso(row.get("last")) })
            })
            .collect();
        let order = |a: &ToolUse, b: &ToolUse| by_recent(&(a.calls, a.last_used_at.clone()), &(b.calls, b.last_used_at.clone()));
        let mut servers: Vec<(String, Vec<ToolUse>)> = Vec::new();
        let mut tools = Vec::new();
        for row in rows {
            let Some((server, tool)) = split_mcp(&row.name, &declared) else {
                tools.push(row);
                continue;
            };
            let entry = match servers.iter().position(|(name, _)| *name == server) {
                Some(index) => &mut servers[index].1,
                None => {
                    servers.push((server, Vec::new()));
                    &mut servers.last_mut().unwrap().1
                }
            };
            entry.push(ToolUse { name: tool, ..row });
        }
        let mut mcp: Vec<McpUse> = servers
            .into_iter()
            .map(|(name, mut list)| {
                let calls = list.iter().map(|t| t.calls).sum();
                let last_used_at = list.iter().filter_map(|t| t.last_used_at.clone()).max();
                list.sort_by(order);
                list.truncate(12);
                McpUse { name, calls, last_used_at, tools: list }
            })
            .collect();
        mcp.sort_by(|a, b| by_recent(&(a.calls, a.last_used_at.clone()), &(b.calls, b.last_used_at.clone())));
        mcp.truncate(30);
        tools.sort_by(order);
        tools.truncate(12);
        // Activity log: MCP calls of the last 24 h grouped by server and hour.
        let window = (now - EVENT_WINDOW_MS) as f64 / 1000.0;
        let mut hours: Vec<(String, Event)> = Vec::new();
        let sql = format!(r"SELECT tool_name AS name, CAST(timestamp / 3600 AS INTEGER) AS hour, count(DISTINCT {call}) AS calls, max(timestamp) AS last FROM messages WHERE role = 'tool' AND tool_name LIKE 'mcp\_\_%' ESCAPE '\' AND timestamp > ? GROUP BY tool_name, hour");
        for row in db.all(&sql, [window])? {
            let server = row.get("name").and_then(Value::as_str).filter(|n| TOOL_NAME.is_match(n)).and_then(|n| split_mcp(n, &declared)).map(|s| s.0);
            let (Some(server), Some(at)) = (server, iso(row.get("last"))) else { continue };
            let calls = number(row.get("calls")) as i64;
            let slot = format!("{server}|{}", crate::js::js_string(row.get("hour")));
            match hours.iter_mut().find(|(key, _)| *key == slot) {
                None => hours.push((slot, Event { at, body: EventBody::Mcp { server, calls } })),
                Some((_, entry)) => {
                    if let EventBody::Mcp { calls: total, .. } = &mut entry.body {
                        *total += calls;
                    }
                    if at > entry.at {
                        entry.at = at;
                    }
                }
            }
        }
        Ok(Some(ToolRecords { usage: json!({ "windowDays": USAGE_DAYS, "tools": tools, "mcp": mcp }), mcp_hours: hours.into_iter().map(|(_, e)| e).collect() }))
    })?
    .flatten();
    USAGE_CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(file, (key, value.clone()));
    Ok(value)
}

/// A profile's scheduled tasks as Hermes stores them (the first 20); callers pick which fields leave.
pub(crate) fn raw_jobs(root: &Path, home: &Path) -> Option<Vec<Map<String, Value>>> {
    let data = json_file(root, &home.join("cron").join("jobs.json"), 1024 * 1024)?;
    let list = match &data {
        Value::Array(items) => items.clone(),
        _ => data.get("jobs").and_then(Value::as_array).cloned().unwrap_or_default(),
    };
    Some(
        list.into_iter()
            .take(20)
            .filter_map(|job| match job {
                Value::Object(map) => Some(map),
                Value::Array(_) => Some(Map::new()),
                _ => None,
            })
            .collect(),
    )
}

/// A Hermes identifier safe to send to the interface (tasks, cards).
pub(crate) fn valid_id(id: &str) -> bool {
    ID.is_match(id)
}

fn jobs(list: Option<&Vec<Map<String, Value>>>) -> Value {
    let Some(list) = list else { return Value::Null };
    // Name and schedule only; the job prompt, origin and delivery target are never read.
    Value::Array(
        list.iter()
            .map(|job| {
                let name = redact(job.get("name"), 100);
                json!({
                    "id": job.get("id").and_then(Value::as_str).filter(|id| ID.is_match(id)),
                    "name": if name.is_empty() { "Tarea sin nombre".into() } else { name },
                    "enabled": job.get("enabled") == Some(&Value::Bool(true)),
                    "state": token(job.get("state")).unwrap_or_else(|| "unknown".into()),
                    "schedule": redact(job.get("schedule_display"), 80),
                    "lastStatus": token(job.get("last_status")),
                    "lastRunAt": iso(job.get("last_run_at")),
                    "nextRunAt": iso(job.get("next_run_at")),
                })
            })
            .collect(),
    )
}

fn board(root: &Path, profile: &str) -> anyhow::Result<Option<Value>> {
    Ok(with_hermes_database(root, &root.join("kanban.db"), |db| {
        let c = db.columns("tasks");
        if !["title", "assignee", "status"].iter().all(|k| c.contains(*k)) {
            return Ok(None);
        }
        let by_status: Vec<Value> = db
            .all("SELECT status, count(*) AS count FROM tasks WHERE assignee = ? GROUP BY status", [profile])?
            .into_iter()
            .filter_map(|row| Some(json!({ "status": token(row.get("status"))?, "count": number(row.get("count")) as i64 })))
            .collect();
        let id = if c.contains("id") { "id, " } else { "" };
        let open: Vec<Value> = db
            .all(&format!("SELECT {id}title, status FROM tasks WHERE assignee = ? AND status NOT IN ('done', 'archived') ORDER BY rowid DESC LIMIT 30"), [profile])?
            .into_iter()
            .map(|row| {
                let title = redact(row.get("title"), 120);
                json!({
                    "id": row.get("id").and_then(Value::as_str).filter(|id| ID.is_match(id)),
                    "title": if title.is_empty() { "Tarea sin título".into() } else { title },
                    "status": token(row.get("status")).unwrap_or_else(|| "unknown".into()),
                })
            })
            .collect();
        Ok(Some(json!({ "byStatus": by_status, "open": open })))
    })?
    .flatten())
}

/// Read-only snapshot of what Hermes records about its own activity.
pub fn read_activity(root: &Path, profiles: &[ProfileTarget], now: i64) -> Value {
    let live = gateway(root, now);
    let mut result = Map::new();
    for profile in profiles {
        let recorded = sessions(root, &profile.home, now).ok().flatten();
        let tools = tool_records(root, &profile.home, &profile.mcp, now).ok().flatten();
        let job_list = raw_jobs(root, &profile.home);
        let links = platforms(live.state.as_ref(), live.fresh, &profile.name);
        let link_events =
            links.iter().filter_map(|l| Some(Event { at: l.updated_at.clone()?, body: EventBody::Link { name: l.name.clone(), state: l.state } })).collect();
        let runs = job_runs(root, &profile.home, job_list.as_deref().unwrap_or(&[]), now);
        let (last, recent, started) = match recorded {
            Some(s) => (s.last_activity_at, s.recent, s.started),
            None => (None, vec![], vec![]),
        };
        let (usage, hours) = match tools {
            Some(t) => (t.usage, t.mcp_hours),
            None => (Value::Null, vec![]),
        };
        result.insert(
            profile.id.clone(),
            json!({
                "platforms": links,
                "lastActivityAt": last,
                "recent": recent,
                "usage": usage,
                "jobs": jobs(job_list.as_ref()),
                "board": board(root, &profile.name).ok().flatten(),
                "events": activity_log(now, vec![started, hours, runs, link_events]),
            }),
        );
    }
    json!({ "schema": 1, "readAt": iso_ms(now), "gateway": live.info, "profiles": result })
}
