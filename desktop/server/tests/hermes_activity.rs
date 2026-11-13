//! Ported from server/hermes-activity.test.ts and hermes-summary.test.ts.

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use agora_server::hermes::activity::read_activity;
use agora_server::hermes::activity_log::job_runs;
use agora_server::hermes::catalog::ProfileTarget;
use agora_server::hermes::summary::{read_hermes_summary, tally_words, top_words};
use agora_server::js::parse_date_ms;
use rusqlite::{Connection, params};
use serde_json::{Map, Value, json};

fn ms(iso: &str) -> i64 {
    parse_date_ms(iso).unwrap()
}

fn seconds(iso: &str) -> f64 {
    ms(iso) as f64 / 1000.0
}

fn target(id: &str, name: &str, home: &Path, mcp: &[&str]) -> ProfileTarget {
    ProfileTarget { id: id.into(), name: name.into(), home: home.to_path_buf(), mcp: mcp.iter().map(|s| s.to_string()).collect() }
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    work: PathBuf,
    profiles: Vec<ProfileTarget>,
}

fn fixture(gateway_at: &str, pid: i64) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let work = root.join("profiles/work");
    fs::create_dir_all(work.join("cron")).unwrap();
    fs::create_dir_all(root.join("state")).unwrap();
    let gateway = json!({
        "pid": pid, "gateway_state": "running", "updated_at": gateway_at, "active_agents": 2,
        "platforms": {
            "telegram": { "state": "connected", "updated_at": gateway_at, "chat_id": "CANARY_CHAT" },
            "work:telegram": { "state": "retrying", "updated_at": gateway_at },
            "work:discord": { "state": "connected", "needs_attention": true, "error_message": "CANARY_ERROR" },
        },
    });
    fs::write(root.join("gateway_state.json"), gateway.to_string()).unwrap();
    let db = Connection::open(work.join("state.db")).unwrap();
    db.execute_batch("CREATE TABLE sessions (id TEXT, source TEXT, title TEXT, chat_id TEXT, system_prompt TEXT, started_at REAL, last_activity_at REAL)").unwrap();
    let add = "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)";
    db.execute(add, params!["a", "telegram", "CANARY_TITLE", "CANARY_CHAT", "CANARY_PROMPT", seconds("2026-10-17T10:00:00Z"), seconds("2026-10-17T19:59:00Z")]).unwrap();
    db.execute(add, params!["b", "cron", "CANARY_TITLE", None::<String>, None::<String>, seconds("2026-10-17T08:00:00Z"), None::<f64>]).unwrap();
    db.execute(add, params!["c", "desktop", "CANARY_TITLE", None::<String>, None::<String>, seconds("2026-09-01T08:00:00Z"), seconds("2026-09-01T09:00:00Z")]).unwrap();
    db.execute_batch("CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT, timestamp REAL)").unwrap();
    let say = "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    let none = None::<String>;
    db.execute(say, params![1, "a", "assistant", "CANARY_CONTENT", r#"[{"name":"terminal","arguments":"CANARY_ARGS"}]"#, none, none, seconds("2026-10-17T19:00:00Z")]).unwrap();
    db.execute(say, params![2, "a", "tool", "CANARY_RESULT", none, "call-1", "terminal", seconds("2026-10-17T19:00:01Z")]).unwrap();
    // Compaction clones the kept tail: the same call appears twice and must count once.
    db.execute(say, params![7, "a", "tool", "CANARY_RESULT", none, "call-1", "terminal", seconds("2026-10-17T19:00:01Z")]).unwrap();
    db.execute(say, params![3, "a", "tool", "CANARY_RESULT", none, "call-2", "terminal", seconds("2026-08-01T10:00:00Z")]).unwrap();
    db.execute(say, params![4, "a", "tool", "CANARY_RESULT", none, "call-3", "mcp__my_crm__createLead", seconds("2026-10-16T09:00:00Z")]).unwrap();
    db.execute(say, params![5, "a", "tool", "CANARY_RESULT", none, "call-4", "mcp__my_crm__searchLeads", seconds("2026-10-17T18:00:00Z")]).unwrap();
    // Server "crm-" is stored as "crm_", so its tools read mcp__crm___lead.
    db.execute(say, params![8, "a", "tool", "CANARY_RESULT", none, "call-5", "mcp__crm___lead", seconds("2026-10-17T17:00:00Z")]).unwrap();
    db.execute(say, params![6, "a", "tool", "CANARY_RESULT", none, "call-6", "bad name; DROP", seconds("2026-10-17T18:00:00Z")]).unwrap();
    drop(db);
    let jobs = json!({ "jobs": [{
        "id": "job-1", "name": "Resumen diario", "enabled": true, "state": "scheduled", "schedule_display": "every day at 20:00", "last_status": "ok",
        "last_run_at": "2026-10-16T20:00:00+02:00", "next_run_at": "2026-10-17T20:00:00+02:00",
        "prompt": "CANARY_PROMPT", "deliver": "telegram:CANARY_CHAT", "origin": { "chat_id": "CANARY_CHAT" },
    }] });
    fs::write(work.join("cron/jobs.json"), jobs.to_string()).unwrap();
    let runs = Connection::open(work.join("cron/executions.db")).unwrap();
    runs.execute_batch("CREATE TABLE executions (id INTEGER, job_id TEXT, status TEXT, started_at TEXT, finished_at TEXT, error TEXT)").unwrap();
    runs.execute("INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?)", params![1, "job-1", "failed", "2026-10-17T19:30:00+02:00", "2026-10-17T19:31:00+02:00", "CANARY_ERROR"]).unwrap();
    drop(runs);
    let kanban = Connection::open(root.join("kanban.db")).unwrap();
    kanban.execute_batch("CREATE TABLE tasks (id TEXT, title TEXT, body TEXT, assignee TEXT, status TEXT)").unwrap();
    for row in [["1", "Preparar informe", "CANARY_BODY", "work", "running"], ["2", "Informe anterior", "CANARY_BODY", "work", "done"], ["3", "De otro perfil", "CANARY_BODY", "other", "todo"]] {
        kanban.execute("INSERT INTO tasks VALUES (?, ?, ?, ?, ?)", row).unwrap();
    }
    drop(kanban);
    let profiles = vec![target("p-default", "default", &root, &[]), target("p-work", "work", &work, &["my-crm", "crm-"])];
    Fixture { _dir: dir, root, work, profiles }
}

const NOW: &str = "2026-10-17T20:00:00Z";

#[test]
fn real_activity_without_content() {
    let f = fixture("2026-10-17T19:59:30Z", std::process::id() as i64);
    let activity = read_activity(&f.root, &f.profiles, ms(NOW));
    assert_eq!(activity["gateway"]["state"], "running");
    assert_eq!(activity["gateway"]["activeAgents"], 2);
    let links = |id: &str| activity["profiles"][id]["platforms"].as_array().unwrap().iter().map(|p| (p["name"].as_str().unwrap().to_string(), p["state"].as_str().unwrap().to_string())).collect::<Vec<_>>();
    assert_eq!(links("p-default"), [("telegram".into(), "connected".into())]);
    assert_eq!(links("p-work"), [("telegram".into(), "retrying".into()), ("discord".into(), "attention".into())]);
    let work = &activity["profiles"]["p-work"];
    assert_eq!(work["lastActivityAt"], "2026-10-17T19:59:00.000Z");
    let mut recent = work["recent"].as_array().unwrap().clone();
    recent.sort_by_key(|r| r["source"].as_str().unwrap().to_string());
    assert_eq!(Value::Array(recent), json!([{ "source": "cron", "sessions": 1 }, { "source": "telegram", "sessions": 1 }]));
    assert_eq!(work["jobs"][0]["name"], "Resumen diario");
    assert_eq!(work["jobs"][0]["nextRunAt"], "2026-10-17T18:00:00.000Z");
    assert_eq!(work["board"]["open"], json!([{ "id": "1", "title": "Preparar informe", "status": "running" }]));
    assert_eq!(work["board"]["byStatus"].as_array().unwrap().iter().map(|s| s["count"].as_i64().unwrap()).sum::<i64>(), 2);
    assert_eq!(activity["profiles"]["p-default"]["jobs"], Value::Null);
    assert_eq!(work["usage"]["tools"], json!([{ "name": "terminal", "calls": 1, "lastUsedAt": "2026-10-17T19:00:01.000Z" }]));
    let mcp = work["usage"]["mcp"].as_array().unwrap();
    let crm = mcp.iter().find(|s| s["name"] == "my_crm").unwrap();
    assert_eq!(crm["calls"], 2);
    assert_eq!(crm["lastUsedAt"], "2026-10-17T18:00:00.000Z");
    let mut names: Vec<&str> = crm["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    names.sort();
    assert_eq!(names, ["createLead", "searchLeads"]);
    assert_eq!(mcp.iter().find(|s| s["name"] == "crm_").unwrap()["tools"], json!([{ "name": "lead", "calls": 1, "lastUsedAt": "2026-10-17T17:00:00.000Z" }]));
    assert_eq!(mcp.len(), 2);
    let events: Vec<(String, String)> = work["events"].as_array().unwrap().iter().map(|e| (e["kind"].as_str().unwrap().into(), e["at"].as_str().unwrap().into())).collect();
    let expected = [
        ("link", "2026-10-17T19:59:30.000Z"),
        ("mcp", "2026-10-17T18:00:00.000Z"),
        ("job", "2026-10-17T17:31:00.000Z"),
        ("mcp", "2026-10-17T17:00:00.000Z"),
        ("session", "2026-10-17T10:00:00.000Z"),
        ("session", "2026-10-17T08:00:00.000Z"),
    ];
    assert_eq!(events, expected.map(|(k, a)| (k.to_string(), a.to_string())));
    let all = work["events"].as_array().unwrap();
    assert_eq!(all.iter().find(|e| e["kind"] == "job").unwrap(), &json!({ "at": "2026-10-17T17:31:00.000Z", "kind": "job", "name": "Resumen diario", "status": "failed" }));
    let servers: Vec<(String, i64)> = all.iter().filter(|e| e["kind"] == "mcp").map(|e| (e["server"].as_str().unwrap().into(), e["calls"].as_i64().unwrap())).collect();
    assert_eq!(servers, [("my_crm".to_string(), 1), ("crm_".to_string(), 1)]);
    assert!(!activity.to_string().contains("CANARY"));
}

#[test]
fn stale_state_or_missing_process_is_never_connected() {
    let stale = fixture("2026-10-17T19:50:00Z", std::process::id() as i64);
    let activity = read_activity(&stale.root, &stale.profiles, ms(NOW));
    assert_eq!(activity["gateway"]["state"], "stale");
    assert_eq!(activity["gateway"]["activeAgents"], Value::Null);
    let all: Vec<&Value> = activity["profiles"].as_object().unwrap().values().flat_map(|p| p["platforms"].as_array().unwrap()).collect();
    assert!(all.iter().all(|p| p["state"] == "unknown"));
    let stopped = fixture("2026-10-17T19:59:30Z", (1 << 22) + 12345);
    let activity = read_activity(&stopped.root, &stopped.profiles, ms(NOW));
    assert_eq!(activity["gateway"]["state"], "stopped");
    assert_eq!(activity["gateway"]["activeAgents"], Value::Null);
}

#[test]
fn links_are_not_followed_and_missing_sources_do_not_fail() {
    let f = fixture("2026-10-17T19:59:30Z", std::process::id() as i64);
    fs::remove_file(f.work.join("cron/jobs.json")).unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("jobs.json"), json!([{ "name": "CANARY_OUTSIDE" }]).to_string()).unwrap();
    symlink(outside.path().join("jobs.json"), f.work.join("cron/jobs.json")).unwrap();
    fs::remove_file(f.root.join("kanban.db")).unwrap();
    let activity = read_activity(&f.root, &f.profiles, ms(NOW));
    assert_eq!(activity["profiles"]["p-work"]["jobs"], Value::Null);
    assert_eq!(activity["profiles"]["p-work"]["board"], Value::Null);
    assert!(!activity.to_string().contains("CANARY"));
    fs::remove_file(f.root.join("gateway_state.json")).unwrap();
    assert_eq!(read_activity(&f.root, &f.profiles, ms(NOW))["gateway"]["state"], "missing");
}

#[test]
fn last_run_in_jobs_json_does_not_duplicate_history() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::create_dir(root.join("cron")).unwrap();
    let runs = Connection::open(root.join("cron/executions.db")).unwrap();
    runs.execute_batch("CREATE TABLE executions (job_id TEXT, status TEXT, started_at TEXT, finished_at TEXT)").unwrap();
    for id in ["a", "b"] {
        runs.execute("INSERT INTO executions VALUES (?, ?, ?, ?)", params![id, "completed", "2026-10-17T19:00:00+02:00", "2026-10-17T19:02:00+02:00"]).unwrap();
    }
    drop(runs);
    let jobs: Vec<Map<String, Value>> = [
        json!({ "id": "a", "name": "Mismo nombre", "last_run_at": "2026-10-17T19:02:05+02:00", "last_status": "ok" }),
        json!({ "id": "b", "name": "Mismo nombre", "last_run_at": "2026-10-17T21:30:00+02:00", "last_status": "error" }),
    ]
    .map(|j| j.as_object().unwrap().clone())
    .into();
    let events = serde_json::to_value(job_runs(&root, &root, &jobs, ms(NOW))).unwrap();
    let events = events.as_array().unwrap();
    assert_eq!(events.len(), 3);
    let errors: Vec<&Value> = events.iter().filter(|e| e["status"] == "error").map(|e| &e["at"]).collect();
    assert_eq!(errors, [&json!("2026-10-17T19:30:00.000Z")]);
}

