//! A profile's scheduled tasks and kanban cards (user's decision, 18/10/2026), managed with Hermes' own
//! functions in the built-in hermes_manage.py. The client names a profile id from the catalog and a task or
//! card id; the profile is resolved here, and the script only touches what belongs to that profile.

use std::time::Duration;

use serde_json::{Map, Value, json};

use super::catalog::HermesDiscovery;
use super::python::{MANAGE, RunError, home, run_python};
use crate::secret_lines::{mask_secrets, restore_secrets};
use crate::security::Failure;

async fn run(discovery: &HermesDiscovery, root: &std::path::Path, request: Value) -> Result<Map<String, Value>, Failure> {
    let location = discovery.location();
    if !location.python.exists() {
        return Err(Failure::new(500, "No se encuentra la instalación de Hermes."));
    }
    let env = [
        // macOS and Linux keep the fixed system PATH; Windows has none, so there it is the user's.
        ("PATH", if cfg!(windows) { super::python::user_path() } else { "/usr/bin:/bin".to_string() }),
        ("HOME", home()),
        ("HERMES_HOME", root.display().to_string()),
        ("AGORA_HERMES_PATH", location.installation.display().to_string()),
        ("PYTHONDONTWRITEBYTECODE", "1".into()),
    ];
    // Longer than Hermes' own 30 s wait for the jobs lock, so its answer arrives first.
    let data = run_python(&location.python, MANAGE, &env, &request, Duration::from_secs(45), false).await.map_err(|error| match error {
        RunError::Spawn => Failure::new(500, "No se pudo ejecutar Hermes."),
        RunError::Timeout => Failure::new(504, "Hermes tardó demasiado: no se sabe si el cambio se aplicó. Espera unos segundos y comprueba la lista."),
        RunError::Output => Failure::new(500, "Hermes no pudo completar la operación."),
    })?;
    let Value::Object(data) = data else { return Err(Failure::new(500, "Hermes no pudo completar la operación.")) };
    if data.get("ok") != Some(&Value::Bool(true)) {
        let raw = data.get("error").and_then(Value::as_str);
        let message = raw.map(|e| mask_secrets(e).text).unwrap_or_else(|| "Hermes rechazó la operación.".into());
        let missing = raw.is_some_and(|e| e.contains("no existe") || e.contains("no está asignada"));
        return Err(Failure::new(if missing { 404 } else { 400 }, message));
    }
    Ok(data)
}

fn profile(discovery: &HermesDiscovery, id: &str) -> Result<(String, std::path::PathBuf), Failure> {
    let missing = || Failure::new(404, "Perfil no disponible.");
    let name = discovery.scan(true).profiles.into_iter().find(|p| p.id == id).ok_or_else(missing)?.name;
    let (root, _) = discovery.activity_targets().map_err(|_| missing())?;
    Ok((name, root))
}

/// A task's instructions for the editor: lines that look like credentials stay hidden unless edited back in.
pub async fn job_detail(discovery: &HermesDiscovery, id: &str, job_id: &str) -> Result<Value, Failure> {
    let (name, root) = profile(discovery, id)?;
    let data = run(discovery, &root, json!({ "profile": name, "kind": "job", "action": "detail", "jobId": job_id })).await?;
    let mut job = data.get("job").and_then(Value::as_object).cloned().unwrap_or_default();
    let masked = mask_secrets(job.get("prompt").and_then(Value::as_str).unwrap_or(""));
    job.insert("prompt".into(), Value::String(masked.text));
    job.insert("hidden".into(), json!(masked.hidden.len()));
    Ok(Value::Object(job))
}

pub async fn manage_job(discovery: &HermesDiscovery, id: &str, job_id: Option<&str>, change: Map<String, Value>) -> Result<Value, Failure> {
    let (name, root) = profile(discovery, id)?;
    let mut request = change.clone();
    // An edited prompt was shown masked: hidden lines come back from the task as stored in Hermes, which must
    // still be the version the user opened (the script checks the revision again right before saving).
    if let (Some(job_id), Some("update"), Some(prompt)) = (job_id, change.get("action").and_then(Value::as_str), change.get("prompt").and_then(Value::as_str)) {
        let current = run(discovery, &root, json!({ "profile": name, "kind": "job", "action": "detail", "jobId": job_id })).await?;
        let job = current.get("job");
        if job.and_then(|j| j.get("revision")) != change.get("revision") {
            return Err(Failure::new(409, "Las instrucciones de la tarea cambiaron mientras las editabas. Vuelve a abrirla para ver la versión actual."));
        }
        let stored = job.and_then(|j| j.get("prompt")).and_then(Value::as_str).unwrap_or("");
        let restored = restore_secrets(prompt, &mask_secrets(stored).hidden).map_err(|e| Failure::new(400, e.to_string()))?;
        request.insert("prompt".into(), Value::String(restored));
    }
    request.insert("profile".into(), Value::String(name));
    request.insert("kind".into(), json!("job"));
    match job_id {
        Some(job_id) => request.insert("jobId".into(), json!(job_id)),
        None => request.insert("action".into(), json!("create")),
    };
    Ok(Value::Object(run(discovery, &root, Value::Object(request)).await?))
}

pub async fn manage_card(discovery: &HermesDiscovery, id: &str, card_id: Option<&str>, change: Map<String, Value>) -> Result<Value, Failure> {
    let (name, root) = profile(discovery, id)?;
    let mut request = change;
    request.insert("profile".into(), Value::String(name));
    request.insert("kind".into(), json!("card"));
    match card_id {
        Some(card_id) => request.insert("cardId".into(), json!(card_id)),
        None => request.insert("action".into(), json!("create")),
    };
    Ok(Value::Object(run(discovery, &root, Value::Object(request)).await?))
}
