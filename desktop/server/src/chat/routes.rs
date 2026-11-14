//! `/api/conversations/*`: create and read a conversation, send a message (JSON, or NDJSON progress when the
//! browser asks for `application/x-ndjson`), stop a running turn and answer a pending tool call. Only the
//! owner reaches a conversation; at most two turns run at once and one per conversation.

use std::convert::Infallible;
use std::sync::{Arc, LazyLock, Mutex};

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use regex::Regex;
use serde_json::{Value, json};

use super::store::{Conversation, Identity, IdentityFile, Message, Source};
use super::worker::Progress;
use super::{PROFILE_REFUSED, ProfileContext, Turn, answer_approval, cancel_turn, profile_context, read_attachment};
use crate::AppState;
use crate::hermes::profile_editor::backup_memories;
use crate::hermes::write_routes::object;
use crate::js::{js_trim, utf16_len};
use crate::library::Document;
use crate::secret_lines::mask_secrets;
use crate::security::{Owner, error};

static PROFILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^profile-[a-f0-9]{24}$").unwrap());
static REQUEST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-f0-9]{32}$").unwrap());
static PATHLIKE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)/|\\|ENOENT|EACCES|EPERM|errno").unwrap());
const SMALL: usize = 16 * 1024;

fn view(data: &Conversation) -> Value {
    let mut out = json!({ "id": data.id, "messages": data.messages });
    if let Some(profile) = &data.profile_id {
        out["profileId"] = profile.clone().into();
    }
    out
}

pub async fn create(State(state): State<Arc<AppState>>, Extension(Owner(owner)): Extension<Owner>, body: Bytes) -> Response {
    let map = match object(&body, SMALL) {
        Ok(map) => map,
        Err(refusal) => return *refusal,
    };
    let luma = map.len() == 2 && map.get("agent") == Some(&json!("luma")) && map.get("context") == Some(&json!("library-lobby"));
    let profile = map.get("profileId").and_then(Value::as_str).filter(|p| map.len() == 1 && PROFILE.is_match(p)).map(str::to_string);
    if !luma && profile.is_none() {
        return error(StatusCode::BAD_REQUEST, "Selecciona Luma o un perfil detectado. No se admiten instrucciones, herramientas ni configuración de ejecución.");
    }
    let created = tokio::task::spawn_blocking(move || {
        let context = profile.map(|id| profile_context(&state.hermes, &id)).transpose()?;
        state.conversations.create(&owner, context.as_ref().map(|c| (c.id.as_str(), c.agent_id.as_str()))).map_err(|_| PROFILE_REFUSED.to_string())
    })
    .await;
    match created {
        Ok(Ok(data)) => (StatusCode::CREATED, Json(view(&data))).into_response(),
        _ => error(StatusCode::FORBIDDEN, PROFILE_REFUSED),
    }
}

pub async fn read(State(state): State<Arc<AppState>>, Extension(Owner(owner)): Extension<Owner>, Path(id): Path<String>) -> Response {
    match state.conversations.get(&id, &owner) {
        Some(data) => Json(view(&data)).into_response(),
        None => error(StatusCode::NOT_FOUND, "Conversación no disponible."),
    }
}

/// Frees the conversation's turn slot however the turn ends.
struct Busy {
    state: Arc<AppState>,
    id: String,
}

impl Drop for Busy {
    fn drop(&mut self) {
        self.state.busy.lock().unwrap().remove(&self.id);
        self.state.stopped.lock().unwrap().remove(&self.id);
    }
}

