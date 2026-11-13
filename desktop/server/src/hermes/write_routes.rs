//! `/api/hermes/*` writes and the reads that go with them (skills, a task's instructions). Bodies are
//! checked as strictly as before: only the expected fields, with their types and lengths (counted like
//! JavaScript), and trimmed where the former schemas trimmed.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use regex::Regex;
use serde_json::{Map, Value};

use super::manage::{job_detail, manage_card, manage_job};
use super::mcp_call::call_mcp_tool;
use super::profile_editor::{ProfileEdit, save_profile_file};
use super::skills::{NAME, NewSkill, SkillEdit, create_profile_skill, list_profile_skills, read_profile_skill, save_profile_skill};
use crate::AppState;
use crate::js::utf16_len;
use crate::security::{Failure, error};

static PROFILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^profile-[a-f0-9]{24}$").unwrap());
static ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,80}$").unwrap());
static SKILL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^skill-[a-f0-9]{24}$").unwrap());
static REVISION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-f0-9]{24}$").unwrap());

const SMALL: usize = 16 * 1024;
const LARGE: usize = 256 * 1024;

/// The JSON object of a request body; size and syntax refusals answer like the former error handler.
fn object(body: &Bytes, limit: usize) -> Result<Map<String, Value>, Box<Response>> {
    if body.len() > limit {
        return Err(Box::new(error(StatusCode::PAYLOAD_TOO_LARGE, "El archivo o la solicitud supera el tamaño permitido.")));
    }
    if body.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Ok(Map::new()),
        Err(_) => Err(Box::new(error(StatusCode::BAD_REQUEST, "No se pudo procesar la solicitud."))),
    }
}

/// Field checks with the former schemas' rules; Err(()) means the body is not valid.
struct Fields<'a>(&'a Map<String, Value>);

impl Fields<'_> {
    fn only(&self, allowed: &[&str]) -> Result<(), ()> {
        if self.0.keys().all(|k| allowed.contains(&k.as_str())) { Ok(()) } else { Err(()) }
    }
    /// A string of `min..=max` UTF-16 units (after trimming when `trim`); None when absent.
    fn text(&self, key: &str, min: usize, max: usize, trim: bool) -> Result<Option<String>, ()> {
        match self.0.get(key) {
            None => Ok(None),
            Some(Value::String(s)) => {
                let s = if trim { s.trim().to_string() } else { s.clone() };
                let length = utf16_len(&s);
                if length < min || length > max { Err(()) } else { Ok(Some(s)) }
            }
            Some(_) => Err(()),
        }
    }
    fn required(&self, key: &str, min: usize, max: usize, trim: bool) -> Result<String, ()> {
        self.text(key, min, max, trim)?.ok_or(())
    }
    fn flag(&self, key: &str) -> Result<bool, ()> {
        match self.0.get(key) {
            None => Ok(false),
            Some(Value::Bool(b)) => Ok(*b),
            Some(_) => Err(()),
        }
    }
    fn revision(&self) -> Result<String, ()> {
        self.0.get("revision").and_then(Value::as_str).filter(|r| REVISION.is_match(r)).map(str::to_string).ok_or(())
    }
}

fn failed(result: Result<Value, Failure>, created: bool) -> Response {
    match result {
        Ok(value) if created => (StatusCode::CREATED, Json(value)).into_response(),
        Ok(value) => Json(value).into_response(),
        Err(failure) => failure.into_response(),
    }
}

fn backups(state: &AppState) -> std::path::PathBuf {
    state.config.data.join("profile-backups")
}

// Editing a profile writes its real Hermes files (user's decision, 18/10/2026): CSRF-protected like every
// mutation, with backup, conflict check and Hermes' memory lock.
pub async fn save_file(State(state): State<Arc<AppState>>, Path((id, name)): Path<(String, String)>, body: Bytes) -> Response {
    let map = match object(&body, LARGE) {
        Ok(map) => map,
        Err(refusal) => return *refusal,
    };
    let edit = (|| {
        if !["SOUL.md", "MEMORY.md", "USER.md"].contains(&name.as_str()) {
            return Err(());
        }
        let f = Fields(&map);
        f.only(&["content", "entries", "revision", "revealed"])?;
        let entries = match map.get("entries") {
            None => None,
            Some(Value::Array(items)) if items.len() <= 500 => {
                Some(items.iter().map(|i| i.as_str().filter(|s| utf16_len(s) <= 70_000).map(str::to_string).ok_or(())).collect::<Result<Vec<_>, _>>()?)
            }
            Some(_) => return Err(()),
        };
        let revision = match map.get("revision") {
            Some(Value::Null) => None,
            Some(_) => Some(f.revision()?),
            None => return Err(()),
        };
        Ok(ProfileEdit { content: f.text("content", 0, 70_000, false)?, entries, revision, revealed: f.flag("revealed")? })
    })();
    let Ok(edit) = edit else { return error(StatusCode::BAD_REQUEST, "Edición no válida.") };
    failed(save_profile_file(&state.hermes, &backups(&state), &id, &name, edit).await, false)
}

