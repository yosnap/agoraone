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
- Estado vivo de cada conexión MCP: solo hay configuración y cachés de descubrimiento, que se mantienen como configuración.
- Atribución en tiempo real de un agente activo a un perfil concreto.

## Implementado
El usuario aprobó los cinco puntos, con nombres de tareas programadas visibles y sin títulos de conversaciones.

- **Backend**: `GET /api/hermes/activity` (protegido por la cabecera CSRF como el resto de `/api/hermes`). Lector en `server/hermes-activity.ts`; tipos en `shared/hermes-activity.ts`. Abre SQLite con `withHermesDatabase` (`server/hermes-database.ts`) y JSON con `readHermesFile` (sin enlaces simbólicos ni duros, dentro de `~/.hermes`). Los perfiles salen del catálogo; el cliente no envía rutas.
- **Gateway**: «en marcha» solo si el PID existe, el estado es `running`/`degraded` y el registro más reciente (estado o latido) tiene menos de 120 s, el mismo umbral que usa Hermes. Si no, «detenido», «sin datos recientes» o «sin estado registrado», y las conexiones pasan a «sin datos recientes».
- **Campos leídos**: sesiones, solo `source`, `started_at` y `last_activity_at`; tareas programadas, nombre, habilitación, estado, horario, último resultado y fechas (nunca `prompt`, `deliver` ni `origin`); kanban, título y estado de las tareas asignadas al perfil (nunca `body`). Los textos pasan por `redact`.
- **Interfaz**: barra inferior con el estado del gateway y el recuento global de agentes; bajo el nombre de cada edificio, sus conexiones y, si hubo actividad hace menos de dos minutos, la etiqueta «Actividad registrada» y un anillo dorado en la parcela; sección «Actividad real» en la ficha del perfil; dos paneles en la pared del fondo de su espacio (tareas programadas y kanban). Sondeo cada 15 s, en pausa con la pestaña oculta; si una lectura falla se retiran los datos en lugar de mostrar los antiguos como actuales.
- **Verificación**: `server/hermes-activity.test.ts` (canarios de contenido, estado antiguo, proceso inexistente, enlaces simbólicos, fuentes ausentes) y `scripts/verify-activity.mjs` (escritorio y móvil, sin peticiones mutadoras).

## Criterios de representación
1. **Conexiones del gateway por perfil**: indicador en el edificio y en la ficha (conectado, reintentando, requiere atención o sin datos). Si el estado es antiguo o el PID no existe, se muestra «sin datos recientes», nunca «conectado».
2. **Trabajo en curso global**: un indicador de ciudad con el recuento `active_agents`, sin atribuirlo a ningún perfil.
3. **Actividad registrada por perfil**: «última actividad hace X» y sesiones de las últimas 24 h por origen. Un realce visible y etiquetado («actividad registrada») solo si la última actividad es de hace menos de dos minutos.
4. **Tareas programadas** en el espacio del perfil: nombre, horario, último resultado y próxima ejecución.
5. **Kanban**, cuando tenga tareas: tablero en el espacio del perfil asignado.

El movimiento ambiental (paseos, peatones) sigue siendo ilustrativo y se distingue visualmente de los indicadores con dato real, que siempre muestran su fuente y antigüedad.
