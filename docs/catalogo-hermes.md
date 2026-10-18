# Ciudad derivada de Hermes

## Uso
Al abrir AgoraOne, el backend detecta los datos locales de Hermes. La ciudad se genera con los perfiles y espacios registrados, sin llamadas a modelos. El directorio **Tu Hermes** muestra la hora de lectura y los avisos de compatibilidad; se actualiza cada 30 segundos mientras la pestaña está visible.

Seleccionar un perfil abre su descripción, relación con el bot de Desktop, canales declarados y archivos SOUL.md, MEMORY.md y USER.md. Estos últimos se muestran en desplegables como texto, con sus tamaños. Abrir la ficha no inicia inferencia ni transmite esos archivos al proveedor. Enviarlos como contexto requiere enviar un mensaje desde la pestaña de conversación. Los documentos ausentes o no legibles se indican explícitamente.

Luma/Biblioteca se conserva como función propia de AgoraOne. Pixel, Miso, Byte y Nexo dejan de aparecer como si fueran agentes existentes. El chat de Luma mantiene su identidad aislada. Ahora cada perfil ofrece **Conversar con <nombre>**, en una sesión propia de AgoraOne con SOUL/memoria de lectura y sin herramientas. Ver docs/conversaciones-perfiles.md.

## Relaciones
| Elemento visual | Entidad | Fuente |
| --- | --- | --- |
| Edificio de perfil | Perfil persistente | Raíz Hermes o profiles/<nombre> |
| Personaje del perfil | Representación de su identidad, con ID separado | SOUL.md y metadatos de perfil |
| Bot en la ficha | Vista de ese perfil en el modo Bots local de Desktop | Contrato instalado de profiles.list; ui_meta.hermes-bots cuando existe |
| Edificio de espacio | Proyecto, repositorio o carpeta registrada en sesiones | projects.db o columna cwd de state.db |
| Relación espacio/perfiles | Perfiles que registran la misma carpeta | Metadatos de ambas bases |

Un personaje no implica una ejecución activa. Un bot no se crea por encontrar una memoria. Las sesiones no se convierten en agentes. Los IDs de perfil, identidad, bot y espacio son distintos; se derivan de la instalación y la entidad para evitar colisiones. No se envían rutas completas al navegador.

Las carpetas de sesiones pueden ser históricas, temporales o pertenecer a contenedores. Se presentan como **espacios registrados**, sin afirmar que existen actualmente o tienen un agente trabajando. No se recorren esas carpetas ni se leen sus archivos. Si hay un proyecto declarado para la misma carpeta, su nombre y categoría tienen prioridad.

## Detección y portabilidad
`server/hermes-location.ts` resuelve el directorio de datos en este orden:
1. AGORA_HERMES_HOME, si se configura explícitamente.
2. HERMES_HOME; si apunta a profiles/<nombre>, se obtiene su raíz.
3. ~/.hermes del usuario que ejecuta el backend.

Código: AGORA_HERMES_PATH, <raíz>/hermes-agent o ~/.hermes/hermes-agent. Python: AGORA_HERMES_PYTHON o venv/bin/python de la instalación. `.env.example` ya no contiene una ruta de usuario fija. Una instalación arbitraria no anunciada mediante estas convenciones requiere indicar su ubicación; no se escanea todo el disco.

La lectura reconoce estructuras y columnas disponibles; no importa módulos de Hermes ni ejecuta inicializadores/migraciones. Obtiene la versión desde pyproject.toml cuando está disponible. Un esquema desconocido genera un aviso y no se interpreta como si fuera el conocido. Compatibilidad comprobada con v0.21.4 y fixtures de instalaciones alternativas; **no se afirma compatibilidad universal con toda versión o distribución**.

La detección de lectura es independiente de ejecutar modelos: el adaptador AIAgent conserva el bloqueo al commit previamente verificado. Otras versiones necesitan verificar ese contrato antes de habilitar ejecución. No se alteran las credenciales ni el perfil activo.

## Evidencias del código instalado
Inspección en ~/.hermes/hermes-agent, commit 28aceb3451:
- hermes_constants.py: raíz, gramática de nombres, marcadores de identidad y tombstones profiles/.deleted/<nombre>.
- hermes_cli/profiles.py: perfil default, perfiles vivos, profile.yaml, display_name, description y ui_meta.hermes-bots.title.
- apps/desktop/src/plugins/hermes-bots/data.ts y types.ts: roster basado en perfiles, metadatos del bot y fuentes locales/remotas separadas.
- tools/memory_tool.py: memorias por perfil en memories/MEMORY.md y memories/USER.md.
- hermes_cli/projects_db.py: projects, discovered_repos y sus columnas.
- hermes_state_common.py: metadatos cwd de sessions.

