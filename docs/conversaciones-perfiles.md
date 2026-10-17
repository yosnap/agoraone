# Conversar con perfiles de Hermes

Seleccionar un personaje/perfil y abrir **Conversar con <nombre>**. Escribir y enviar a Hermes. Abrir la ficha o la pestaña no inicia inferencia; enviar sí transmite SOUL.md, MEMORY.md y USER.md disponibles al proveedor de AgoraOne.

## Identidad y límites
Se crea un AIAgent real de la instalación verificada en una sesión aislada. El backend relee la identidad del perfil en cada turno y la incorpora al contexto del agente. SOUL aporta rol/estilo; MEMORY y USER aportan recuerdos y datos. Se excluyen patrones reconocibles de credenciales, igual que en el visor local.

Esta modalidad usa el proveedor/modelo configurado en AgoraOne. No cambia la configuración de Hermes Desktop ni hereda automáticamente el proveedor, herramientas o chats de ese perfil. La interfaz lo indica antes de enviar.

Permisos efectivos: cero herramientas. Se comprueban antes y después de la ejecución; terminal, MCP, memoria editable y skills permanecen deshabilitados. Las instrucciones de SOUL no amplían permisos. La memoria original se usa en lectura y no se actualiza con esta conversación.

Luma mantiene su conversación y biblioteca separadas. El chat de perfiles no admite adjuntar documentos de la biblioteca en este hito.

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
