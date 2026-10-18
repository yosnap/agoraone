# Conversar con perfiles de Hermes

Seleccionar un perfil y abrir **Conversar con <nombre>**. Abrir la ficha o la pestaña no inicia nada; enviar un mensaje sí.

## El mismo bot que en Telegram, con permiso para cada acción (0.13.0)
Decisión del usuario (18/10/2026): el chat de un perfil usa su propio agente, como su bot de Telegram, y cada acción que cambie algo se confirma en AgoraOne.
- **Agente real del perfil** (`server/hermes_agent_bridge.py`, un proceso por conversación):
  - Se construye como lo hace la API de Hermes: configuración del gateway, modelo y proveedor del perfil, los toolsets `telegram` del perfil, sus MCP, su memoria y su SOUL.
  - Todo ocurre dentro de `_profile_runtime_scope`, así el home, las credenciales y la política de terminal son los del perfil y no pasan a otro.
  - AgoraOne no le pasa credenciales propias: gasta del proveedor del perfil, igual que Telegram.
- **Confirmación por acción** (decisiones del usuario del 18/10/2026):
  - Un gancho `pre_tool_call`, activo durante toda la vida del proceso, decide qué hacer con cada llamada:
    - Sin preguntar solo van las herramientas que leen datos locales: `read_file`, `search_files`, skills, `session_search`, consultas de Home Assistant, `kanban_show`, `kanban_list` y `clarify`.
    - Todo lo que sale a la red (webs, búsquedas, navegador, análisis de imágenes por URL) pide permiso, porque podría enviar fuera lo leído. También lo pide todo lo que cambia algo, todo MCP y cualquier herramienta desconocida.
    - Fuera de un turno, el gancho lo bloquea todo.
  - **Trabajo que seguiría vivo** sin volver a preguntar se bloquea siempre, sin tarjeta: las tareas programadas (`cronjob_manage`) y el `terminal` en segundo plano. El bot sugiere hacerlo desde Telegram o desde la gestión de tareas. Las delegaciones (`delegate_task`) piden permiso y se ejecutan dentro del turno (`async_delivery=False`); sus subagentes pasan por la misma puerta.
  - **La tarjeta** («<perfil> quiere usar <herramienta>») muestra cada dato tal cual, con los textos de varias líneas completos. Solo se sustituyen los fragmentos con aspecto de clave (redacción de Hermes), nunca líneas enteras.
    - Avisa si ocultó algo, si recortó datos de más de 12 000 caracteres o si el perfil tiene otros complementos que podrían modificar los datos.
    - El foco empieza en **Denegar**.
    - Si Hermes la da por caducada (su `approvals.timeout`), la tarjeta pasa a «Caducada» y ya no se puede permitir.
    - **Detener** deniega lo pendiente e interrumpe el turno.
  - Al denegar, el modelo recibe «BLOCKED: el usuario lo denegó» y se le pide no intentarlo por otra vía.
  - Solo se envía «una vez» o «denegar»: nada se guarda como permiso permanente.
  - La confirmación es obligatoria aunque el perfil tenga las aprobaciones desactivadas (`approvals.mode: off`, yolo). Se fuerza en memoria, dentro del proceso del puente, sin escribir su configuración.
  - Se desactiva la revisión posterior al turno de Hermes, que escribiría memoria y skills cuando el turno ya terminó.
  - Los perfiles con el runtime `codex_app_server` se rechazan: ejecutan con aprobaciones propias, fuera de esta puerta.
  - Al importar Hermes se cargan en el entorno las credenciales del perfil principal. Se retiran, y se activa el modo multiperfil de Hermes para que la recarga de cada turno no las vuelva a poner. Así ni los MCP ni los procesos de otro perfil las heredan; una prueba lo comprueba y falla sin esta protección.
  - El puente encabeza su propio grupo de procesos, así que sus MCP y procesos hijos se cierran con él.
- **Respuesta a la tarjeta**: `POST /api/conversations/:id/approvals/:requestId` con CSRF, solo para el propietario de la conversación y solo si esa petición sigue pendiente en ella. Luma no tiene herramientas ni aprobaciones.
- **Lo que se guarda**: cada respuesta registra los nombres de las herramientas usadas («Herramientas usadas: …»), nunca sus argumentos ni resultados. La sesión también queda en el `state.db` del perfil (plataforma `agoraone`, id propio), como cualquier conversación de Hermes, sin compartir sesión con Telegram.
- **Diferencias con la versión anterior**:
  - El agente lee su memoria completa por sí mismo, como en Telegram, así que las líneas ocultas en la ficha sí pueden llegar a su proveedor.
  - Si el perfil tiene un proveedor de memoria externo (`memory.provider`), Hermes le sincroniza la conversación al terminar cada turno, igual que en Telegram (decisión del usuario: memoria como en Telegram).
  - La herramienta `memory` puede actualizar MEMORY.md y USER.md, siempre tras «Permitir». Antes de cada turno, AgoraOne copia esos dos archivos si cambiaron desde la última copia, en la misma carpeta que el editor (`.agora/profile-backups/<perfil>`, 20 copias por archivo).
  - Si un turno falla o se detiene después de usar herramientas, el error dice cuáles se usaron, para no repetirlas a ciegas.
