//! The work reader: scheduled tasks with their runs paired to their sessions' tokens, kanban cards with
//! their runs and worker session, totals by period, and nothing of the private text Hermes keeps.

use std::fs;
use std::path::{Path, PathBuf};

use agora_server::hermes::catalog::ProfileTarget;
use agora_server::hermes::work::read_work;
use agora_server::js::parse_date_ms;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

fn seconds(iso: &str) -> f64 {
    parse_date_ms(iso).unwrap() as f64 / 1000.0
}

fn target(id: &str, name: &str, home: &Path) -> ProfileTarget {
    ProfileTarget { id: id.into(), name: name.into(), home: home.to_path_buf(), mcp: vec![] }
}

fn sessions_table(db: &Connection) {
    db.execute_batch(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, title TEXT, system_prompt TEXT, started_at REAL, ended_at REAL,
         input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL)",
    )
    .unwrap();
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    profiles: Vec<ProfileTarget>,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let work = root.join("profiles/work");
    fs::create_dir_all(work.join("cron")).unwrap();
    let jobs = json!({ "jobs": [
        { "id": "job_1", "name": "Resumen diario", "enabled": true, "state": "scheduled", "schedule_display": "every day at 20:00",
          "last_status": "ok", "last_run_at": "2026-11-14T20:01:00+01:00", "next_run_at": "2026-11-15T20:00:00+01:00", "prompt": "CANARY_PROMPT" },
        { "id": "job2", "name": "Sin ejecuciones", "enabled": false, "state": "paused", "schedule_display": "every monday" },
    ] });
    fs::write(work.join("cron/jobs.json"), jobs.to_string()).unwrap();
    let runs = Connection::open(work.join("cron/executions.db")).unwrap();
    runs.execute_batch("CREATE TABLE executions (id TEXT, job_id TEXT, status TEXT, started_at TEXT, finished_at TEXT, error TEXT)").unwrap();
    let add = "INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?)";
    runs.execute(add, params!["a", "job_1", "completed", "2026-11-14T20:00:00+01:00", "2026-11-14T20:01:30+01:00", "CANARY_ERROR"]).unwrap();
    runs.execute(add, params!["b", "job_1", "failed", "2026-11-10T20:00:00+01:00", "2026-11-10T20:00:20+01:00", "CANARY_ERROR"]).unwrap();
    // Older than the window: left out.
    runs.execute(add, params!["c", "job_1", "completed", "2026-09-01T20:00:00+02:00", "2026-09-01T20:01:00+02:00", ""]).unwrap();
    drop(runs);
    let db = Connection::open(work.join("state.db")).unwrap();
    sessions_table(&db);
    let session = "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    db.execute(session, params!["cron_job_1_20261114_200005", "cron", "CANARY_TITLE", "CANARY_PROMPT", seconds("2026-11-14T20:00:05+01:00"), seconds("2026-11-14T20:01:25+01:00"), 1000, 200, 0.05, None::<f64>]).unwrap();
    // The failed run opened no session; a session far from any run is not paired.
    db.execute(session, params!["cron_job_1_20261112_080000", "cron", "", "", seconds("2026-11-12T08:00:00+01:00"), None::<f64>, 50, 5, None::<f64>, None::<f64>]).unwrap();
    db.execute(session, params!["worker-1", "kanban", "CANARY_TITLE", "", seconds("2026-11-14T10:00:00+01:00"), seconds("2026-11-14T10:10:00+01:00"), 3000, 400, 0.2, 0.25]).unwrap();
    drop(db);
    let kanban = Connection::open(root.join("kanban.db")).unwrap();
    kanban
        .execute_batch(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, body TEXT, assignee TEXT, status TEXT, priority INTEGER, created_by TEXT,
               created_at INTEGER, started_at INTEGER, completed_at INTEGER, result TEXT, last_failure_error TEXT, session_id TEXT);
             CREATE TABLE task_runs (id INTEGER PRIMARY KEY, task_id TEXT, profile TEXT, status TEXT, started_at INTEGER, ended_at INTEGER,
               outcome TEXT, summary TEXT, error TEXT);",
        )
        .unwrap();
    let card = "INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    let t = |iso: &str| seconds(iso) as i64;
    kanban.execute(card, params!["t1", "Preparar informe", "CANARY_BODY", "work", "done", 1, "agoraone", t("2026-11-14T09:50:00+01:00"), t("2026-11-14T10:00:00+01:00"), t("2026-11-14T10:10:00+01:00"), "CANARY_RESULT", "CANARY_ERROR", "worker-1"]).unwrap();
    kanban.execute(card, params!["t2", "En marcha", "", "work", "running", 0, "user", t("2026-11-15T06:00:00+01:00"), t("2026-11-15T06:50:00+01:00"), None::<i64>, "", "", None::<String>]).unwrap();
    kanban.execute(card, params!["t3", "Archivada hace mucho", "", "work", "archived", 0, "user", t("2026-08-01T10:00:00+02:00"), None::<i64>, t("2026-08-02T10:00:00+02:00"), "", "", None::<String>]).unwrap();
    let run = "INSERT INTO task_runs (task_id, profile, status, started_at, ended_at, outcome, summary, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    kanban.execute(run, params!["t1", "work", "done", t("2026-11-14T10:00:00+01:00"), t("2026-11-14T10:10:00+01:00"), "completed", "CANARY_SUMMARY", "CANARY_ERROR"]).unwrap();
    kanban.execute(run, params!["t2", "work", "running", t("2026-11-15T06:50:00+01:00"), None::<i64>, None::<String>, "", ""]).unwrap();
    drop(kanban);
    Fixture { profiles: vec![target("work", "work", &work)], root, _dir: dir }
}

