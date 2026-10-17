# Actividad real de Hermes (17/10/2026)

Revisión de solo lectura de la instalación local (Hermes 0.21.4, commit 28aceb3). No se iniciaron procesos, no se modificó configuración ni perfiles y no se leyó contenido de mensajes, prompts ni credenciales.

## Fuentes disponibles

| Fuente | Qué contiene | Alcance | Fiabilidad |
| --- | --- | --- | --- |
| `~/.hermes/gateway_state.json` | Estado del gateway (`running`…), PID, `updated_at`, `active_agents`, `served_profiles` y, por plataforma, `state`, `needs_attention`, `retrying_since`, error | Global; plataformas por perfil (`telegram` = principal, `<perfil>:telegram`…) | Alta si `updated_at` es reciente y el PID sigue vivo |
| `~/.hermes/state/gateway.lifecycle.json` | Fase del ciclo de vida y si hubo cierre no limpio | Global | Alta |
| `state.db` raíz y `profiles/*/state.db`, tabla `sessions` | `source` (telegram, desktop, cron, cli, acp, subagent), `started_at`, `ended_at`, `last_activity_at`, `message_count`, `tool_call_count` | Por perfil | Media: `ended_at` queda nulo en muchas sesiones cerradas, así que «abierta» no significa «activa»; usar la antigüedad de `last_activity_at` |
| `profiles/*/cron/jobs.json` | Nombre, `enabled`, `state`, `schedule_display`, `last_status`, `last_run_at`, `next_run_at` | Por perfil | Alta. Los campos `prompt`, `origin` y similares no se leen |
| `~/.hermes/kanban.db` | Tareas, ejecuciones por perfil y eventos | Global con perfil por ejecución | Esquema presente; hoy vacío |
| `runtime/active_sessions.json` | Sesiones de ejecución activas | Global | Hoy vacío |

`active_agents` es un recuento global: Hermes no publica qué perfil está trabajando en cada momento. `active_work` solo se rellena durante un drenado del gateway.

## Lo que no está disponible
- Estado vivo de cada conexión MCP: hay configuración, cachés de descubrimiento y llamadas registradas, pero no se comprueba si el servidor responde ahora.
- Atribución en tiempo real de un agente activo a un perfil concreto.

## Implementado
El usuario aprobó los cinco puntos, con nombres de tareas programadas visibles y sin títulos de conversaciones.

- **Backend**: `GET /api/hermes/activity` (protegido por la cabecera CSRF como el resto de `/api/hermes`). Lector en `server/hermes-activity.ts`; tipos en `shared/hermes-activity.ts`. Abre SQLite con `withHermesDatabase` (`server/hermes-database.ts`) y JSON con `readHermesFile` (sin enlaces simbólicos ni duros, dentro de `~/.hermes`). Los perfiles salen del catálogo; el cliente no envía rutas.
- **Gateway**: «en marcha» solo si el PID existe, el estado es `running`/`degraded` y el registro más reciente (estado o latido) tiene menos de 120 s, el mismo umbral que usa Hermes. Si no, «detenido», «sin datos recientes» o «sin estado registrado», y las conexiones pasan a «sin datos recientes».
- **Campos leídos**: sesiones, solo `source`, `started_at` y `last_activity_at`; tareas programadas, nombre, habilitación, estado, horario, último resultado y fechas (nunca `prompt`, `deliver` ni `origin`); kanban, título y estado de las tareas asignadas al perfil (nunca `body`). Los textos pasan por `redact`.
- **Interfaz**: barra inferior con el estado del gateway y el recuento global de agentes; bajo el nombre de cada edificio, sus conexiones y, si hubo actividad hace menos de dos minutos, la etiqueta «Actividad registrada» y un anillo dorado en la parcela; sección «Actividad real» en la ficha del perfil; dos paneles en la pared del fondo de su espacio (tareas programadas y kanban). Sondeo cada 15 s, en pausa con la pestaña oculta; si una lectura falla se retiran los datos en lugar de mostrar los antiguos como actuales.
- **Verificación**: `server/hermes-activity.test.ts` (canarios de contenido, estado antiguo, proceso inexistente, enlaces simbólicos, fuentes ausentes) y `scripts/verify-activity.mjs` (escritorio y móvil, sin peticiones mutadoras).

## Uso real de herramientas
Hermes guarda cada llamada a una herramienta como un mensaje con `role = 'tool'`, el nombre de la herramienta y su hora. Las de MCP se llaman `mcp__<servidor>__<herramienta>`, con los caracteres no alfanuméricos del nombre del servidor sustituidos por `_` (`mcpServerKey`). La columna `sessions.tool_names` no sirve: es la lista de herramientas disponibles en la sesión, no las usadas.

- **Lectura**: por perfil, `tool_name`, número de llamadas en los últimos 30 días y última llamada. Nunca argumentos, resultados ni contenido.
- **Duplicados**: al compactar una sesión, Hermes clona el tramo conservado y deja las filas originales archivadas. Se cuenta cada llamada una vez por `session_id` + `tool_call_id`; en el perfil con más historial, 187 llamadas reales frente a 316 filas (el filtro por filas no archivadas da la misma cifra).
- **Coste**: la agregación recorre `messages` (unos 200 ms en caliente y varios segundos en frío con 134 MB). Se guarda en memoria por perfil hasta que cambian el tamaño o la fecha de `state.db` o de su WAL, o pasan 10 minutos.
- **Nombres MCP**: se emparejan primero por el prefijo de los servidores declarados (`mcp__<clave>__`), de modo que nombres como `crm-` (clave `crm_`) se resuelven bien. Los nombres de más de 64 caracteres que Hermes recorta con un hash pueden no emparejarse.
- **Ficha del perfil**: «Herramientas usadas», con cada MCP (nombre de config.yaml cuando coincide; si no, se marca «no declarado en config.yaml»), sus herramientas más usadas y las herramientas nativas de Hermes con llamadas en la ventana.
- **Espacio del perfil y centro de integraciones**: cada pantalla o terminal MCP indica «usado hace X · N llamadas en 30 días» o «sin uso registrado», y brilla más si hubo una llamada en las últimas 24 h. En el centro se combina el uso de todos los perfiles que declaran ese nombre.
- **Ficha del MCP**: «Uso registrado por Hermes» para el perfil seleccionado.

## Criterios de representación
1. **Conexiones del gateway por perfil**: indicador en el edificio y en la ficha (conectado, reintentando, requiere atención o sin datos). Si el estado es antiguo o el PID no existe, se muestra «sin datos recientes», nunca «conectado».
2. **Trabajo en curso global**: un indicador de ciudad con el recuento `active_agents`, sin atribuirlo a ningún perfil.
3. **Actividad registrada por perfil**: «última actividad hace X» y sesiones de las últimas 24 h por origen. Un realce visible y etiquetado («actividad registrada») solo si la última actividad es de hace menos de dos minutos.
4. **Tareas programadas** en el espacio del perfil: nombre, horario, último resultado y próxima ejecución.
5. **Kanban**, cuando tenga tareas: tablero en el espacio del perfil asignado.

El movimiento ambiental (paseos, peatones) sigue siendo ilustrativo y se distingue visualmente de los indicadores con dato real, que siempre muestran su fuente y antigüedad.