pub async fn job(State(state): State<Arc<AppState>>, Path((id, job_id)): Path<(String, String)>) -> Response {
    if !PROFILE.is_match(&id) || !ITEM.is_match(&job_id) {
        return error(StatusCode::NOT_FOUND, "Tarea no disponible.");
    }
    failed(job_detail(&state.hermes, &id, &job_id).await, false)
}

fn job_fields(map: &Map<String, Value>) -> Result<Map<String, Value>, ()> {
    let f = Fields(map);
    f.only(&["name", "schedule", "prompt"])?;
    let mut out = Map::new();
    out.insert("name".into(), f.required("name", 1, 100, true)?.into());
    out.insert("schedule".into(), f.required("schedule", 1, 120, true)?.into());
    out.insert("prompt".into(), f.required("prompt", 1, 4000, true)?.into());
    Ok(out)
}

pub async fn create_job(State(state): State<Arc<AppState>>, Path(id): Path<String>, body: Bytes) -> Response {
    let map = match object(&body, SMALL) {
        Ok(map) => map,
        Err(refusal) => return *refusal,
    };
    if !PROFILE.is_match(&id) {
        return error(StatusCode::NOT_FOUND, "Perfil no disponible.");
    }
    let Ok(change) = job_fields(&map) else { return error(StatusCode::BAD_REQUEST, "Indica nombre, horario e instrucciones de la tarea.") };
    failed(manage_job(&state.hermes, &id, None, change).await, true)
}

fn job_change(map: &Map<String, Value>) -> Result<Map<String, Value>, ()> {
    let f = Fields(map);
    let action = map.get("action").and_then(Value::as_str).ok_or(())?;
    let mut out = Map::new();
    out.insert("action".into(), action.into());
    if ["pause", "resume", "run", "remove"].contains(&action) {
        f.only(&["action"])?;
        return Ok(out);
    }
    if action != "update" {
        return Err(());
    }
    f.only(&["action", "name", "schedule", "prompt", "revision"])?;
    for (key, max) in [("name", 100), ("schedule", 120), ("prompt", 4000)] {
        if let Some(value) = f.text(key, 1, max, true)? {
            out.insert(key.into(), value.into());
        }
    }
    if map.contains_key("revision") {
        out.insert("revision".into(), f.revision()?.into());
    }
    if out.contains_key("prompt") && !out.contains_key("revision") {
        return Err(());
    }
    Ok(out)
}

pub async fn change_job(State(state): State<Arc<AppState>>, Path((id, job_id)): Path<(String, String)>, body: Bytes) -> Response {
    let map = match object(&body, SMALL) {
        Ok(map) => map,
        Err(refusal) => return *refusal,
    };
    if !PROFILE.is_match(&id) || !ITEM.is_match(&job_id) {
        return error(StatusCode::NOT_FOUND, "Tarea no disponible.");
    }
    let Ok(change) = job_change(&map) else { return error(StatusCode::BAD_REQUEST, "Operación no válida.") };
    failed(manage_job(&state.hermes, &id, Some(&job_id), change).await, false)
}

pub async fn create_card(State(state): State<Arc<AppState>>, Path(id): Path<String>, body: Bytes) -> Response {
    let map = match object(&body, SMALL) {
        Ok(map) => map,
        Err(refusal) => return *refusal,
    };
    if !PROFILE.is_match(&id) {
        return error(StatusCode::NOT_FOUND, "Perfil no disponible.");
    }
    let f = Fields(&map);
    let card = (|| {
        f.only(&["title", "body"])?;
        let mut out = Map::new();
        out.insert("title".into(), f.required("title", 1, 200, true)?.into());
        if let Some(body) = f.text("body", 0, 4000, false)? {
            out.insert("body".into(), body.into());
        }
        Ok::<_, ()>(out)
    })();
    let Ok(card) = card else { return error(StatusCode::BAD_REQUEST, "Indica un título de hasta 200 caracteres.") };
    failed(manage_card(&state.hermes, &id, None, card).await, true)
}

fn card_change(map: &Map<String, Value>) -> Result<Map<String, Value>, ()> {
    let f = Fields(map);
    let action = map.get("action").and_then(Value::as_str).ok_or(())?;
    let mut out = Map::new();
    out.insert("action".into(), action.into());
    match action {
        "complete" | "unblock" | "archive" => f.only(&["action"])?,
        "block" => {
            f.only(&["action", "reason"])?;
            if let Some(reason) = f.text("reason", 0, 500, false)? {
                out.insert("reason".into(), reason.into());
            }
        }
        "comment" => {
            f.only(&["action", "body"])?;
            out.insert("body".into(), f.required("body", 1, 4000, true)?.into());
        }
        _ => return Err(()),
    }
    Ok(out)
}