- **Procesos**: el puente vive mientras la conversación se usa (5 minutos de inactividad); al cerrarse apaga sus MCP y, si no termina, se cierra su grupo de procesos. Los puentes de perfil tienen su propio cupo de cuatro, aparte del de Luma.
- **Verificación**:
  - `server/hermes-agent-bridge.test.ts` usa la instalación real de Hermes con un perfil ficticio y un modelo falso local. Comprueba:
    - que la lectura se hace sin preguntar;
    - que una escritura denegada no ocurre y una permitida sí;
    - que no se persiste ningún permiso;
    - que la tarjeta muestra la orden completa y oculta solo la clave;
    - que un trabajo en segundo plano se bloquea sin tarjeta;
    - que todo ello se cumple con las aprobaciones desactivadas en el perfil.
  - `scripts/verify-profile-tools.mjs` comprueba la tarjeta en el navegador sin turno real.
  - Prueba real breve con un perfil (sin acciones): responde con su modelo y sus 25 herramientas disponibles.

Luma mantiene su conversación separada. Un perfil también puede consultar documentos de la biblioteca y notas del vault.

## Adjuntar una nota o un documento
En el lector de la biblioteca y en el del vault, **Consultar con** permite elegir Luma o cualquier perfil detectado. Elegir solo adjunta el documento al chat de ese perfil (cada chat tiene su propio adjunto) y abre la conversación; nada se envía hasta que el usuario escribe y envía un mensaje. Entonces el turno lleva la identidad del perfil (SOUL, MEMORY, USER) y el texto del documento, releído en backend con los mismos límites y permisos que con Luma: copias privadas solo de su propietario, notas solo por la ruta de envío con CSRF, 24 KiB como máximo. El documento va en el mensaje como datos de solo lectura y el prompt de identidad indica que no son instrucciones. Cada mensaje registra la revisión del documento enviado junto a la de los archivos de identidad. Renombrar o eliminar una copia actualiza o retira el adjunto de todos los chats. Si el perfil deja de estar en el catálogo, su adjunto pendiente se descarta. No hay un tope conjunto para el turno: en el peor caso suma identidad (96 KiB), documento (24 KiB), historial (60 000 caracteres) y mensaje (6000); con un modelo de contexto pequeño el proveedor puede rechazarlo y el chat muestra el error, y basta con quitar el adjunto o abrir una conversación nueva. Verificación: `node scripts/verify-profile-attachment.mjs` (sin inferencia).

## Separación y persistencia
- Cada conversación se liga en backend a propietario, identidad del agente, perfil y contexto profile-chat. El cliente solo selecciona un ID de perfil detectado.
- Sesión Hermes diferente para cada conversación, en el `state.db` del propio perfil. Luma sigue en su entorno privado de .agora.
- Historial de AgoraOne en .agora/conversations, sin importar sesiones de Desktop. Al recargar se recupera la última conversación de ese perfil en el navegador. **Nueva** inicia otra sin borrar la anterior.
- El navegador comprueba el perfil del historial recuperado; un ID colocado bajo otro perfil no se muestra allí. Otro propietario no puede leer ni enviar a esa conversación.
- Cada turno conserva nombres y revisiones de los archivos de identidad utilizados, no copias de su texto en el JSON de mensajes. El proceso aislado de Hermes y el proveedor pueden conservar contexto/respuestas según su funcionamiento.
- Leer una ficha no envía datos al proveedor; enviar una pregunta sí. Borrar la cookie puede dejar conversaciones anteriores inaccesibles desde la interfaz, como en Luma.

## Validación del contexto
El servidor no acepta SOUL, memoria, herramientas, rutas, proveedor ni historial suministrados por el cliente. Resuelve el perfil desde el catálogo, revalida su existencia, tombstone y archivos en cada envío. Un perfil borrado o un archivo no legible bloquea la ejecución antes de invocar el adaptador. Archivos ausentes se indican como ausentes y no se inventan.

Límites: 6000 caracteres de pregunta y el límite de historial existente. Los documentos y notas adjuntos llegan con las líneas que parecen claves ocultas. Sin sandbox de sistema operativo: el agente actúa con los permisos del perfil, y lo que cambie algo pasa por la confirmación del usuario.

## Verificación reproducible
`npm test` comprueba separación entre perfiles/usuarios, relectura, revocación, rechazo de inyección de herramientas/contexto y regresión de Luma. `npm run build` verifica tipos y frontend.

La prueba real anterior con proveedor de AgoraOne (`scripts/verify-profile-chat.ts`) se retiró en 0.13.0: la sustituye `server/hermes-agent-bridge.test.ts`, descrita arriba.

## Pendiente
Compartir la sesión con Telegram o Desktop (hoy cada conversación de AgoraOne es una sesión propia) y ejecución en otras versiones de Hermes. No quitar el bloqueo de commit de los puentes sin comprobar el contrato de esa versión.
