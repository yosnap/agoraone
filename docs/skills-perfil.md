# Skills de los perfiles (20/10/2026)

El usuario aprobó entrenar sus skills desde AgoraOne (verlas, crearlas, consultarlas y mejorarlas): la ficha de cada perfil tiene la pestaña **Skills de <perfil>**, que trabaja sobre la carpeta real `skills/` de ese perfil en Hermes.

## Qué se ve
- **Listado**: todas las `SKILL.md` de la carpeta `skills/` del perfil, a dos niveles (`categoría/skill` o `skill` en la raíz), agrupadas por categoría con un color estable por categoría (mismo criterio que el árbol del vault) y con su contador. Busca por nombre, categoría o descripción.
- **Cada skill** muestra su nombre (del frontmatter o de la carpeta) y la descripción del frontmatter, acortados y con las líneas que parecen claves ya protegidas.
- **Lectura**: abrir una skill enseña su `SKILL.md` como Markdown. Las líneas que parecen claves van ocultas con su aviso y «Mostrar», igual que la identidad y las notas; leer una skill **nunca se envía al modelo**: son el propio agente del perfil quien las usa.
- **Categorías**: una carpeta de categoría que no tenga `SKILL.md` (solo agrupa skills) no aparece como skill.

## Escribir
- **Editar**: sobre el `SKILL.md` tal cual (frontmatter incluido), con el editor visual de Markdown y las líneas ocultas como «[línea oculta N]» que se reponen al guardar. **Guardar en Hermes** pide confirmación, guarda antes una copia en `.agora/profile-backups/<perfil>/skills/<skill>/` (20 por skill) y si la skill cambió en Hermes entre tanto responde 409 (se recarga, nunca se pisa).
- **Crear**: «+ Nueva skill» crea `skills/<categoría>/<nombre>/SKILL.md` con su frontmatter (`name` y `description`) y el cuerpo escrito. Categoría y nombre: 1 a 64 caracteres, letra o número al principio, sin espacios. No sobrescribe: si ya existe, se rechaza.
- Las próximas conversaciones del perfil (AgoraOne, Telegram, Desktop) usan la skill nueva o cambiada; las ya abiertas pueden seguir con la versión anterior.

## Límites y seguridad
- Solo carpetas reales: se saltan enlaces simbólicos y duros, carpetas ocultas y de herramientas (`node_modules`, `__pycache__`…), y la carpeta `skills` del perfil que se resuelve en el backend; el cliente nunca indica rutas.
- Máximo 300 skills por perfil (el listado se marca limitado) y 64 KiB por `SKILL.md` (las mayores se listan pero no se abren).
- Rutas `GET|PUT /api/hermes/profiles/:id/skills(/:skillId)` y `POST /api/hermes/profiles/:id/skills`, bajo la cookie de acceso y la cabecera CSRF como el resto de la API. Las escrituras las hace `server/hermes_profile_write.py` (el mismo escritor aislado que la identidad): comprobación de revisión dentro del proceso, carpeta real y sin enlaces, y sustitución atómica conservando permisos.
- Código: `server/hermes-skills.ts` (lectura, edición y creación), `src/ui/profile-skills.tsx` (la pestaña), `shared/hermes-skills.ts` (tipos).
- Pruebas: `server/hermes-skills.test.ts` (listado con enlaces y carpetas excluidas, lectura con líneas ocultas, guardado con copia previa y conflicto, creación con frontmatter y nombres inválidos) y las rutas en `server/app.test.ts` (CSRF también en lecturas, cuerpo estricto, IDs desconocidos). Navegador: `scripts/verify-profile-skills.mjs` (listado, lectura, editor y formulario abiertos y cancelados, sin peticiones de escritura).
