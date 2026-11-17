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
| `POST /orca/preview` | `{client, project, task, agent, source?: {kind: mail, id} \| {kind: issue, url}}` |
| `POST /orca/launch` | `{id}` de la vista previa |

Pendiente: botones en Central y Bandeja (alpha.34); notas del vault, issue de Watson y propuesta de Watson (alpha.35).
