# Módulo Orca (1.7)

Decisión del usuario del 17/11/2026 (AGENTS.md). Desde un correo, una nota, un proyecto de Central o una issue
propuesta, AgoraOne crea un espacio de trabajo nuevo en Orca, en el repositorio de ese proyecto, y arranca ahí
Claude Code o Codex con un encargo. Plan: `plans/261117-0940-modulo-orca`.

## Cómo funciona
1. **Repositorio:** el que Central guarda del proyecto (`owner/name`), buscado entre los proyectos que ya están en
   Orca (`orca project list`, ids `github:owner/name`, sin distinguir mayúsculas). Si no está en Orca, se dice;
   AgoraOne no añade repositorios ni toca espacios de trabajo existentes.
2. **Vista previa** (`POST /orca/preview`): proyecto, repositorio, agente, nombre del espacio (`agora-<encargo>`)
   y el texto exacto que recibirá el agente. Vale 15 minutos y solo para quien la pidió.
3. **Lanzar** (`POST /orca/launch` con el id de la vista previa): una sola vez, aunque se pulse dos veces.
   Ejecuta `orca worktree create --project … --name … --agent claude|codex --prompt … --no-parent --activate --json`
   (más `--issue <n>` si viene de una issue). Queda en el registro de acciones como `orca.launch` con proyecto,
   repositorio, agente y origen, nunca el encargo; sale en «Agentes».

## Garantías
- **Claves:** del encargo y de las notas se quitan las líneas con pinta de contraseña o clave.
- **Texto ajeno:** el correo va tras el encargo, dentro de un bloque `<<<DATOS-…` con una marca aleatoria que el
  propio texto no puede cerrar, y con el aviso de tratarlo solo como datos.
- **Privacidad:** un correo «solo en este Mac» o privado se rechaza: los dos agentes usan modelos remotos.
- **Ejecución:** sin shell, cada valor pegado a su opción (`--prompt=…`, porque el analizador de Orca toma un valor que empieza por `--` como otra opción), sin caracteres de control, en la carpeta personal, entorno mínimo (nunca variables `ORCA_*`, que mandarían
  el lanzamiento a otro Orca, ni claves). Espera como mucho 100 s, por debajo de los 120 s del servidor; si falla o tarda, pide mirar en Orca antes de repetir, porque el espacio puede existir.
- **Módulo:** «Orca» se apaga en Ajustes › Módulos; Instalación dice si la CLI está; solo vale el envoltorio de Orca.app (en Linux `orca` suele ser el lector de pantalla de GNOME) (`core/agora_core/orca_launch.py`).

## Rutas
| Ruta | Qué hace |
|---|---|
| `GET /orca` | si está instalado, si el módulo está encendido y los agentes |
| `GET /orca/projects` | proyectos de Central cuyo repositorio ya está en Orca (vacío sin Orca o con el módulo apagado) |
| `POST /orca/preview` | `{client, project, task, agent, source?: {kind: mail, id} \| {kind: note, source, ref, revision} \| {kind: issue, url}}` |
| `POST /orca/launch` | `{id}` de la vista previa |

## En la interfaz
- **Tarjeta compartida** (`src/orca/orca-launch.tsx`): proyecto (con `ModernSelect` si el cliente tiene varios en
  Orca), agente (Claude Code por defecto o Codex) y encargo editable; «Ver la vista previa» enseña repositorio,
  agente, nombre del espacio y las indicaciones exactas, y solo «Lanzar en Orca» lanza. Cambiar algo pide otra
  vista previa. Los botones solo salen para los proyectos de `GET /orca/projects` (`src/orca/orca-projects.ts`).
- **Trabajos › Proyectos de clientes:** columna «Orca» con «Abrir en Orca…» en cada proyecto listo.
- **Bandeja:** «Llevar a Orca…» en las tarjetas pendientes de un cliente con proyectos en Orca, solo si el correo
  es normal y sigue en la bandeja de entrada; el encargo por defecto no copia palabras del correo, que va debajo
  como datos.

- **Libro del vault:** «Llevar a Orca…» en las notas que no están marcadas privadas ni «solo en este Mac». La nota
  se lee del índice de AgoraOne (solo si es normal, también por su carpeta), sin las líneas con pinta de clave, y
  va debajo del encargo como datos; se vuelve a comprobar al lanzar. Solo vale si el índice tiene la misma versión
  que la nota abierta (fecha y tamaño): una nota recién cambiada espera a la siguiente lectura del índice (5 min).
- **Issue de Watson:** una vez creada, «Resolver en Orca…» lanza con `--issue <n>` y el agente la lee con `gh`.
- **Tareas y tickets de CRMDev** (1.9): «Lanzar en Orca» en cada tarea o ticket cuyo proyecto de CRMDev está
  enlazado con un proyecto de Central que ya está en Orca (`src/orca/crmdev-to-orca.tsx`), nunca en modo discreto.
  La tarjeta solo ofrece ese proyecto. La pantalla manda solo el id (`source: {kind: "crmdev_task" | "crmdev_ticket",
  remote}`): el núcleo lee la tarea o el ticket de CRMDev con la lista cerrada, comprueba que su proyecto sigue
  enlazado con el proyecto de Central elegido (`core/agora_core/orca_crmdev.py`) y lo pone debajo del encargo como
  datos: título, estado, prioridad, categoría, fecha y descripción, sin líneas con pinta de clave ni enlaces y nunca
  el nombre ni el correo de quien abrió el ticket. Se vuelve a leer al lanzar.
- **Watson:** la herramienta `proponer_encargo_orca` (solo con Claude, módulo Orca) comprueba que el proyecto está
  en Orca y abre la tarjeta rellenada en el chat; no lanza nada. El registro guarda repositorio y agente, nunca el
  encargo.

## Issues de correos y notas, y envío a una sesión abierta (1.7.0-alpha.45)
Decisión del usuario (17/11/2026), en AGENTS.md.
- **Crear issue…** en la tarjeta de un correo de cliente (normal) y en una nota del vault (normal, sin líneas ocultas
  reveladas): proyecto de Central con repositorio (el del correo, preseleccionado), título y texto editables, aviso si el
  repositorio es público, y «Crear la issue» con el `gh` del usuario (`POST /issues`, `core/agora_core/issue_handoff.py`).
  El núcleo vuelve a comprobar el nivel del correo, o el índice y la revisión de la nota.
- **Después**, como también tras la issue de una reunión: «En un espacio nuevo de Orca…» (el lanzamiento de siempre) o
  «En una sesión abierta de Orca…»: las sesiones de Claude Code o Codex en espacios de ese repositorio que te esperan
  (`GET /orca/waiting`; las que trabajan no salen). Se ve la línea exacta y, con «Escribir en la sesión», se escribe en su
  prompt con `orca terminal send` **sin Enter** (lo envías tú en Orca), y Orca muestra ese espacio y su terminal
  (`POST /orca/handoff`). La línea solo remite a la issue (`gh issue view N --repo …`) y avisa de que su texto es dato del
  cliente; nunca lleva el texto del correo ni de la nota. Justo antes de escribir se comprueba otra vez, y solo se escribe si no hay duda: la
  sesión sigue esperando, su espacio es de ese repositorio, ninguna otra sesión trabaja en él y tiene una única terminal
  con un agente (Orca no enlaza una terminal con su sesión: una shell se reconoce porque su pestaña muestra la carpeta).
  Si no, no se escribe nada y se ofrece «Copiar la línea» para pegarla a mano. El núcleo rechaza también un cuerpo de issue
  con líneas con pinta de clave y quita los caracteres de control, y solo acepta repositorios de proyectos de Central.
