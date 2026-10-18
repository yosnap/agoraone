# Conversar con perfiles de Hermes

Seleccionar un personaje/perfil y abrir **Conversar con <nombre>**. Escribir y enviar a Hermes. Abrir la ficha o la pestaña no inicia inferencia; enviar sí transmite SOUL.md, MEMORY.md y USER.md disponibles al proveedor de AgoraOne.

## Identidad y límites
Se crea un AIAgent real de la instalación verificada en una sesión aislada. El backend relee la identidad del perfil en cada turno y la incorpora al contexto del agente. SOUL aporta rol/estilo; MEMORY y USER aportan recuerdos y datos. Se excluyen patrones reconocibles de credenciales, igual que en el visor local.

Esta modalidad usa el proveedor/modelo configurado en AgoraOne. No cambia la configuración de Hermes Desktop ni hereda automáticamente el proveedor, herramientas o chats de ese perfil. La interfaz lo indica antes de enviar.

Permisos efectivos: cero herramientas. Se comprueban antes y después de la ejecución; terminal, MCP, memoria editable y skills permanecen deshabilitados. Las instrucciones de SOUL no amplían permisos. La memoria original se usa en lectura y no se actualiza con esta conversación.

Luma mantiene su conversación separada. Un perfil también puede consultar documentos de la biblioteca y notas del vault.

## Adjuntar una nota o un documento
En el lector de la biblioteca y en el del vault, **Consultar con** permite elegir Luma o cualquier perfil detectado. Elegir solo adjunta el documento al chat de ese perfil (cada chat tiene su propio adjunto) y abre la conversación; nada se envía hasta que el usuario escribe y envía un mensaje. Entonces el turno lleva la identidad del perfil (SOUL, MEMORY, USER) y el texto del documento, releído en backend con los mismos límites y permisos que con Luma: copias privadas solo de su propietario, notas solo por la ruta de envío con CSRF, 24 KiB como máximo. El documento va en el mensaje como datos de solo lectura y el prompt de identidad indica que no son instrucciones. Cada mensaje registra la revisión del documento enviado junto a la de los archivos de identidad. Renombrar o eliminar una copia actualiza o retira el adjunto de todos los chats. Si el perfil deja de estar en el catálogo, su adjunto pendiente se descarta. No hay un tope conjunto para el turno: en el peor caso suma identidad (96 KiB), documento (24 KiB), historial (60 000 caracteres) y mensaje (6000); con un modelo de contexto pequeño el proveedor puede rechazarlo y el chat muestra el error, y basta con quitar el adjunto o abrir una conversación nueva. Verificación: `node scripts/verify-profile-attachment.mjs` (sin inferencia).

## Separación y persistencia
- Cada conversación se liga en backend a propietario, identidad del agente, perfil y contexto profile-chat. El cliente solo selecciona un ID de perfil detectado.
- Sesión Hermes diferente para cada conversación; entorno privado en .agora/hermes-conversations/<sesión>, separado del hogar original y del de Luma.
- Historial de AgoraOne en .agora/conversations, sin importar sesiones de Desktop. Al recargar se recupera la última conversación de ese perfil en el navegador. **Nueva** inicia otra sin borrar la anterior.
- El navegador comprueba el perfil del historial recuperado; un ID colocado bajo otro perfil no se muestra allí. Otro propietario no puede leer ni enviar a esa conversación.
- Cada turno conserva nombres y revisiones de los archivos de identidad utilizados, no copias de su texto en el JSON de mensajes. El proceso aislado de Hermes y el proveedor pueden conservar contexto/respuestas según su funcionamiento.
- Leer una ficha no envía datos al proveedor; enviar una pregunta sí. Borrar la cookie puede dejar conversaciones anteriores inaccesibles desde la interfaz, como en Luma.

## Validación del contexto
El servidor no acepta SOUL, memoria, herramientas, rutas, proveedor ni historial suministrados por el cliente. Resuelve el perfil desde el catálogo, revalida su existencia, tombstone y archivos en cada envío. Un perfil borrado o un archivo no legible bloquea la ejecución antes de invocar el adaptador. Archivos ausentes se indican como ausentes y no se inventan.

Límites: 64 KiB por archivo, 96 KiB de texto total, sin truncado silencioso adicional para la inferencia; 6000 caracteres de pregunta y límite de historial existente. Los patrones ocultos por el filtro de credenciales se mantienen ocultos al modelo. Sin sandbox de sistema operativo: el aislamiento es de configuración, estado y herramientas verificadas.

## Verificación reproducible
`npm test` comprueba separación entre perfiles/usuarios, relectura, revocación, rechazo de inyección de herramientas/contexto y regresión de Luma. `npm run build` verifica tipos y frontend.

Prueba real con perfiles ficticios (no envía memorias personales), usando el proveedor existente y dos llamadas de inferencia. Detener primero el backend de desarrollo para liberar 4317:

```sh
node --env-file-if-exists=.env --import tsx scripts/verify-profile-chat.ts
npm run dev
```

El script crea perfiles temporales dentro de .agora, verifica que cada respuesta contenga solo sus claves SOUL/MEMORY/USER, recarga, prueba un historial cruzado y móvil, y elimina las fuentes/conversaciones temporales al terminar. Los entornos aislados de Hermes de la prueba permanecen bajo .agora/hermes-conversations.

## Pendiente
Elección explícita del proveedor por perfil, escritura de memoria con revisión del usuario, herramientas limitadas por tarea, compartir sesiones con Desktop y ejecución en otras versiones. No quitar el bloqueo de commit del adaptador sin comprobar el contrato de esa versión.
