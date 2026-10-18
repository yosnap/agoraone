# Actividad real de Hermes (17/10/2026)

Revisión de solo lectura de la instalación local (Hermes 0.21.4, commit 28aceb3; la gestión de tareas y kanban se añadió después, ver el final). No se iniciaron procesos, no se modificó configuración ni perfiles y no se leyó contenido de mensajes, prompts ni credenciales.

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
- **Campos leídos**: sesiones, solo `source`, `started_at` y `last_activity_at`; tareas programadas, nombre, habilitación, estado, horario, último resultado y fechas (las instrucciones, `prompt`, solo al pulsar «Editar», con las líneas con aspecto de clave ocultas; nunca `deliver` ni `origin`); kanban, título y estado de las tareas asignadas al perfil (nunca `body`). Los textos pasan por `redact`.
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

## Personas que reaccionan a la actividad real
Mientras Hermes haya registrado actividad del perfil hace menos de dos minutos, su persona deja de pasear, camina hasta la entrada del edificio y se queda mirándolo; su etiqueta pasa a «<nombre> · actividad registrada» y su anillo se vuelve dorado. Al dejar de haber actividad reciente vuelve al paseo, siempre caminando (nunca salta de sitio). Con movimiento reducido se coloca directamente, sin animación. En el espacio del perfil aparece «Actividad registrada hace X» sobre la persona del escritorio. La verificación `scripts/verify-activity.mjs` usa una respuesta simulada solo dentro de la prueba para provocar este estado.

## Registro de actividad
Botón «◷ Registro» junto a los modos de vista: panel con lo que Hermes registró en las últimas 24 h, de todos los perfiles, del más reciente al más antiguo (máximo 60 entradas; 30 por perfil).

- **Sesiones**: inicio y origen (`sessions.source`, `started_at`).
- **Tareas programadas**: ejecuciones de `cron/executions.db` (solo tarea, estado y hora; nunca el texto de error ni el destino de entrega) más el `last_run_at` de `jobs.json` cuando el historial no lo incluye (se descarta si hay una ejecución de la misma tarea a menos de 10 minutos).
- **MCP**: llamadas agrupadas por servidor y hora, contadas sin duplicados de compactación, en la misma pasada que el uso de herramientas. Aparecen en cuanto Hermes las escribe en `state.db`: el resultado se reutiliza solo mientras la base y su WAL no cambian, como máximo 10 minutos.
- **Conexiones**: última actualización de estado de cada plataforma del gateway, salvo cuando el estado es «sin datos recientes».

Lectura en `server/hermes-activity-log.ts` y `server/hermes-activity.ts`; panel en `src/ui/activity-log.tsx`.

## Criterios de representación
1. **Conexiones del gateway por perfil**: indicador en el edificio y en la ficha (conectado, reintentando, requiere atención o sin datos). Si el estado es antiguo o el PID no existe, se muestra «sin datos recientes», nunca «conectado».
2. **Trabajo en curso global**: un indicador de ciudad con el recuento `active_agents`, sin atribuirlo a ningún perfil.
3. **Actividad registrada por perfil**: «última actividad hace X» y sesiones de las últimas 24 h por origen. Un realce visible y etiquetado («actividad registrada») solo si la última actividad es de hace menos de dos minutos.
4. **Tareas programadas** en el espacio del perfil: nombre, horario, último resultado y próxima ejecución.
5. **Kanban**, cuando tenga tareas: tablero en el espacio del perfil asignado.

El movimiento ambiental (paseos, peatones) sigue siendo ilustrativo y se distingue visualmente de los indicadores con dato real, que siempre muestran su fuente y antigüedad.

## Gestionar tareas programadas y kanban (0.15.0)
Decisión del usuario (18/10/2026): en la sección «Actividad real» de la ficha de cada perfil, las tareas programadas y las tarjetas del kanban ya no son solo de lectura.
- **Tareas programadas**:
  - Las acciones disponibles son **Pausar**/**Reanudar**, **Ejecutar ahora**, **Editar**, **Eliminar** (pide confirmación) y **+ Nueva tarea programada** (nombre, horario e instrucciones).
  - «Ejecutar ahora» solo marca la tarea (`trigger_job` de Hermes) para el siguiente ciclo del gateway, que la ejecuta con la configuración del propio perfil; AgoraOne no ejecuta nada. Si el gateway no está en marcha, se avisa de que se ejecutará cuando arranque.
  - Al editar solo se envía lo que cambió, para que Hermes no recalcule ni reactive una tarea sin motivo. Las tareas de una sola vez («in 30m», «at …») no admiten cambiar su momento. Si las instrucciones cambiaron entre abrirlas y guardarlas, se rechaza (409) en lugar de pisarlas.
  - El horario «30m» se repite cada 30 minutos; para una sola vez se usa «in 30m». La ayuda del formulario lo explica.
  - Las instrucciones solo se leen al pulsar **Editar**, con las líneas que parecen claves como «[línea oculta N]», que se reponen al guardar.
  - Las tareas nuevas guardan su resultado en Hermes (`deliver: local`), sin enviarlo a ningún chat. El formulario avisa de que Hermes las ejecutará en su horario con las herramientas y permisos del perfil, sin pedir confirmación.
- **Kanban**:
  - Sobre las tarjetas asignadas al perfil (hasta 30 abiertas): **Completar**, **Bloquear** (con motivo opcional), **Desbloquear**, **Comentar** y **Archivar**. Archivar pide confirmación y, si un agente trabaja en ella, avisa de que lo detendrá.
  - **+ Nueva tarjeta para este perfil** la crea asignada a él. Si el despachador de kanban de Hermes está activo, el perfil trabaja en ella por su cuenta, y el formulario lo avisa.
  - Se usa el tablero `default` (`kanban.db` en la raíz de Hermes), el mismo que lee AgoraOne.
- **Cómo**:
  - `server/hermes_manage.py` usa las funciones de Hermes: la herramienta `cronjob`, la misma que usa el bot, sobre el almacén del propio perfil (`use_cron_store`), y la API de `hermes_cli.kanban_db`. Así se aplican sus validaciones y sus bloqueos.
  - Solo admite ids que pertenezcan a ese perfil (tarea en su almacén, tarjeta con `assignee` igual al perfil).
  - Los errores de Hermes, que vienen en inglés, se muestran en castellano.
  - Las rutas `/api/hermes/profiles/:id/jobs[/:jobId]` y `/cards[/:cardId]` van detrás de la cabecera CSRF y usan cuerpos estrictos. El cliente no elige ni el destino ni el perfil asignado.
- **Verificación**:
  - `server/hermes-manage.test.ts`: Hermes real con perfiles ficticios. Comprueba crear, editar conservando la línea oculta y rechazar el conflicto; pausar, reanudar y eliminar; que «Ejecutar ahora» solo marca la tarea, sin sesión ni ejecución; que la tarea de una sola vez no se reprograma; el rechazo de otro perfil; comentar, bloquear, desbloquear y completar tarjetas; y el error en castellano.
  - `scripts/verify-profile-tasks.mjs`: navegador con los datos interceptados, sin tocar Hermes.
