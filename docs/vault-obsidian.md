# Vault de Obsidian (18/10/2026)

El usuario aprobó leer sus notas de Obsidian desde AgoraOne y, desde 0.14.0, editarlas y crear notas nuevas (decisión del 18/10/2026). No se mueve, renombra ni borra nada, no se guardan índices en disco y, antes de cada guardado, se copia la versión anterior.

## Editor visual (0.17.0)
Decisión del usuario (18/10/2026): el editor de notas, de la personalidad (SOUL) y de las instrucciones de tareas y tarjetas es una **vista en vivo como la de Obsidian**, no un WYSIWYG que reescriba el Markdown.
- **Cómo funciona**: CodeMirror 6 edita el texto tal cual (`src/ui/markdown-editor.tsx`) y solo lo decora (`src/ui/markdown-live.ts`). Los títulos se ven grandes; negrita, cursiva, tachado, código, enlaces, `[[enlaces internos]]`, `==resaltado==`, etiquetas, citas y avisos, listas y casillas se ven con formato. Las marcas (`#`, `**`, `[[ ]]`, `>`, `- [ ]`) solo aparecen en las líneas donde está el cursor, para poder editarlas. Lo que se guarda es exactamente lo escrito.
- **Edición**: barra de botones (negrita, cursiva, tachado, encabezados 1 a 3, lista, lista numerada, tarea, enlace interno, enlace web, cita y código) y atajos ⌘B, ⌘I y ⌘K. Al escribir `[[`, se sugieren los títulos del vault. Las casillas de tareas se marcan con un clic.
- **Detalles**:
  - Al pulsar Intro en una lista, la lista continúa (y la numerada se renumera), como en Obsidian.
  - Tab no inserta sangría: pasa al siguiente campo, para poder moverse con el teclado.
  - Las notas con saltos de línea de Windows (CRLF) no aparecen como modificadas al abrirlas, y se guardan con CRLF.
  - Dentro del código no se interpretan `[[ ]]`, `==` ni `#etiquetas`.
  - Si el editor no se puede cargar, aparece un cuadro de texto normal para no perder lo escrito.
- **Carga**: el editor va en su propio trozo (`editor`, unos 170 KB comprimidos) y solo se descarga al abrir un editor.

## Editar y crear notas (0.14.0)
- **Editar**:
  - El libro abierto tiene **Editar nota**: un editor de Markdown sobre el texto tal como se lee, con las líneas que parecen claves como «[línea oculta N]» salvo que se hayan mostrado.
  - **Guardar en el vault** pide confirmación. El servidor (`VaultNotes.save`) comprueba que la nota no haya cambiado desde que se abrió (revisión SHA-256 de sus bytes); si cambió en Obsidian, responde 409 y la interfaz ofrece **Recargar y conservar mi texto** o **Descartar mi texto**. **Cancelar** pide confirmación si hay cambios, y Escape no cierra el libro mientras se edita.
  - Repone las líneas ocultas desde el disco y copia la versión actual en `.agora/vault-backups/<vault>/` (20 copias por nota).
  - Escribe sobre el mismo archivo con un descriptor abierto sin seguir enlaces, tras comprobar con ese mismo descriptor que sigue siendo la nota del vault (mismo inodo, carpeta sin enlaces) y que sus bytes son la revisión abierta. Así se conservan la fecha de creación que usa Obsidian, los permisos y los atributos, y no queda hueco para pisar un guardado de Obsidian.
  - Conserva los finales de línea (CRLF o LF) y el BOM del archivo.
  - Las notas con caracteres de control no se editan aquí: se avisa de que se editen en Obsidian, para no alterarlos.
  - Si se quita una línea «[línea oculta N]», esa línea se borra del archivo, y si se repite, se copia. La confirmación lo avisa.
  - Mientras se edita, el libro no se cierra ni pasa de página, para no perder el borrador.
- **Crear**:
  - **+ Nueva nota** crea `<título>.md` en la carpeta abierta (o en la raíz) con un encabezado y la abre en el editor.
  - Solo en carpetas que ya tienen notas y nunca sobrescribe. Rechaza títulos con `/ \ : * ? " < > | # ^ [ ]`, caracteres invisibles, punto inicial o más de 250 bytes; si la carpeta se cambia por un enlace mientras se crea, se deshace.
- **Límites**:
  - Se rechazan las notas que son enlaces simbólicos o duros y las carpetas enlazadas.
  - Máximo 256 KiB.
  - El texto no puede llevar caracteres de control.