fn read(fixture: &Fixture) -> Value {
    read_work(&fixture.root, &fixture.profiles, parse_date_ms("2026-11-15T07:00:00+01:00").unwrap())
}

#[test]
fn pairs_each_run_with_the_session_it_opened() {
    let fixture = fixture();
    let work = read(&fixture);
    let tasks = work["profiles"]["work"]["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 2);
    let daily = &tasks[0];
    assert_eq!(daily["id"], "job_1");
    let runs = daily["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 2, "the run outside the 30-day window is left out");
    assert_eq!(runs[0]["status"], "completed");
    assert_eq!(runs[0]["seconds"], 90.0);
    assert_eq!(runs[0]["tokens"], json!({ "input": 1000, "output": 200, "costUsd": 0.05 }));
    assert_eq!(runs[1]["tokens"], Value::Null, "a run without its session has no tokens, not someone else's");
    let week = &daily["totals"]["7d"];
    assert_eq!(week["runs"], 2);
    assert_eq!(week["seconds"], 110.0);
    assert_eq!(week["measured"], 1);
    assert_eq!(daily["totals"]["24h"]["runs"], 1);
    assert_eq!(tasks[1]["runs"].as_array().unwrap().len(), 0);
}

#[test]
fn reads_cards_with_runs_time_and_worker_tokens() {
    let fixture = fixture();
    let work = read(&fixture);
    let cards = work["board"]["cards"].as_array().unwrap();
    assert_eq!(cards.len(), 2, "an archived card older than the window is left out");
    let running = &cards[0];
    assert_eq!(running["status"], "running");
    assert_eq!(running["seconds"], 600.0, "a running card counts until now");
    let done = &cards[1];
    assert_eq!(done["profileId"], "work");
    assert_eq!(done["createdBy"], "agoraone");
    assert_eq!(done["seconds"], 600.0);
    assert_eq!(done["tokens"], json!({ "input": 3000, "output": 400, "costUsd": 0.25 }), "the actual cost wins over the estimate");
    assert_eq!(done["runs"][0]["outcome"], "completed");
}

#[test]
fn never_returns_hermes_private_text() {
    let fixture = fixture();
    let text = read(&fixture).to_string();
    for canary in ["CANARY_PROMPT", "CANARY_ERROR", "CANARY_TITLE", "CANARY_BODY", "CANARY_RESULT", "CANARY_SUMMARY"] {
        assert!(!text.contains(canary), "{canary} leaked");
    }
}

#[test]
fn missing_files_give_empty_answers() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let home = root.join("profiles/empty");
    fs::create_dir_all(&home).unwrap();
    let work = read_work(&root, &[target("empty", "empty", &home)], 0);
    assert_eq!(work["profiles"]["empty"]["tasks"], Value::Null);
    assert_eq!(work["board"], Value::Null);
}

/// Against the local Hermes, printing counts only: `cargo test --test hermes_work -- --ignored`.
#[test]
#[ignore]
fn real_hermes_counts() {
    let root = fs::canonicalize(std::env::var("HOME").unwrap() + "/.hermes").unwrap();
    let mut profiles = vec![target("default", "default", &root)];
    for entry in fs::read_dir(root.join("profiles")).unwrap().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        profiles.push(target(&name, &name, &entry.path()));
    }
    let work = read_work(&root, &profiles, parse_date_ms(&chrono_now()).unwrap());
    let mut tasks = 0;
    let mut runs = 0;
    let mut paired = 0;
    for profile in work["profiles"].as_object().unwrap().values() {
        for task in profile["tasks"].as_array().into_iter().flatten() {
            tasks += 1;
            for run in task["runs"].as_array().unwrap() {
                runs += 1;
                paired += usize::from(!run["tokens"].is_null());
            }
        }
    }
    let cards = work["board"]["cards"].as_array().map_or(0, Vec::len);
    println!("perfiles {} · tareas {tasks} · ejecuciones (30 días) {runs} · con tokens {paired} · tarjetas {cards}", profiles.len());
}

fn chrono_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    agora_server::js::iso_ms(secs * 1000).unwrap()
}
