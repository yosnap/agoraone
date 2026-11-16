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

## Pendiente (fases 3 y 4 del plan)
Sesiones de Claude Code y Codex de este Mac, y la Oficina 3D enlazada con estas tarjetas.
