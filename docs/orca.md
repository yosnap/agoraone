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
  Desde el 23/11/2026 puede llevar como origen una tarea o un ticket de CRMDev que haya visto con
  `consultar_crmdev` (`crmdev_tarea` o `crmdev_ticket`), con la organización donde lo vio; un solo origen por
  encargo (no a la vez que una issue). La vista previa lo lee otra vez de CRMDev y exige que su proyecto esté
  enlazado con el de Central, igual que desde la sección CRMDev.

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

## Bots de Orca (1.9)

Decisión del usuario del 21/11/2026 (plan `plans/261121-1526-orca-bots`). Orca 1.4.265 trae bots (beta): agentes que
no se cierran, con identidad, memoria y chats propios. AgoraOne los usa **por oficio, no por proyecto**: unos pocos
bots reutilizables, y cada encargo dice en qué proyecto se trabaja. Hace falta Orca 1.4.267 o posterior.

### Cómo funciona
- **Buzón de AgoraOne**: una pestaña propia en Orca que solo corre `cat > /dev/null`. Orca exige un terminal
  remitente y deja allí las respuestas; lo que escribe en ella cae en `cat` y nunca en un shell.
  - Se crea solo con el botón «Crear el buzón de AgoraOne» (Agentes › Bots de Orca). AgoraOne espera a que arranque
    `cat`.
  - Se usa solo mientras `cat` corre en él. Si alguien lo interrumpe, sale como «No se puede usar» y hay que cerrarlo
    en Orca y crearlo otra vez: nunca hay dos.
  - Tras un reinicio de Orca se encuentra por su pestaña. AgoraOne nunca usa el handle de otro terminal.
- **Enviar a un bot**: la tarjeta «Llevar a Orca» (correo, nota, proyecto de Central, issue, tarea o ticket de CRMDev)
  tiene el destino «Bot». Se elige un bot activo y «Encargar» (se queda con el trabajo) o «Preguntar» (responde).
  - La vista previa reutiliza las comprobaciones y los datos delimitados de «Lanzar en Orca» y añade el repositorio
    en el que debe trabajar.
  - Solo «Enviar a <bot>» lo envía, una vez, a un chat nuevo del bot (`orchestration send --from <buzón> --chat new`),
    nunca a su chat principal.
- **Respuestas**: AgoraOne lee el buzón sin marcar nada como leído y casa cada respuesta con su encargo por el hilo.
  Un encargo responde en su chat del bot, y AgoraOne guarda su último mensaje cuando el bot termina. En Agentes ›
  Bots de Orca › «Encargos enviados»:
  - cada encargo con su estado y la respuesta como texto;
  - «Seguir el hilo»: un mensaje nuevo en el mismo chat, con vista previa;
  - «Pasar a Watson»: el núcleo le da a Watson la respuesta guardada, sin líneas que parezcan claves y marcada como
    dato.
- **Watson** puede proponer el encargo a un bot por su nombre (`proponer_encargo_orca` con `bot` y `tipo`). Abre la
  misma tarjeta, y nada se envía hasta pulsar «Enviar a <bot>».

### Garantías
- AgoraOne no crea, configura, pausa ni borra bots. Tampoco les conecta servicios (Slack, Google, GitHub, Composio) ni
  herramientas, ni crea automatizaciones o webhooks: todo eso lo hace el usuario en Orca.
- No da a un bot ninguna clave (CRMDev, Central ni otras): lo de esas apps pasa por AgoraOne como dato.
- Nunca envía lo «solo en este Mac» ni lo privado.
- Un envío por vista previa. Si Orca no lo confirma, se dice que pudo llegar y se pide mirarlo en Orca antes de
  repetirlo.
- El texto del encargo no se guarda: solo el bot, el tipo, el asunto, el proyecto y el origen. La respuesta sí, porque
  es lo que el usuario consulta después.
- Lo que responde un bot es dato: nunca dispara nada, ni en AgoraOne ni en otro bot.

### Guía: bots por oficio
Se crean en Orca, en la barra lateral «Bots». Ideas de partida:

| Bot | Para qué | Agente y permisos |
|---|---|---|
| Seguridad | Revisar cambios y dependencias de un proyecto y avisar de riesgos | Un modelo fuerte; en su `SOUL.md`, «solo leer e informar» |
| Desarrollo junior | Cambios pequeños y acotados (textos, estilos, arreglos sencillos) | Un modelo pequeño o un agente ligero (por ejemplo Pi); abre PR, nunca hace merge |
| Revisión | Revisar PR y dejar comentarios | Plantilla `pr-review` de Orca |
| Soporte | Investigar tickets de CRMDev y proponer la respuesta | Solo leer; la respuesta al cliente la decide el usuario |

Cada encargo de AgoraOne lleva el proyecto de Central y su repositorio, así que el mismo bot sirve para todos los
proyectos y sigue los flujos y normas de cada repositorio.

### Rutas
- `GET /orca/bots`: bots y estado del buzón. `POST /orca/mailbox`: crea el buzón (botón).
- `POST /orca/bots/preview` y `POST /orca/bots/follow`: vista previa (token de un solo uso, 15 min).
  `POST /orca/bots/send`: el envío.
- `GET /orca/bots/requests`: encargos y respuestas (lee el buzón como mucho cada 10 s si algo espera).