pub async fn change_card(State(state): State<Arc<AppState>>, Path((id, card_id)): Path<(String, String)>, body: Bytes) -> Response {
    let map = match object(&body, SMALL) {
        Ok(map) => map,
        Err(refusal) => return *refusal,
    };
    if !PROFILE.is_match(&id) || !ITEM.is_match(&card_id) {
        return error(StatusCode::NOT_FOUND, "Tarjeta no disponible.");
    }
    let Ok(change) = card_change(&map) else { return error(StatusCode::BAD_REQUEST, "Operación no válida.") };
    failed(manage_card(&state.hermes, &id, Some(&card_id), change).await, false)
}

// One MCP tool called by hand with the arguments the user confirmed (user's decision, 18/10/2026).
pub async fn call_tool(State(state): State<Arc<AppState>>, Path((id, server, tool)): Path<(String, String, String)>, body: Bytes) -> Response {
    let map = match object(&body, SMALL) {
        Ok(map) => map,
        Err(refusal) => return *refusal,
    };
    let args = match (Fields(&map).only(&["args"]), map.get("args")) {
        (Ok(()), Some(Value::Object(args))) if args.keys().all(|k| utf16_len(k) <= 200) => args.clone(),
        _ => return error(StatusCode::BAD_REQUEST, "Argumentos no válidos."),
    };
    if utf16_len(&tool) > 200 {
        return error(StatusCode::BAD_REQUEST, "Argumentos no válidos.");
    }
    failed(call_mcp_tool(&state.hermes, &id, &server, &tool, args).await, false)
}

// The profile's real skills (user's decision, 20/10/2026): list and read are local and never reach the
// model; save and create are CSRF-protected, revision-checked and backed up first.
pub async fn skills(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    if !PROFILE.is_match(&id) {
        return error(StatusCode::NOT_FOUND, "Perfil no disponible.");
    }
    let listing = tokio::task::spawn_blocking(move || list_profile_skills(&state.hermes, &id).map(|l| serde_json::to_value(l).unwrap_or_default())).await;
    match listing {
        Ok(Ok(value)) => Json(value).into_response(),
        _ => error(StatusCode::NOT_FOUND, "Perfil no disponible."),
    }
}

pub async fn skill(State(state): State<Arc<AppState>>, Path((id, skill_id)): Path<(String, String)>, Query(query): Query<HashMap<String, String>>) -> Response {
    if !PROFILE.is_match(&id) || !SKILL.is_match(&skill_id) {
        return error(StatusCode::NOT_FOUND, "Skill no disponible.");
    }
    let reveal = query.get("reveal").is_some_and(|v| v == "1");
    let read = tokio::task::spawn_blocking(move || read_profile_skill(&state.hermes, &id, &skill_id, reveal)).await;
    failed(read.unwrap_or_else(|_| Err(Failure::new(500, "No se pudo completar la operación con la skill."))), false)
}

pub async fn save_skill(State(state): State<Arc<AppState>>, Path((id, skill_id)): Path<(String, String)>, body: Bytes) -> Response {
    let map = match object(&body, LARGE) {
        Ok(map) => map,
        Err(refusal) => return *refusal,
    };
    let f = Fields(&map);
    let edit = (|| {
        if !PROFILE.is_match(&id) || !SKILL.is_match(&skill_id) {
            return Err(());
        }
        f.only(&["content", "revision", "revealed"])?;
        Ok(SkillEdit { content: f.required("content", 0, 70_000, false)?, revision: f.revision()?, revealed: f.flag("revealed")? })
    })();
    let Ok(edit) = edit else { return error(StatusCode::BAD_REQUEST, "Edición no válida.") };
    failed(save_profile_skill(&state.hermes, &backups(&state), &id, &skill_id, edit).await, false)
}

pub async fn create_skill(State(state): State<Arc<AppState>>, Path(id): Path<String>, body: Bytes) -> Response {
    let map = match object(&body, LARGE) {
        Ok(map) => map,
        Err(refusal) => return *refusal,
    };
    let f = Fields(&map);
    let skill = (|| {
        if !PROFILE.is_match(&id) {
            return Err(());
        }
        f.only(&["category", "name", "description", "body"])?;
        let category = f.required("category", 1, 64, false)?;
        let name = f.required("name", 1, 64, false)?;
        if !NAME.is_match(&category) || !NAME.is_match(&name) {
            return Err(());
        }
        Ok(NewSkill { category, name, description: f.required("description", 0, 500, false)?, body: f.required("body", 1, 70_000, true)? })
    })();
    let Ok(skill) = skill else { return error(StatusCode::BAD_REQUEST, "Categoría y nombre: 1 a 64 caracteres, empezando por letra o número, sin espacios.") };
    failed(create_profile_skill(&state.hermes, &backups(&state), &id, skill).await, true)
}