En la instalación de desarrollo se encontraron cinco perfiles (el principal y otros cuatro). projects.db no contiene proyectos declarados. Corrección del 17/10: ya no se convierten cwd históricos de state.db en edificios; eran doce carpetas, incluidas temporales y de pruebas. Solo se muestran espacios de projects.db. Tener el código de Desktop instalado tampoco acredita que cada perfil tenga un bot: se requieren metadatos explícitos.

El usuario confirmó que los cinco perfiles son correctos: las entradas desconocidas eran espacios con nombres raros. Se comprobó en lectura el registro de Desktop: conexión primaria y última local, con un perfil guardado. No se borró ni modificó ningún perfil. La interfaz advierte que el listado proviene del disco y no de un roster activo verificado.

## Límites y protección
- El catálogo es de solo lectura: sin cambios de configuración, modelos, bots o mensajes. La única escritura en perfiles es la edición explícita de SOUL, MEMORY y USER desde la ficha (docs/edicion-perfiles.md).
- No se leen .env, auth.json ni almacenes de secretos; solo se comprueba la existencia de marcadores. config.yaml se analiza en backend, proyectando únicamente nombres de plataformas y enabled. No se devuelve su contenido.
- Lectura acotada de Markdown: 64 KiB por archivo; YAML: 512 KiB. Symlinks/hardlinks y formatos no reconocidos se rechazan. Los perfiles borrados se excluyen y se revalidan al abrir la ficha.
- Campos de salida permitidos explícitamente. En SOUL, MEMORY y USER se oculta entera cada línea que parece una clave (`server/secret-lines.ts`): asignaciones con palabras que solo nombran credenciales (`password`, `api_key`, `contraseña`, `secret_access_key`… también entre comillas o en negrita), palabras comunes como «clave» o «token» solo si su valor es una cadena opaca con dígitos o símbolos (así «Valores clave: honestidad» sigue visible), usuario y contraseña dentro de una URL, cabeceras Bearer, prefijos conocidos (`sk-`, `ghp_`, `AKIA`…), bloques PEM, el valor escrito en la línea siguiente a una clave sin valor y cadenas opacas de 32 o más caracteres fuera de enlaces (los UUID, los slugs con guiones y los nombres snake_case quedan visibles). La descripción del perfil derivada de SOUL se obtiene después de quitar esas líneas. Cada una se sustituye por «[línea oculta N]». La ficha ofrece «Mostrar», que pide el texto original con `?reveal=1` (ruta protegida por CSRF); el modelo recibe siempre la versión oculta. Es una precaución, no un detector infalible de secretos escritos en prosa.
- SQLite usa readOnly, query_only, trusted_schema desactivado y extensiones deshabilitadas. Solo SELECT/PRAGMA de esquema; sin migraciones ni importación de conversaciones. Puede usar los mecanismos compartidos de lectura WAL de SQLite.
- Hasta 100 perfiles, 200 filas por consulta y 300 espacios; caché de catálogo 20 segundos. Los límites globales se anuncian; listados extensos pueden ser parciales.
- GET /api/hermes/catalog y /api/hermes/profiles/:id exigen el token local además de Host/Origin. No existen rutas de edición del catálogo.
- El catálogo representa la instalación del usuario de macOS y es visible para los navegadores locales autorizados de AgoraOne. No es un servicio multiusuario ni hereda permisos de ejecución.
- No descubre gateways remotos, preferencias privadas del renderer de Desktop, memoria de plugins remotos ni bots de mensajería definidos exclusivamente mediante variables de entorno. Los canales configurados no se presentan como conexiones activas.

## Verificación y continuidad
`npm test`, `npm run build` y `node scripts/verify-hermes-catalog.mjs`. El script abre el catálogo real, fichas y SOUL, y simula solo la respuesta de refresco dentro del navegador de prueba para verificar actualización sin modificar Hermes. Cero llamadas a modelos.

Conversación aislada ya disponible: docs/conversaciones-perfiles.md. Quedan pendientes herramientas específicas y edición de memoria con controles explícitos. No reutilizar automáticamente las herramientas amplias del perfil original.