/// The turn's outcome as the conversation (saved) or the message for the user.
async fn finish(state: &Arc<AppState>, mut data: Conversation, message: String, document: Option<Document>, profile: Option<ProfileContext>, reply: Result<String, String>, used: &Mutex<Vec<String>>) -> Result<Value, String> {
    let used = used.lock().unwrap().clone();
    let failed = |reason: String| {
        let names = used.join(", ");
        if state.stopped.lock().unwrap().contains(&data.id) {
            format!("Turno detenido.{}", if used.is_empty() { String::new() } else { format!(" Antes de detenerlo usó: {names}.") })
        } else if !used.is_empty() {
            format!("El turno no terminó, pero antes usó: {names}. Revisa el resultado antes de reintentar.")
        } else if PATHLIKE.is_match(&reason) {
            "No se pudo conversar con Hermes.".into()
        } else {
            reason
        }
    };
    let reply = reply.map_err(failed)?;
    let sources = document.map(|d| vec![Source { id: d.id, title: d.title, revision: d.revision }]);
    let identity = profile.map(|p| Identity { profile_id: p.id, files: p.files.into_iter().map(|f| IdentityFile { name: f.name, revision: f.revision }).collect() });
    data.messages.push(Message { role: "user".into(), content: message, tools: None, sources, identity });
    let tools = (!used.is_empty()).then(|| used.into_iter().take(30).collect());
    data.messages.push(Message { role: "assistant".into(), content: mask_secrets(&reply).text, tools, sources: None, identity: None });
    let (saving, store) = (data.clone(), state.clone());
    match tokio::task::spawn_blocking(move || store.conversations.save(&saving)).await {
        Ok(Ok(())) => {
            let mut result = view(&data);
            result["source"] = "hermes".into();
            Ok(result)
        }
        _ => Err("No se pudo conversar con Hermes.".into()),
    }
}

fn line(event: &Value) -> Bytes {
    Bytes::from(format!("{event}\n"))
}

pub async fn send(State(state): State<Arc<AppState>>, Extension(Owner(owner)): Extension<Owner>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(data) = state.conversations.get(&id, &owner) else { return error(StatusCode::NOT_FOUND, "Conversación no disponible.") };
    let map = match object(&body, SMALL) {
        Ok(map) => map,
        Err(refusal) => return *refusal,
    };
    let message = map.get("message").and_then(Value::as_str).map(|m| js_trim(m).to_string()).filter(|m| (1..=6000).contains(&utf16_len(m)));
    let document_id = match map.get("documentId") {
        None => Ok(None),
        Some(Value::String(d)) if utf16_len(d) <= 64 => Ok(Some(d.clone())),
        Some(_) => Err(()),
    };
    let (Some(message), Ok(document_id), true) = (message, document_id, map.keys().all(|k| k == "message" || k == "documentId")) else {
        return error(StatusCode::BAD_REQUEST, "Escribe entre 1 y 6000 caracteres.");
    };
    if data.messages.iter().map(|m| utf16_len(&m.content)).sum::<usize>() > 60_000 {
        return error(StatusCode::CONFLICT, "Esta conversación llegó a su límite. Abre una nueva.");
    }
    {
        // Checked and taken under one lock, so two sends at once cannot both start a turn.
        let mut busy = state.busy.lock().unwrap();
        if busy.len() >= 2 || busy.contains(&data.id) {
            return error(StatusCode::CONFLICT, "Hay una respuesta en curso. Espera antes de continuar.");
        }
        busy.insert(data.id.clone());
    }
    let guard = Busy { state: state.clone(), id: data.id.clone() };
    let streaming = headers.get(header::ACCEPT).is_some_and(|a| a == "application/x-ndjson");

    // The profile is validated before any attachment is read, so a revoked profile reads nothing.
    let (prepare, profile_id, agent) = (state.clone(), data.profile_id.clone(), data.agent.clone());
    let prepared = tokio::task::spawn_blocking(move || -> Result<(Option<ProfileContext>, Option<Document>), String> {
        let profile = profile_id.map(|p| profile_context(&prepare.hermes, &p)).transpose()?;
        if profile.as_ref().is_some_and(|p| p.agent_id != agent) {
            return Err(PROFILE_REFUSED.into());
        }
        let document = document_id.map(|d| read_attachment(&prepare, &d, &owner)).transpose()?;
        // The profile's own agent may update its memory (after the user allows it): copy it first.
        if let Some(profile) = &profile
            && prepare.backup_memories
        {
            backup_memories(&prepare.hermes, &prepare.config.data.join("profile-backups"), &profile.id);
        }
        Ok((profile, document))
    })
    .await;
    let (profile, document) = match prepared {
        Ok(Ok(prepared)) => prepared,
        Ok(Err(message)) => return error(StatusCode::FORBIDDEN, &message),
        Err(_) => return error(StatusCode::FORBIDDEN, PROFILE_REFUSED),
    };

    // Names of the tools the profile used in this turn, kept with its answer (never their arguments or results).
    let used = Arc::new(Mutex::new(Vec::<String>::new()));
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
    let progress: Progress = {
        let (used, sender) = (used.clone(), sender.clone());
        Arc::new(move |event: Value| {
            if event.get("type").and_then(Value::as_str) == Some("tool")
                && event.get("state").and_then(Value::as_str) == Some("end")
                && let Some(name) = event.get("name").and_then(Value::as_str)
            {
                let mut used = used.lock().unwrap();
                if !used.iter().any(|n| n == name) {
                    used.push(name.to_string());
                }
            }
            if streaming {
                let _ = sender.send(line(&event));
            }
        })
    };
    let adapter = if profile.is_some() { state.agent.clone() } else { state.luma.clone() };
    let turn = Turn { session_id: data.hermes_session_id.clone(), message: message.clone(), history: data.messages.clone(), document: document.clone(), profile: profile.clone() };
    let run = async move {
        let reply = adapter(turn, Some(progress)).await;
        let outcome = finish(&state, data, message, document, profile, reply, &used).await;
        drop(guard);
        outcome
    };
    if !streaming {
        return match run.await {
            Ok(result) => Json(result).into_response(),
            Err(message) => error(StatusCode::BAD_GATEWAY, &message),
        };
    }
    let _ = sender.send(line(&json!({ "type": "status", "stage": "starting" })));
    tokio::spawn(async move {
        let event = match run.await {
            Ok(conversation) => json!({ "type": "done", "conversation": conversation }),
            Err(message) => json!({ "type": "error", "error": message }),
        };
        let _ = sender.send(line(&event));
    });
    // The stream ends when the turn has sent its last event and the progress reporter is gone.
    let body = futures_util::stream::poll_fn(move |context| receiver.poll_recv(context).map(|item| item.map(Ok::<_, Infallible>)));
    let mut response = Response::new(Body::from_stream(body));
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/x-ndjson"));
    response
}

