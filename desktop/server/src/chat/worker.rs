//! One Python bridge process per conversation, kept for five idle minutes: a JSON request per line on stdin,
//! progress events and a final `done` per line on stdout. At most four per kind (profile agents and Luma
//! apart), evicting only idle ones; one turn at a time; output capped at 8 MB; each bridge leads its own
//! process group, so whatever it starts in it (the agent's terminal commands, for instance) is stopped with
//! it. MCP servers run in their own session and Hermes' own supervisor stops them. Same rules as the former
//! server/hermes-worker.ts.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::oneshot;

use crate::js::{js_string, number, slice_utf16};

pub const FAILURE: &str = "Hermes no completó la petición. No se ha guardado este turno; puedes reintentarlo.";
pub const UPDATE_PENDING: &str = "Hermes tiene una actualización o reparación sin terminar. Ábrelo una vez o ejecuta «hermes update» y vuelve a intentarlo: AgoraOne no repara Hermes.";
const MAX_OUTPUT: usize = 8_000_000;
const IDLE: Duration = Duration::from_secs(5 * 60);
const PER_KIND: usize = 4;

/// Receives progress events for the browser, already checked and trimmed, in order.
pub type Progress = Arc<dyn Fn(Value) + Send + Sync>;

/// How to start a bridge: the Python, its source (run with `-I -c`), working folder and whole environment.
pub struct Spawn {
    pub python: PathBuf,
    pub source: String,
    pub home: PathBuf,
    pub env: Vec<(String, String)>,
}

struct Pending {
    reply: oneshot::Sender<Result<Value, &'static str>>,
    progress: Option<Progress>,
}

#[derive(Default)]
struct State {
    pending: Option<Pending>,
    /// Bumped on every turn and every finish, so stale timers do nothing.
    generation: u64,
    closed: bool,
}

struct Worker {
    group: crate::platform::ProcessGroup,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    state: Mutex<State>,
    exited: AtomicBool,
}

static WORKERS: LazyLock<Mutex<HashMap<String, Arc<Worker>>>> = LazyLock::new(Mutex::default);

fn is_agent(key: &str) -> bool {
    key.starts_with("agent:")
}

fn terminate_worker(worker: &Worker, hard: bool) {
    if !worker.exited.load(Ordering::SeqCst) {
        if hard {
            worker.group.kill();
        } else {
            worker.group.terminate();
        }
    }
}

/// Forgets a bridge: its turn fails, stdin closes (so it can shut its MCP servers down), and signals follow
/// if it does not exit.
fn discard(key: &str, worker: &Arc<Worker>) {
    {
        let mut workers = WORKERS.lock().unwrap();
        if workers.get(key).is_some_and(|w| Arc::ptr_eq(w, worker)) {
            workers.remove(key);
        }
    }
    let pending = {
        let mut state = worker.state.lock().unwrap();
        if state.closed {
            return;
        }
        state.closed = true;
        state.generation += 1;
        state.pending.take()
    };
    if let Some(pending) = pending {
        let _ = pending.reply.send(Err(FAILURE));
    }
    let worker = worker.clone();
    tokio::spawn(async move {
        worker.stdin.lock().await.take();
        tokio::time::sleep(Duration::from_secs(3)).await;
        terminate_worker(&worker, false);
        tokio::time::sleep(Duration::from_secs(5)).await;
        terminate_worker(&worker, true);
    });
}

/// Stops one conversation's bridge now.
pub fn stop(key: &str) {
    let worker = WORKERS.lock().unwrap().get(key).cloned();
    if let Some(worker) = worker {
        terminate_worker(&worker, true);
        discard(key, &worker);
    }
}

/// Stops every bridge now (when AgoraOne closes).
pub fn close_all() {
    let all: Vec<_> = WORKERS.lock().unwrap().drain().collect();
    for (key, worker) in all {
        terminate_worker(&worker, true);
        discard(&key, &worker);
    }
}

