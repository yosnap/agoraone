# Bots con sus herramientas (0.13.0)

Estado: implementado en 0.13.0, con la revisión de seguridad aplicada · Decisión del usuario (18/10/2026): los chats de perfil usan sus herramientas y MCP reales, como en Telegram; cada acción que cambia algo pide confirmación en AgoraOne. Las de solo lectura van sin preguntar.

## Resultado esperado
Conversar con un perfil en AgoraOne equivale a hablar con ese bot en Telegram: mismo modelo y proveedor del perfil, mismos toolsets (los de `telegram` del perfil), sus MCP y su memoria. Antes de ejecutar una herramienta que muta, la conversación muestra una tarjeta «Quiere usar X con estos datos» con «Permitir» y «Denegar». Si se deniega o nadie responde en 5 minutos, el modelo recibe «denegado por el usuario».

## Diseño
- `server/hermes_agent_bridge.py` (nuevo, proceso por conversación de perfil):
  - Entra en `gateway.run._profile_runtime_scope(perfil)`: home, secretos y terminal del perfil, sin `os.environ`.
  - Construye `AIAgent` como `api_server._create_agent`: `_resolve_runtime_agent_kwargs`, `_resolve_gateway_model`, `_get_platform_tools(cfg, "telegram")`, `session_db` del perfil, `session_id` propio `agoraone-<conversación>`, `platform="agoraone"`.
  - `set_session_vars(platform="agoraone", session_key=…)`: contexto de aprobación «gateway» con un humano que responde.
  - Gancho `pre_tool_call` en el gestor de plugins del perfil: devuelve `approve` para toda herramienta que no esté en la lista de solo lectura, y para MCP sin `readOnlyHint`. Así lo desconocido se confirma por defecto.
  - `register_gateway_notify` emite `approval` por stdout; el hilo principal lee stdin y llama a `resolve_gateway_approval(…, "once" | "deny", request_id)`. Nunca «session» ni «always» (no persiste nada en la configuración).
  - Dentro del proceso, la confirmación es obligatoria aunque el perfil tenga `approvals.mode: off` o yolo: se fuerza el modo manual solo en memoria, sin escribir ficheros.
  - Al terminar: `agent.close()` y `shutdown_mcp_servers`.
- Servidor TS:
  - El trabajador del perfil usa este puente cuando el perfil tiene herramientas.
  - `POST /api/conversations/:id/approvals/:requestId` con CSRF y `{choice: "once" | "deny"}`.
  - Eventos de herramienta (solo nombre e inicio y fin) y aprobaciones pendientes por SSE.
  - Los datos que se muestran en la tarjeta se enmascaran con `secret-lines` y se recortan.
- UI: tarjeta de aprobación en el chat del perfil y línea «Usó web_search» por herramienta. Aviso visible de que el chat ya puede actuar.
- Luma sigue sin herramientas.

## Criterios de aceptación
- Prueba automática con un perfil ficticio y un modelo falso local (sin tokens ni perfiles reales):
  - Una herramienta de lectura se ejecuta sin preguntar.
  - Una mutante se detiene hasta «Permitir» y se ejecuta, o hasta «Denegar» y no se ejecuta y el modelo recibe el bloqueo.
  - Con `approvals.mode: off` en el perfil ficticio, se sigue pidiendo confirmación.
- El aislamiento de perfiles se mantiene: un perfil no puede responder ni aprobar en otra conversación (prueba de aislamiento).
- `npm test`, `npm run build` y verificación de navegador con aprobación interceptada.
- No se modifica `~/.hermes/hermes-agent` ni la configuración de ningún perfil.

## Riesgos
- Gasta tokens del proveedor del perfil (el mismo que Telegram).
- Memoria escrita por la herramienta `memory` de Hermes, que se confirma antes.
- Procesos MCP del perfil arrancados por conversación; se cierran al terminar o caducar.

## Revisión de seguridad aplicada
- Decisiones del usuario:
  - Las herramientas de red piden permiso.
  - Las tareas programadas y los trabajos en segundo plano se bloquean.
  - La memoria se escribe con la herramienta de Hermes tras «Permitir», con copia previa por turno.
- Corregido:
  - La tarjeta oculta solo fragmentos y avisa de lo oculto o recortado.
  - Revisión posterior al turno desactivada.
  - Gancho permanente que bloquea fuera de turno.
  - Argumentos indexados por petición.
  - Caducidad visible.
  - Detener.
  - Mensaje de fallo con las herramientas usadas.
  - Grupo de procesos y cupos separados.
  - Canal de protocolo en un descriptor propio.
  - Entorno sin credenciales del perfil principal y `_YOLO_MODE_FROZEN`.
  - PATH del usuario para los MCP.
  - Runtime codex rechazado.
  - Nombre de perfil endurecido.
  - Tarjeta accesible.
- Pendiente:
  - Recuperar tarjetas pendientes tras recargar la página: hoy el turno sigue hasta que se detiene o caduca.
  - MCP con `readOnlyHint`: siempre preguntan.
  - Contexto de herramientas entre turnos: el historial que recibe el agente es solo texto.
