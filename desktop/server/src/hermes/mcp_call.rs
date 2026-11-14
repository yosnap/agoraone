//! Calling one MCP tool of a profile by hand (user's decision, 18/10/2026), in the built-in
//! hermes_mcp_call.py: the client names the profile, an opaque server id and a tool from Hermes' saved
//! catalogue for that server, with the arguments the user wrote and confirmed. Only one call runs per server
//! at a time.

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde_json::{Map, Value, json};

use super::catalog::HermesDiscovery;
use super::python::{MCP_CALL, RunError, home, run_python, user_path};
use crate::js::js_string;
use crate::secret_lines::mask_secrets;
use crate::security::Failure;

static RUNNING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// Frees the server's slot however the call ends.
struct Slot(String);

impl Drop for Slot {
    fn drop(&mut self) {
        RUNNING.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.0);
    }
}

fn quoted(names: &[&str]) -> String {
    names.iter().map(|n| format!("«{n}»")).collect::<Vec<_>>().join(", ")
}

pub async fn call_mcp_tool(discovery: &HermesDiscovery, profile_id: &str, server_id: &str, tool: &str, args: Map<String, Value>) -> Result<Value, Failure> {
    let target = discovery.mcp_server(profile_id, server_id).map_err(|_| Failure::new(404, "Servidor MCP no disponible para este perfil."))?;
    if target.config.get("enabled") == Some(&Value::Bool(false)) {
        return Err(Failure::new(409, "Este servidor está deshabilitado en Hermes para este perfil."));
    }
    let catalogue = discovery.mcp_tools(profile_id, server_id).map_err(|_| Failure::new(404, "Servidor MCP no disponible para este perfil."))?;
    let entry = ["cached", "expired"]
        .contains(&catalogue.state)
        .then(|| catalogue.tools.iter().find(|t| t.name == tool))
        .flatten()
        .ok_or_else(|| Failure::new(404, "Esa herramienta no está en el catálogo guardado de este servidor."))?;
    // Only the parameters the tool declares, and all of its required ones.
    let unknown: Vec<&str> = args.keys().map(String::as_str).filter(|key| !entry.parameters.iter().any(|p| p.name == *key)).collect();
    if !unknown.is_empty() {
        let noun = if unknown.len() == 1 { "el parámetro" } else { "los parámetros" };
        return Err(Failure::new(400, format!("La herramienta no tiene {noun} {}.", quoted(&unknown))));
    }
    let missing: Vec<&str> = entry.parameters.iter().filter(|p| p.required && !args.contains_key(&p.name)).map(|p| p.name.as_str()).collect();
    if !missing.is_empty() {
        return Err(Failure::new(400, format!("Falta {}, que es obligatorio.", quoted(&missing))));
    }
    let location = discovery.location();
    let key = format!("{profile_id}:{server_id}");
    if !RUNNING.lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone()) {
        return Err(Failure::new(409, "Ya hay una llamada en curso a este servidor. Espera a que termine."));
    }
    let _slot = Slot(key);
    if !location.python.exists() {
        return Err(Failure::new(500, "No se encuentra la instalación de Hermes."));
    }
    // The user's PATH (no secrets) so launchers like npx or uvx are found, as in the profile's gateway; locale,
    // temporary folder and user name (no secrets) because some servers need them to start.
    let mut env = vec![
        ("PATH", user_path()),
        ("HOME", home()),
        ("HERMES_HOME", target.root.display().to_string()),
        ("AGORA_HERMES_PATH", location.installation.display().to_string()),
        ("PYTHONDONTWRITEBYTECODE", "1".into()),
    ];
    for name in ["LANG", "LC_ALL", "TMPDIR", "USER", "LOGNAME"] {
        if let Ok(value) = std::env::var(name)
            && !value.is_empty()
        {
            env.push((name, value));
        }
    }
    let request = json!({ "profile": target.profile, "server": target.server, "tool": tool, "args": args });
    // Own process group: the MCP server it starts goes with it if it has to be stopped.
    let data = run_python(&location.python, MCP_CALL, &env, &request, Duration::from_secs(120), true).await.map_err(|error| match error {
        RunError::Spawn => Failure::new(500, "No se pudo ejecutar Hermes."),
        RunError::Timeout => Failure::new(504, "La herramienta tardó más de 2 minutos y se detuvo: no se sabe si llegó a completar su acción en el servicio."),
        RunError::Output => Failure::new(500, "Hermes no pudo completar la llamada."),
    })?;
    // The service's own error text is shown masked, like its results.
    if data.get("ok") != Some(&Value::Bool(true)) {
        let message = data.get("error").and_then(Value::as_str).map(|e| mask_secrets(e).text).unwrap_or_else(|| "La llamada falló.".into());
        return Err(Failure::new(502, message));
    }
    // The answer is shown to the user only; lines that look like credentials stay hidden, as everywhere else.
    let result = match data.get("result") {
        None | Some(Value::Null) => String::new(),
        other => js_string(other),
    };
    let masked = mask_secrets(&result);
    Ok(json!({ "result": masked.text, "hidden": masked.hidden.len(), "truncated": data.get("truncated") == Some(&Value::Bool(true)) }))
}