/// A progress line from the bridge, as the browser may see it; None for anything else.
fn checked(event: &Value) -> Option<Value> {
    let text = |key: &str, max: usize| slice_utf16(&event.get(key).map(|v| js_string(Some(v))).unwrap_or_default(), max);
    let request = event.get("requestId").and_then(Value::as_str).filter(|r| r.len() == 32 && r.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    match event.get("type").and_then(Value::as_str)? {
        "delta" => Some(json!({ "type": "delta", "text": event.get("text")?.as_str()? })),
        "status" => {
            let stage = event.get("stage").and_then(Value::as_str).filter(|s| ["starting", "generating"].contains(s))?;
            let mut out = json!({ "type": "status", "stage": stage });
            if let Some(ms) = event.get("startupMs").filter(|v| !v.is_null()) {
                out["startupMs"] = ms.clone();
            }
            Some(out)
        }
        "tool" => {
            let state = event.get("state").and_then(Value::as_str).filter(|s| ["start", "end"].contains(s))?;
            Some(json!({ "type": "tool", "state": state, "name": slice_utf16(event.get("name")?.as_str()?, 120) }))
        }
        "approval" => {
            let length = number(event.get("length"));
            let length = if length.fract() == 0.0 && length.abs() < 9e15 { json!(length as i64) } else { json!(length) };
            let description = if event.get("description").is_none_or(Value::is_null) { String::new() } else { text("description", 500) };
            let args = if event.get("args").is_none_or(Value::is_null) { String::new() } else { text("args", 12_000) };
            let flag = |key: &str| event.get(key) == Some(&Value::Bool(true));
            Some(json!({ "type": "approval", "requestId": request?, "tool": text("tool", 120), "description": description, "args": args,
                "redacted": flag("redacted"), "truncated": flag("truncated"), "length": length, "rewritable": flag("rewritable") }))
        }
        "approval-settled" => {
            let reason = if event.get("reason").is_none_or(Value::is_null) { String::new() } else { text("reason", 40) };
            Some(json!({ "type": "approval-settled", "requestId": request?, "reason": reason }))
        }
        _ => None,
    }
}

fn start(key: &str, spawn: &Spawn) -> Result<Arc<Worker>, String> {
    let mut command = Command::new(&spawn.python);
    command
        .args(["-X", "utf8", "-I", "-c"])
        .arg(&spawn.source)
        .current_dir(&spawn.home)
        .env_clear()
        .envs(spawn.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Never forward provider logs or raw exceptions.
        .stderr(Stdio::null());
    crate::platform::apply_minimal_os_env(&mut command);
    let (mut child, group) = crate::platform::spawn_in_group(&mut command).map_err(|_| FAILURE.to_string())?;
    let worker = Arc::new(Worker { group, stdin: tokio::sync::Mutex::new(child.stdin.take()), state: Mutex::default(), exited: AtomicBool::new(false) });
    let stdout = child.stdout.take();
    let (reader_key, reader) = (key.to_string(), worker.clone());
    tokio::spawn(async move {
        let Some(stdout) = stdout else { return discard(&reader_key, &reader) };
        let mut lines = BufReader::new(stdout);
        let (mut line, mut bytes) = (Vec::new(), 0usize);
        loop {
            line.clear();
            match lines.read_until(b'\n', &mut line).await {
                Ok(0) | Err(_) => break,
                Ok(read) => bytes += read,
            }
            if bytes > MAX_OUTPUT {
                break;
            }
            let mut state = reader.state.lock().unwrap();
            if state.pending.is_none() {
                continue;
            }
            let Ok(event) = serde_json::from_slice::<Value>(&line) else { break };
            if event.get("type").and_then(Value::as_str) == Some("done") {
                if event.get("ok") != Some(&Value::Bool(true)) {
                    // The one failure the user can fix: say how, instead of the generic message.
                    if event.get("error").and_then(Value::as_str) == Some("hermes_update_pending")
                        && let Some(pending) = state.pending.take()
                    {
                        let _ = pending.reply.send(Err(UPDATE_PENDING));
                    }
                    break;
                }
                let pending = state.pending.take().expect("pending turn");
                state.generation += 1;
                let generation = state.generation;
                drop(state);
                bytes = 0;
                let _ = pending.reply.send(Ok(event));
                let (idle_key, idle) = (reader_key.clone(), reader.clone());
                tokio::spawn(async move {
                    tokio::time::sleep(IDLE).await;
                    if idle.state.lock().unwrap().generation == generation {
                        discard(&idle_key, &idle);
                    }
                });
            } else if let Some(progress) = checked(&event)
                && let Some(report) = state.pending.as_ref().and_then(|p| p.progress.as_ref())
            {
                report(progress);
            }
        }
        discard(&reader_key, &reader);
    });
    let (waiter_key, waiter) = (key.to_string(), worker.clone());
    tokio::spawn(async move {
        let _ = child.wait().await;
        waiter.exited.store(true, Ordering::SeqCst);
        waiter.group.reap();
        discard(&waiter_key, &waiter);
    });
    Ok(worker)
}

/// The conversation's bridge, started when needed within the per-kind limit.
fn worker_for(key: &str, spawn: &Spawn) -> Result<Arc<Worker>, String> {
    if let Some(worker) = WORKERS.lock().unwrap().get(key) {
        return Ok(worker.clone());
    }
    let idle = {
        let workers = WORKERS.lock().unwrap();
        let same: Vec<_> = workers.iter().filter(|(name, _)| is_agent(name) == is_agent(key)).collect();
        if same.len() < PER_KIND {
            None
        } else {
            let idle = same.iter().find(|(_, w)| w.state.lock().unwrap().pending.is_none()).map(|(k, w)| ((*k).clone(), (*w).clone()));
            Some(idle.ok_or("Hermes está ocupado. Espera antes de continuar.")?)
        }
    };
    if let Some((name, worker)) = idle {
        discard(&name, &worker);
    }
    let worker = start(key, spawn)?;
    WORKERS.lock().unwrap().insert(key.to_string(), worker.clone());
    Ok(worker)
}

/// Sends one request to the conversation's bridge and waits for its `done` (or a failure).
pub async fn request(key: &str, spawn: &Spawn, payload: &Value, progress: Option<Progress>, limit: Duration) -> Result<Value, String> {
    let worker = worker_for(key, spawn)?;
    let (reply, answer) = oneshot::channel();
    let generation = {
        let mut state = worker.state.lock().unwrap();
        if state.closed {
            return Err(FAILURE.into());
        }
        if state.pending.is_some() {
            return Err("Esta conversación ya tiene una respuesta en curso.".into());
        }
        state.generation += 1;
        state.pending = Some(Pending { reply, progress });
        state.generation
    };
    let (timer_key, timer) = (key.to_string(), worker.clone());
    tokio::spawn(async move {
        tokio::time::sleep(limit).await;
        if timer.state.lock().unwrap().generation == generation {
            discard(&timer_key, &timer);
        }
    });
    let written = match worker.stdin.lock().await.as_mut() {
        Some(stdin) => stdin.write_all(format!("{payload}\n").as_bytes()).await.is_ok(),
        None => false,
    };
    if !written {
        discard(key, &worker);
    }
    answer.await.map_err(|_| FAILURE.to_string())?.map_err(str::to_string)
}

/// Sends a line to a conversation's bridge while it has a turn running (an approval answer or a cancel).
pub async fn send(key: &str, payload: &Value) -> bool {
    let Some(worker) = WORKERS.lock().unwrap().get(key).cloned() else { return false };
    if worker.state.lock().unwrap().pending.is_none() {
        return false;
    }
    match worker.stdin.lock().await.as_mut() {
        Some(stdin) => stdin.write_all(format!("{payload}\n").as_bytes()).await.is_ok(),
        None => false,
    }
}