- **Dónde corre**: las escrituras se hacen en el mismo hilo que las lecturas, así que el listado y la búsqueda ven la nueva versión al momento. Rutas `PUT /api/hermes/vaults/:id/notes/:noteId` y `POST /api/hermes/vaults/:id/notes`, con CSRF.
- **Verificación**:
  - `server/vault-notes.test.ts` comprueba que las claves se conservan, la copia, los permisos, el conflicto, los enlaces, las carpetas inexistentes o enlazadas y que no se sobrescribe.
  - `server/app.test.ts` comprueba CSRF y el cuerpo estricto.
  - `scripts/verify-vault-editor.mjs` usa un vault ficticio interceptado: nunca lee ni escribe tus notas.

## Qué se lee
- **Vaults**: los del registro de Obsidian (`obsidian.json`), igual que la detección del catálogo. El cliente solo envía identificadores opacos (`vault-…`, `note-…`); las rutas se resuelven en el backend con un recorrido nuevo del vault (reutilizado 15 s).
- **Notas**: solo ficheros `.md`. Se omiten carpetas y ficheros ocultos (`.obsidian`, `.trash`…), enlaces simbólicos, enlaces duros, adjuntos y cualquier otro tipo de fichero. Límites: 5000 notas, 12 niveles de carpetas, 50 000 entradas recorridas y 256 KiB por nota; UTF-8 estricto. Una carpeta ilegible se salta (el listado se marca como limitado) y las notas demasiado grandes aparecen marcadas.
- **Búsqueda**: en títulos y contenido, sin distinguir mayúsculas ni tildes, leyendo las notas al vuelo con un tope de 16 MiB por búsqueda; máximo 50 resultados con la línea coincidente. El título se comprueba aunque el contenido no se pueda leer.

## Consulta con Luma o con un perfil
Las líneas que parecen claves (mismo filtro que la identidad de los perfiles, ver docs/catalogo-hermes.md) se ocultan al leer, en los fragmentos de búsqueda y siempre al consultar; el lector ofrece «Mostrar» para verlas bajo petición. «Consultar esta nota con…» adjunta la nota al chat de Luma o del perfil elegido como un documento de la biblioteca (ver docs/conversaciones-perfiles.md). Solo se envía al modelo si después el usuario envía un mensaje, y solo la resuelve la ruta de envío de mensajes (con CSRF); la ruta de documentos de la biblioteca no acepta notas. Se envían el título relativo («vault · carpeta/nota») y el contenido, nunca rutas absolutas; el contenido va tal cual, igual que los documentos importados. Las notas de más de 24 KiB se recortan para que el documento completo, aviso incluido, quepa en 24 KiB. El puente de Python (`server/hermes_bridge.py`) acepta los ID `note-` en su lista de documentos permitidos; una prueba comprueba que esa lista y los ID del backend coinciden. La consulta se verifica con un doble del adaptador y un vault ficticio, sin enviar notas reales al proveedor.

## Colores y estructura por carpetas (0.19.0, árbol a la izquierda en 0.24.0)
Decisión del usuario (20/10/2026): la ficha del vault muestra la estructura completa de carpetas de un vistazo, con color. Tras probar un acordeón de lado y luego un desplegable a lo ancho, el usuario decidió (20/10/2026) volver al diseño que se veía mejor: **árbol de carpetas a la izquierda y notas a la derecha**.
- **Árbol de carpetas**: la ficha abre al ancho del editor de SOUL del perfil (760px o la pantalla menos 40px) para que quepa el árbol a la izquierda y las notas a la derecha; el árbol muestra la estructura completa (no solo las subcarpetas directas) y cada carpeta es una fila con su punto de color, su nombre y el número de notas que contiene a cualquier profundidad; la flecha plega o despliega la rama y la propia fila lleva a la carpeta (marcada cuando es la actual). La primera fila es la raíz (notas sueltas). Al abrir la ficha, el primer nivel queda desplegado y el resto plegado; al navegar (árbol, migas o sala 3D) se despliegan las ramas del camino y el plegado que elija el usuario se respeta. En pantallas estrechas el bloque pasa a scroll propio por encima de las notas.
- **Select moderno propio**: decisión del usuario (20/10/2026): **ningún select nativo en toda la aplicación**; `src/ui/modern-select.tsx` cubre los desplegables que quedan (diana de «Consultar con», perfil del centro MCP y parámetros de herramienta de «Usar esta herramienta»); las opciones pueden llevar color, punto e indentación y el control funciona con teclado.
- **Color por carpeta**: árbol, estantes de la carpeta y libros de la sala 3D usan un color estable por ruta (hash sobre la misma paleta de ocho tonos); las notas de la raíz usan un tono neutro.
- Código: estructura y colores en `src/ui/vault-folders.ts`; el árbol se dibuja en `src/ui/vault-panel.tsx` (estado `collapsed` por rama).
- Nota de compilador: el TypeScript 7 instalado falla si la etiqueta de apertura de un JSX termina una línea sin `>` (las propiedades siguen en la línea siguiente); en este proyecto las etiquetas de apertura se cierran con `>` en la misma línea o van entre paréntesis.
- Verificación: `scripts/verify-vault.mjs` comprueba en escritorio y móvil que no queda ningún select nativo en la ficha, que el árbol lleva a su carpeta, que plegar y desplegar no pierde ramas, y que el libro, la búsqueda y el interior siguen funcionando, sin peticiones mutadoras.