fn summary_fixture() -> (tempfile::TempDir, PathBuf, Vec<ProfileTarget>) {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let work = root.join("profiles/work");
    fs::create_dir_all(&work).unwrap();
    let db = Connection::open(work.join("state.db")).unwrap();
    db.execute_batch("CREATE TABLE sessions (id TEXT, source TEXT, title TEXT, started_at REAL, last_activity_at REAL, cwd TEXT, git_repo_root TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL)").unwrap();
    let add = "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    let none = None::<f64>;
    db.execute(add, params!["a", "telegram", "CANARY_TITLE", seconds("2026-11-12T10:00:00Z"), seconds("2026-11-13T19:00:00Z"), "/Users/x/code/tienda", "/Users/x/code/tienda", 1000, 200, 0, 0, 0, 0.5, none]).unwrap();
    db.execute(add, params!["b", "cli", "CANARY_TITLE", seconds("2026-11-10T10:00:00Z"), none, "/Users/x/code/tienda/src", "/Users/x/code/tienda/", 300, 100, 50, 0, 0, none, 0.25]).unwrap();
    db.execute(add, params!["c", "cli", "CANARY_TITLE", seconds("2026-11-11T10:00:00Z"), none, "/Users/x/notas", "", 10, 5, 0, 0, 0, 0, 0]).unwrap();
    db.execute(add, params!["d", "cli", "CANARY_TITLE", seconds("2026-08-01T10:00:00Z"), none, "/Users/x/viejo", "/Users/x/viejo", 99999, 0, 0, 0, 0, 9, 9]).unwrap();
    db.execute_batch("CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, timestamp REAL)").unwrap();
    let say = "INSERT INTO messages VALUES (?, ?, ?, ?, ?)";
    let key = format!("{}-{}-{}", "sk", "ant", "api03-ABCDEFGH12345");
    db.execute(say, params![1, "a", "user", format!("Revisa la tienda y la tienda nueva, por favor. Mi clave es {key} y abcdef1234"), seconds("2026-11-13T10:00:00Z")]).unwrap();
    db.execute(say, params![2, "a", "assistant", "CANARY_ASSISTANT tienda tienda tienda", seconds("2026-11-13T10:01:00Z")]).unwrap();
    db.execute(say, params![3, "b", "user", "Despliega la tienda en producción", seconds("2026-11-12T10:00:00Z")]).unwrap();
    db.execute(say, params![4, "b", "user", "mensaje antiguo antiguo antiguo", seconds("2026-07-01T10:00:00Z")]).unwrap();
    drop(db);
    let profiles = vec![target("work", "work", &work, &[])];
    (dir, root, profiles)
}

