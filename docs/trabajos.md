# Trabajos (1.2)

La sección Trabajos reúne lo que hacen o tienen pendiente tus agentes: las tareas programadas y el kanban de todos los perfiles de Hermes, los encargos que les das, y los proyectos de tus clientes con lo que han gastado en ellos. Todo lo que se ve sale de lo que Hermes, CostGuard y Central registran; lo que no se puede medir se dice, nunca se inventa.

## Tareas programadas
- Las de todos los perfiles, agrupadas por perfil: horario, próxima ejecución y último resultado.
- Cada una con sus últimas ejecuciones (hasta 20 a la vista): cuándo, resultado, duración y consumo. El consumo (tokens y coste estimado) sale de la sesión que abrió esa ejecución en Hermes (`cron_<tarea>_<fecha>_<hora>`), incluidas las sesiones en las que Hermes la continuó tras comprimir el contexto. Una ejecución sin sesión dice «sin medir».
- Totales de 24 h, 7 días y 30 días, con todas las ejecuciones del periodo.
- Las mismas acciones que en la ficha del perfil (pausar, reanudar, ejecutar ahora, editar, crear, eliminar con confirmación), con las funciones de Hermes.

## Kanban y encargos
- Las tarjetas de todos los tableros de Hermes en columnas: por hacer, en curso, bloqueadas y hechas (las de los últimos 30 días), filtrables por perfil.
- Cada tarjeta con su historia (creada, recogida por un agente, bloqueada, completada…, sin el contenido de los eventos ni los latidos de cada minuto), su duración y los tokens de las sesiones del agente que la ejecutó.
- Acciones de siempre (completar, bloquear o desbloquear, comentar, archivar), solo en el tablero principal, que es el que gestionan las funciones de Hermes que usa AgoraOne.

**Nuevo encargo:** qué quieres que haga e instrucciones opcionales, para el **bot central** o para otro perfil. Se crea al pulsar «Crear encargo» como tarjeta del kanban de Hermes, firmada por AgoraOne, y el despachador de Hermes (dentro de su gateway) se la pasa al perfil, que trabaja con sus herramientas y permisos y sin pedirte confirmación. El formulario avisa si el gateway está parado o si la configuración del perfil raíz desactiva el despachador (`kanban.dispatch_in_gateway`); solo se comprueba la del perfil raíz.

**Bot central:** en Ajustes › Trabajos. Por defecto, el perfil raíz de Hermes. Si el elegido deja de existir, el formulario de encargo pide elegir otro.

## Proyectos de clientes
- Los proyectos de Central por cliente, con su estado y su fase (por defecto, activos y en mantenimiento).
- **Agentes de código:** los tokens de CostGuard (Claude Code, Codex…, de entrada y salida, sin caché) en el periodo elegido.
- **Hermes:** los tokens de sus sesiones en los últimos 30 días (con caché), de sus 20 repositorios con más consumo.
- Un proyecto y una carpeta van juntos solo si se llaman igual (sin tildes, mayúsculas ni signos) y ningún otro proyecto se llama así. Las carpetas sin letras latinas, el cubo sin nombre de CostGuard y lo que no coincide salen aparte, en «Otras carpetas con consumo».

## Watson
`consultar_trabajos` responde «¿en qué he trabajado esta semana?» o «¿cuánto lleva el proyecto X?» con los proyectos de Central y su consumo de CostGuard. Solo la usa Claude, nunca el proveedor compatible. Las tareas y tarjetas de Hermes se ven en la sección Trabajos.

## Privacidad
- De Hermes solo se leen metadatos: nombres de tareas, títulos de tarjetas (con las líneas con pinta de clave ocultas), estados, horas y recuentos. Nunca las instrucciones, el cuerpo de una tarjeta, su resultado, los resúmenes ni los errores.
- El modo discreto oculta nombres de tareas, títulos de tarjetas, consumo, clientes y proyectos, y no deja crear encargos.

Pruebas: `desktop/server/tests/hermes_work.rs`, `core/tests/test_jobs.py`, `src/jobs/*.test.ts` y `scripts/verify-jobs.mjs`.
