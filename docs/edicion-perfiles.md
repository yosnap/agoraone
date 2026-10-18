# Edición de perfiles

Desde la ficha de cada perfil (**Personalidad y memoria**) se editan sus archivos reales de Hermes, de modo que AgoraOne, Telegram y Desktop comparten la misma información. Decisión del usuario del 18/10/2026; sustituye la regla anterior de no modificar perfiles. Solo se escriben tres archivos: `SOUL.md` (Personalidad), `memories/MEMORY.md` (Recuerdos) y `memories/USER.md` (Lo que sabe de ti). Configuración, credenciales, sesiones y el resto del perfil no se tocan.

## Uso
- **Editar personalidad**: texto libre.
- **Editar recuerdos** y **Editar lo que sabe de ti**: una tarjeta por entrada, con «Añadir entrada» y «Quitar». Hermes guarda estas entradas separadas por una línea con `§`; AgoraOne las escribe en ese mismo formato (recortadas, sin vacías ni repetidas) para que la herramienta de memoria de Hermes no detecte cambios externos y siga funcionando.
- Contador con el límite de Hermes para cada archivo (`memory.memory_char_limit` y `memory.user_char_limit` del `config.yaml` del perfil; 2200 y 1375 por defecto). Por encima del límite no se puede guardar: Hermes tampoco admite recuerdos nuevos en ese caso.
- Si el archivo no existe, la ficha ofrece **Crear**.
- **Guardar en Hermes** pide confirmación. Los cambios se usan en las próximas conversaciones de Telegram, Desktop y AgoraOne; las sesiones ya abiertas pueden seguir con la versión anterior.

## Salvaguardas
- **Claves**: el editor trabaja sobre el texto con las líneas que parecen claves sustituidas por «[línea oculta N]» (ver docs/catalogo-hermes.md). Al guardar, el servidor repone cada marca con la línea original leída del disco; quitar una marca borra esa línea y una marca inexistente se rechaza. Si se pulsó «Mostrar», se edita el texto completo.
- **Conflictos**: cada guardado lleva la revisión que se editó. Si Hermes cambió el archivo entretanto, se rechaza (409) y hay que volver a cargarlo; nunca se sobrescribe un cambio ajeno.
- **Copia previa**: antes de escribir se copia la versión actual a `.agora/profile-backups/<id de perfil>/<archivo>.<fecha UTC>.bak` (permisos 0600, excluida de git por `.gitignore`). Se conservan las 20 más recientes por archivo.
- **Escritura**: la hace `server/hermes_profile_write.py` (Python sin dependencias, modo aislado): toma el mismo bloqueo exclusivo `<archivo>.lock` que la herramienta de memoria de Hermes (sin seguir enlaces), vuelve a comprobar la revisión dentro del bloqueo, exige que toda la cadena de carpetas sea real y esté dentro del hogar de Hermes, lee sin seguir enlaces y rechaza enlaces duros, y sustituye el archivo de forma atómica (temporal, fsync, renombrado) conservando sus permisos. Un BOM inicial no cambia la revisión (Hermes lee con `utf-8-sig`).
- **Borrador**: el editor guarda la versión desde la que empezó. Si Hermes cambia el archivo mientras se edita, se avisa; al guardar se rechaza y «Descartar y recargar» trae la versión nueva. «Mostrar» queda bloqueado mientras hay un editor abierto; si se editó con las líneas visibles, el texto se guarda tal cual.
- **Análisis de amenazas**: Hermes revisa sus propias escrituras de memoria en busca de instrucciones inyectadas; AgoraOne no lo repite porque el texto lo escribe el usuario. Al cargar, Hermes sigue apartando de la sesión cualquier entrada que considere peligrosa.
- **Límites**: 64 KiB por archivo, sin caracteres de control; perfiles resueltos desde el catálogo por ID (el cliente nunca indica rutas); ruta `PUT /api/hermes/profiles/:id/files/:name` con CSRF y nombres de archivo cerrados.

## Código y verificación
- `server/profile-editor.ts`, `server/hermes_profile_write.py`, `src/ui/profile-file-editor.tsx`.
- Pruebas: `server/profile-editor.test.ts` (líneas ocultas conservadas, copia previa, conflicto, formato y límite de memoria, archivo nuevo, enlaces simbólicos, perfil desconocido) y la ruta HTTP en `server/app.test.ts`.
- Navegador: `node scripts/verify-profile-editor.mjs` intercepta el guardado, así que nunca escribe en el perfil real.