## Interfaz: el vault como librería (0.11.0)
- **Ficha del vault** (`src/ui/vault-panel.tsx`): se recorre como en Obsidian, carpeta a carpeta. Migas de pan con la ruta actual, las subcarpetas como estantes (con el número de notas que contienen a cualquier profundidad) y debajo las notas de esa carpeta. Buscar filtra por título dentro de la carpeta actual y sus subcarpetas; «Buscar en el contenido» usa la búsqueda del servidor y muestra los resultados de esa rama.
- **Libro abierto** (`src/ui/vault-book.tsx`): abrir una nota la muestra como un libro sobre la escena. En la página izquierda están la carpeta, el índice de encabezados, el aviso de líneas ocultas con «Mostrar», «Consultar con…» y el paso a la nota anterior o siguiente de la misma carpeta; en la derecha, la nota con formato. Se cierra con ×, Escape o pulsando fuera.
- **Formato** (`src/ui/markdown.tsx`): lector propio que solo construye elementos React, nunca HTML de la nota, así que una nota no puede inyectar marcado ni scripts. Muestra propiedades (frontmatter), encabezados, listas y tareas, citas y avisos de Obsidian (`> [!tip]`), tablas, bloques de código, resaltado, etiquetas y las líneas ocultas. Los enlaces web solo se abren si son `http`, `https` o `mailto`, en otra pestaña. Los `[[enlaces internos]]` abren la nota enlazada del mismo vault (por título o ruta, con preferencia por la carpeta actual, `src/ui/vault-links.ts`); si no existe, se ven atenuados. Imágenes y adjuntos incrustados aparecen solo por su nombre: nunca se leen.
- **Interior** (`src/world/vault-interior.tsx`, `src/world/vault-shelf.tsx`): sala de lectura con una estantería por carpeta de primer nivel, de la más grande a la más pequeña (hasta 10; el resto, desde la ficha). Cada libro es una nota real (hasta 36 por estantería, ordenadas por subcarpeta y título) con el color de su subcarpeta; al señalarlo se ve su título y al pulsarlo se abre como libro. Los títulos ya estaban en la ficha; el contenido solo se lee al abrir. El rótulo de la estantería y la mesa de lectura abren la ficha en esa carpeta o en la raíz. Mesa, sillones, ventanas, alfombra y plantas son solo decoración.

## Seguridad y pruebas
Rutas bajo `/api/hermes/vaults/…`, protegidas por la cabecera CSRF como el resto de datos locales. Lector en `server/vault-notes.ts`. Pruebas: `server/vault-reader.test.ts` (el lector no genera marcado ni enlaces peligrosos, formato de Obsidian, resolución de enlaces internos), `server/vault-notes.test.ts` (carpetas ocultas, papelera, adjuntos, enlaces simbólicos a fichero y a carpeta, carpeta ilegible, UTF-8 inválido, búsqueda sin tildes, recorte dentro de 24 KiB, IDs desconocidos, lista del puente) y `server/app.test.ts` (CSRF, vault no registrado, ruta de biblioteca sin notas y consulta de punta a punta con doble del adaptador). Navegador: `scripts/verify-vault.mjs` (escritorio y móvil: recorrer carpetas, abrir y cerrar un libro, búsqueda, interior y consulta preparada, sin peticiones de inferencia ni mutadoras).
