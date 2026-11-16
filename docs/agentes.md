# Agentes: ver a los agentes trabajando de verdad (1.7)

Petición del usuario (15/11/2026 y 16/11/2026). Plan: `plans/261116-2329-seccion-agentes/plan.md`.

La sección «Agentes» de la barra lateral (`?seccion=agentes`, `src/agents/`) enseña quién trabaja ahora y en
qué, y lo que ha hecho cada uno en las últimas 24 horas. Solo lectura: los botones llevan al sitio donde se maneja
cada agente (el Asistente para Watson, la Oficina 3D para conversar con un perfil y Trabajos para sus tareas).

## Qué se ve
- **Barra:** cuántos agentes trabajan ahora y el estado del gateway de Hermes (con su recuento global de agentes en
  curso, que Hermes no atribuye a ningún perfil).
- **Watson:** «Respondiéndote ahora» mientras escribe una respuesta (el núcleo cuenta las respuestas en curso),
  «Trabajando ahora» si actuó hace menos de 2 minutos, y su última acción y cuántas hizo en 24 h.
- **Cada perfil de Hermes:** el estado de `agentStatus` (usando una herramienta, ejecutó una tarea programada,
  trabajando ahora, conectado o sin conexión), sus encargos del kanban en curso o bloqueados, su próxima tarea
  programada, su última actividad con las sesiones de 24 h por origen, y ejecuciones y tokens de 24 h.
- **Actividad · últimas 24 h:** lo de Hermes (sesiones, tareas, llamadas a MCP, conexiones caídas) y las acciones de
  Watson y las tuyas del registro de acciones, la más reciente arriba, con «Hecho», «Falló», «Rechazado» o
  «Deshecho» cuando es una decisión (propuestas, enviar un correo, crear una regla). Lo llegado desde la lectura
  anterior se resalta unos segundos.

## Datos y privacidad
- Se lee cada 15 s mientras la sección está en pantalla y la ventana visible (`src/agents/agents-feed.ts`, con
  `useSyncExternalStore`); una fuente que falla se quita y se dice, en vez de enseñar lo antiguo como actual.
- `GET /agents/watson` (`core/agora_core/routes_agents.py`) devuelve solo quién, qué acción, cómo acabó y cuándo,
  y únicamente nombres de acción del propio registro. Nunca los detalles (palabras buscadas, destinatarios, notas).
- De Hermes, lo mismo que la Oficina 3D: `/api/hermes/activity`, `/api/hermes/catalog` y `/api/hermes/work`
  (docs/actividad-hermes.md). En modo discreto, los títulos de los encargos y los tokens se ocultan.

## Agentes de código en este Mac (alpha.29)
Debajo de las tarjetas, las sesiones de Claude Code y Codex que se han movido en las últimas 24 horas
(`GET /agents/coding`, `core/agora_core/coding_sessions.py`, `src/agents/coding-sessions.tsx`): la carpeta del
proyecto donde empezó, la rama, el modelo, si está «Trabajando» (se movió hace menos de 2 minutos con un turno
abierto), «Herramienta o tu permiso» (pidió una herramienta que no ha contestado en más de 2 minutos: los registros
no distinguen una orden larga de una aprobación pendiente), «Te espera» (terminó su respuesta o la interrumpiste hace
menos de 30 minutos; los comandos locales no cuentan) o «En pausa», los tokens de 24 h (entrada,
creación de caché y salida; sin lecturas de caché) y cuántas respuestas dio.

- Carpetas fijas: `~/.claude/projects`, los perfiles de Orca (`~/Library/Application Support/orca/claude-profiles/*/home/projects`)
  y `~/.codex/sessions` (solo los días de hoy y ayer). Sin enlaces simbólicos.
- Cada archivo se lee una vez y después solo lo añadido (hay sesiones de casi 50 MB); una línea a medias se lee
  cuando termina y una de más de 4 MB se salta. Un mensaje que Claude Code escribe varias veces mientras lo genera
  cuenta una sola, y un recuento de Codex repetido también. La caché guarda solo los archivos dentro de la ventana
  (por la fecha del archivo) y los tokens de 24 h: tras la primera lectura (cerca de 1 s), cada sondeo tarda milisegundos.
- Una sesión de Codex de hace más de un día reanudada hoy escribe en la carpeta de su primer día y no se ve.
- No se guardan ni se devuelven mensajes, entradas o resultados de herramientas, adjuntos ni rutas completas: solo
  el último tramo de la carpeta. En modo discreto se ocultan el proyecto, la rama y los tokens.

## Pendiente (fase 4 del plan)
La Oficina 3D enlazada con estas tarjetas.