#[test]
fn summary_tokens_and_cost_per_profile_and_project() {
    let (_dir, root, profiles) = summary_fixture();
    let before = fs::metadata(profiles[0].home.join("state.db")).unwrap().modified().unwrap();
    let summary = read_hermes_summary(&root, &profiles, ms("2026-11-13T20:00:00Z"));
    let profile = &summary["profiles"][0];
    assert_eq!((profile["profile"].as_str(), profile["tokens"].as_f64(), profile["costUsd"].as_f64(), profile["sessions"].as_f64()), (Some("work"), Some(1665.0), Some(0.75), Some(3.0)));
    let projects: Vec<(String, f64, f64)> = summary["projects"].as_array().unwrap().iter().map(|p| (p["project"].as_str().unwrap().into(), p["tokens"].as_f64().unwrap(), p["sessions"].as_f64().unwrap())).collect();
    assert_eq!(projects, [("tienda".to_string(), 1650.0, 2.0), ("notas".to_string(), 15.0, 1.0)], "el repo manda sobre la carpeta y la ruta no sale");
    assert!(!summary.to_string().contains("/Users"), "nunca rutas completas");
    assert_eq!(fs::metadata(profiles[0].home.join("state.db")).unwrap().modified().unwrap(), before, "solo lectura");
}

