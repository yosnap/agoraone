# Importar documentos propios

## Uso
En Luma → **Documentos**, pulsar **Añadir documento** y elegir un archivo. Se admite TXT o Markdown (.txt, .md, .markdown), texto UTF-8, hasta 24 KiB; también PDF y DOCX de hasta 5 MiB con un máximo de 24 KiB de texto extraído. Límite de 100 documentos por identidad local.

PDF/DOCX se convierten localmente a texto: se conserva ese texto con el nombre original, no el archivo binario ni su maquetación, imágenes o adjuntos. PDF: hasta 100 páginas, sin OCR ni contraseñas. Documentos escaneados sin texto, vacíos, dañados o demasiado extensos muestran un error y no se guardan parcialmente. Revisa el texto en el lector antes de consultarlo; el orden de columnas, tablas o elementos complejos puede variar.

Se guarda una copia privada dentro de AgoraOne y se abre en el lector. El original no se mueve ni modifica. No se solicita acceso a carpetas completas; el navegador solo envía el archivo elegido. Un archivo importado no se adjunta automáticamente al chat.

Para consultarlo: **Consultar este documento con Luma**, escribir la pregunta y enviar. Solo en ese momento su texto se transmite al proveedor de inferencia configurado. Leer, importar y buscar por título no producen llamadas a modelos. Markdown se muestra como texto, sin ejecutar ni renderizar HTML.

## Persistencia y privacidad
Copias en `.agora/library/<hash-del-propietario>/<id-aleatorio>.json`, directorios 0700 y archivos 0600, fuera de los servidores de archivos estáticos y del control de versiones. El nombre original se conserva únicamente como título, nunca como ruta de escritura. IDs nuevos no sobrescriben documentos con el mismo nombre.

La propiedad se obtiene de la cookie HttpOnly del backend, no de parámetros enviados por el cliente. Otro navegador/identidad no puede listar, leer ni adjuntar estas copias a sus propias conversaciones. Se revalida el propietario al leer y al enviar cada turno a Hermes.

La identidad es la del navegador local, no una cuenta autenticada. Borrar o perder la cookie (caduca a los 30 días) deja estas copias inaccesibles desde la interfaz; los originales siguen intactos y pueden importarse de nuevo. No hay aún recuperación de identidad ni cifrado en disco. Quien controla el usuario de macOS y su disco puede acceder al almacenamiento local.

Si consultas un documento con Luma, su texto también puede persistir en el estado local de Hermes aislado y sus respuestas. Quitar el adjunto evita envíos posteriores; no borra el contenido ya enviado al proveedor ni las conversaciones anteriores.

## Renombrar y eliminar copias
Abrir un documento propio en **Documentos**. Debajo del texto aparecen **Renombrar** y **Eliminar copia**. Los ejemplos no ofrecen esas operaciones.

Renombrar cambia únicamente el título visible: de 1 a 160 caracteres, sin rutas, sin necesidad de conservar una extensión. Mantiene el ID, los bytes, la revisión del contenido y el nombre original guardado como metadato. La escritura es atómica y conserva permisos 0600. Si estaba adjunto al chat, su título se actualiza; las referencias de mensajes anteriores conservan el nombre histórico.

Eliminar muestra una confirmación con el título de la copia. **Cancelar** no cambia nada; **Confirmar eliminación** retira la copia del almacenamiento privado y del catálogo y, si estaba seleccionada, quita el adjunto del chat. No toca el original ni elimina conversaciones o textos ya enviados a Hermes/proveedor. Una consulta que ya recibió la instantánea puede terminar; las nuevas peticiones con ese ID se rechazan. Una pestaña antigua puede mostrar texto previamente cargado hasta recargarla, pero no volver a adjuntarlo con éxito.

El backend valida propietario, formato y archivo autorizado antes de ambas operaciones, además de Host, Origin y CSRF. No se permite mutar ejemplos, archivos ajenos, enlaces ni rutas del cliente. El borrado no tiene papelera; puedes volver a importar el original como una copia nueva.

## Contrato y límites
- POST `/api/library/imports`: `{name, base64}` estrictos, con origen y CSRF válidos. Límite JSON de 7 MiB para transportar hasta 5 MiB binarios en base64. TXT/Markdown conservan el límite de 24 KiB.
- PATCH `/api/library/documents/:id`: `{title}` estricto; DELETE en la misma ruta elimina únicamente una copia del propietario. ID inexistente, ajeno o de ejemplo: 404.
- Se validan extensión, nombre sin rutas, base64 canónico, UTF-8, contenido no vacío, ausencia de controles binarios, tamaño y cuota en backend.
- Se persiste el texto recibido o extraído; no se acepta una ruta del Mac ni se realiza lectura del original desde el servidor. Los registros antiguos siguen siendo compatibles.
- El registro privado usa ID aleatorio, propietario e integridad de formato. Lecturas por descriptor, con rechazo de symlinks/hardlinks y tamaño acotado.
- Los ejemplos siguen compartidos; las importaciones son privadas por identidad.
- Hermes conserva cero herramientas. La instantánea autorizada es contexto de lectura, no una capacidad para explorar el disco.

## Extracción local
`server/document-extraction.ts` valida la carga y limita a dos extracciones simultáneas. `server/extract-document.mjs` procesa bytes por stdin en un proceso separado, sin variables heredadas ni credenciales: 15 segundos y heap V8 de 128 MiB. Esto limita recursos, pero no es un sandbox de sistema operativo ni un límite total de memoria nativa.

PDF.js recibe bytes, sin URL, con evaluación desactivada. Mammoth usa `extractRawText({buffer})`, sin conversión HTML ni acceso externo habilitado. DOCX pasa antes por validación ZIP con yauzl: hasta 1000 entradas, 16 MiB descomprimidos declarados y reales, sin entradas cifradas o duplicadas. No se ejecutan macros, scripts o enlaces del documento. Los binarios no se guardan en disco.

Referencias de las APIs: [PDF.js](https://github.com/mozilla/pdf.js) y [Mammoth](https://github.com/mwilliamson/mammoth.js#extracting-raw-text).

Auditoría del 17/10/2026: `npm audit` informa tres avisos moderados de una misma cadena `mammoth → argparse → sprintf-js` (DoS por precisión de formato). En la versión instalada, argparse solo se importa desde `bin/mammoth`, CLI que esta aplicación no usa; la extracción importa `lib/index.js`. No hay versión corregida de sprintf-js publicada en el registro consultado. Se registra para seguimiento; no se fuerza el downgrade incompatible sugerido por npm.

## Pruebas
`npm test` cubre importación, persistencia, permisos 0600/0700, propietarios, validación, cuota, CSRF y rechazo de lectura/chat ajenos. Las pruebas de API usan almacenamiento temporal.

Con build y backend arrancados:

```sh
node scripts/verify-import.mjs
# Una petición real usando un documento ficticio generado por la prueba:
node scripts/verify-import.mjs --live
# Renombrado, cancelación, persistencia, borrado y retirada del adjunto, sin inferencia:
node scripts/verify-document-management.mjs
# PDF y DOCX ficticios: extracción, lectura, adjunto y móvil:
node --import tsx scripts/verify-formats.mjs
# Dos consultas reales a Hermes, una por formato:
node --import tsx scripts/verify-formats.mjs --live
```

La verificación usa un contexto de navegador nuevo; sus copias de prueba no aparecen en el catálogo del navegador habitual del usuario.
