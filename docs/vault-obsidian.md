# Vault de Obsidian (18/10/2026)

El usuario aprobó leer sus notas de Obsidian desde AgoraOne. Es solo lectura: no se crea, modifica ni mueve nada en el vault y no se guardan copias ni índices en disco.

## Qué se lee
- **Vaults**: los del registro de Obsidian (`obsidian.json`), igual que la detección del catálogo. El cliente solo envía identificadores opacos (`vault-…`, `note-…`); las rutas se resuelven en el backend con un recorrido nuevo del vault (reutilizado 15 s).
- **Notas**: solo ficheros `.md`. Se omiten carpetas y ficheros ocultos (`.obsidian`, `.trash`…), enlaces simbólicos, enlaces duros, adjuntos y cualquier otro tipo de fichero. Límites: 5000 notas, 12 niveles de carpetas, 50 000 entradas recorridas y 256 KiB por nota; UTF-8 estricto. Una carpeta ilegible se salta (el listado se marca como limitado) y las notas demasiado grandes aparecen marcadas.
- **Búsqueda**: en títulos y contenido, sin distinguir mayúsculas ni tildes, leyendo las notas al vuelo con un tope de 16 MiB por búsqueda; máximo 50 resultados con la línea coincidente. El título se comprueba aunque el contenido no se pueda leer.

## Consulta con Luma o con un perfil
«Consultar esta nota con…» adjunta la nota al chat de Luma o del perfil elegido como un documento de la biblioteca (ver docs/conversaciones-perfiles.md). Solo se envía al modelo si después el usuario envía un mensaje, y solo la resuelve la ruta de envío de mensajes (con CSRF); la ruta de documentos de la biblioteca no acepta notas. Se envían el título relativo («vault · carpeta/nota») y el contenido, nunca rutas absolutas; el contenido va tal cual, igual que los documentos importados. Las notas de más de 24 KiB se recortan para que el documento completo, aviso incluido, quepa en 24 KiB. El puente de Python (`server/hermes_bridge.py`) acepta los ID `note-` en su lista de documentos permitidos; una prueba comprueba que esa lista y los ID del backend coinciden. La consulta se verifica con un doble del adaptador y un vault ficticio, sin enviar notas reales al proveedor.

## Interfaz
- **Ficha del vault** (`src/ui/vault-panel.tsx`): filtro por carpeta, búsqueda por título y en el contenido, lectura y consulta.
- **Interior** (`src/world/vault-interior.tsx`): una estantería por carpeta de primer nivel, de la más grande a la más pequeña (hasta 10; el resto se ve desde la ficha), con el número de notas. Abrir una estantería muestra la ficha filtrada por esa carpeta.

## Seguridad y pruebas
Rutas bajo `/api/hermes/vaults/…`, protegidas por la cabecera CSRF como el resto de datos locales. Lector en `server/vault-notes.ts`. Pruebas: `server/vault-notes.test.ts` (carpetas ocultas, papelera, adjuntos, enlaces simbólicos a fichero y a carpeta, carpeta ilegible, UTF-8 inválido, búsqueda sin tildes, recorte dentro de 24 KiB, IDs desconocidos, lista del puente) y `server/app.test.ts` (CSRF, vault no registrado, ruta de biblioteca sin notas y consulta de punta a punta con doble del adaptador). Navegador: `scripts/verify-vault.mjs` (escritorio y móvil, sin peticiones de inferencia).
