# Biblioteca de prueba

## Uso
Seleccionar Luma o Biblioteca → **Entrar en la biblioteca**. El interior incluye estanterías, mesa de lectura, Luma y salida. Se recorre con los mismos controles de primera persona. **Abrir catálogo** permite operar también con teclado y sin WebGL.

En **Documentos**, buscar por título y abrir uno de los dos ejemplos. El lector muestra texto, ID y revisión. **Consultar este documento con Luma** selecciona el documento como contexto del próximo mensaje. Escribir una pregunta y enviar. No se produce inferencia al entrar, recorrer, buscar, abrir o adjuntar.

Cada mensaje enviado relee el documento en backend; la revisión registrada junto al mensaje corresponde al texto realmente enviado. **Quitar documento** evita adjuntarlo en mensajes posteriores; no borra respuestas anteriores ni la conversación. Nueva conversación continúa estando disponible.

## Recursos y permisos
La biblioteca también permite importar copias privadas TXT/Markdown desde **Añadir documento**. Estas copias están separadas por propietario; ver docs/importacion.md. Las restricciones del catálogo cerrado descritas a continuación corresponden a los ejemplos compartidos.

Recurso lógico `library-test`, compartido por las identidades locales del navegador únicamente para estos ejemplos. Catálogo cerrado en `server/library.ts`:

| ID | Archivo dentro de resources/library-test |
| --- | --- |
| welcome | bienvenida.txt |
| orbital-garden | huerto-orbital.txt |

Documentos ficticios creados en el proyecto; no se usan carpetas personales. No hay carga, edición, borrado, movimiento ni exploración arbitraria del disco. No se incorporan automáticamente nuevos archivos: añadir recursos requiere ampliar el registro backend.

El servidor valida ID permitido, raíz canónica, ausencia de symlinks, archivo regular, un único enlace físico, tamaño máximo de 24 KiB y texto UTF-8 sin NUL. Lectura por descriptor O_RDONLY/O_NOFOLLOW, limitada incluso si el archivo crece. Los errores no revelan rutas. Los endpoints de biblioteca rechazan mutaciones. Las conversaciones siguen exigiendo propietario, agente Luma y contexto library-lobby.

La carpeta resources está bloqueada en Vite; Express solo publica dist. Leer documentos pasa por los endpoints de AgoraOne. El usuario local que controla el proceso y el disco sigue siendo de confianza; no es un sandbox del sistema operativo ni una colección privada por usuario.

## Hermes
Hermes sigue con **cero herramientas**. El backend lee el documento elegido por el usuario y envía una instantánea de texto como contexto de la petición. Esto es lectura asistida por selección, no búsqueda autónoma por parte del agente. La instrucción de tratar documentos como datos reduce confusión del modelo; el control de permisos efectivo reside en el servicio de lectura, el contrato HTTP estricto y la ausencia de herramientas.

El texto seleccionado viaja al proveedor privado configurado para Luma. Puede persistir en el estado local de Hermes bajo `.agora/hermes`; el historial visible de AgoraOne registra la pregunta, la respuesta y la referencia/revisión de la fuente. No se registra como una llamada a herramienta.

## Verificación
`npm test`: permisos de lectura, traversal, IDs inválidos, enlaces simbólicos y duros, tamaño, binarios, solicitud de escritura, propiedad de conversación y revalidación por turno.

Con `npm run build` y backend arrancado:

```sh
node scripts/verify-library.mjs
# Una petición de inferencia real para comprobar lectura y cita:
node scripts/verify-library.mjs --live
```

## Pendiente
Búsqueda en contenido, permisos compartidos por colección, herramientas autónomas del agente y organización/escritura. La importación TXT/Markdown y extracción de texto PDF/DOCX ya están disponibles, privadas por identidad local; también renombrado y borrado de copias. Ver docs/importacion.md. No ampliar capacidades de Hermes sin diseñar y probar primero esos límites.