/// Stops this conversation's running turn (owner only): pending actions are denied, the agent interrupted.
pub async fn cancel(State(state): State<Arc<AppState>>, Extension(Owner(owner)): Extension<Owner>, Path(id): Path<String>) -> Response {
    let Some(data) = state.conversations.get(&id, &owner) else { return error(StatusCode::NOT_FOUND, "No hay ningún turno en curso.") };
    let running = data.profile_id.is_some() && state.busy.lock().unwrap().contains(&data.id);
    if !running || !cancel_turn(&data.hermes_session_id).await {
        return error(StatusCode::NOT_FOUND, "No hay ningún turno en curso.");
    }
    state.stopped.lock().unwrap().insert(data.id.clone());
    Json(json!({ "cancelled": data.id })).into_response()
}

/// The user's answer to a tool call a profile wants to make in this conversation (owner only).
pub async fn approve(State(state): State<Arc<AppState>>, Extension(Owner(owner)): Extension<Owner>, Path((id, request)): Path<(String, String)>, body: Bytes) -> Response {
    let map = match object(&body, SMALL) {
        Ok(map) => map,
        Err(refusal) => return *refusal,
    };
    let Some(data) = state.conversations.get(&id, &owner).filter(|d| d.profile_id.is_some() && REQUEST.is_match(&request)) else {
        return error(StatusCode::NOT_FOUND, "No hay ninguna acción pendiente.");
    };
    let Some(choice) = map.get("choice").and_then(Value::as_str).filter(|c| map.len() == 1 && ["once", "deny"].contains(c)) else {
        return error(StatusCode::BAD_REQUEST, "Respuesta no válida.");
    };
    if !answer_approval(&data.hermes_session_id, &request, choice).await {
        return error(StatusCode::NOT_FOUND, "Esta acción ya no está pendiente.");
    }
    Json(json!({ "answered": request, "choice": choice })).into_response()
}