#[test]
fn summary_words_of_user_messages_only() {
    let (_dir, root, profiles) = summary_fixture();
    let summary = read_hermes_summary(&root, &profiles, ms("2026-11-13T20:00:00Z"));
    let words: HashMap<&str, i64> = summary["words"].as_array().unwrap().iter().map(|w| (w["word"].as_str().unwrap(), w["count"].as_i64().unwrap())).collect();
    assert_eq!(words.get("tienda"), Some(&3), "solo los mensajes del usuario y de los últimos 30 días");
    assert_eq!(words.get("antiguo"), None);
    assert_eq!(summary["messagesCounted"], 2);
    let text = summary.to_string();
    for hidden in ["CANARY", "abcdef", "sk-ant", "favor"] {
        assert!(!text.contains(hidden), "{hidden}");
    }
}

#[test]
fn word_tally_letters_only_without_stopwords() {
    let mut counts = HashMap::new();
    tally_words(["Agentes agentes, proyecto PROYECTO de para http://x.com token9abc aaaa Ñandú"], &mut counts);
    let top: Vec<(String, u64)> = top_words(&counts, 40).into_iter().map(|w| (w.word, w.count)).collect();
    assert_eq!(top, [("agentes".to_string(), 2), ("proyecto".to_string(), 2), ("ñandú".to_string(), 1)]);
}
