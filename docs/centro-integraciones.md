# Centro de integraciones

El usuario prefiere un único edificio para todos los MCP, con terminales
interiores seleccionables y consulta de herramientas. Sustituye los siete
edificios exteriores de servicios; no cambia registros ni configuraciones Hermes.

## Recorrido
Centro de integraciones → Entrar → terminal MCP → elegir perfil → Herramientas.
El panel permite buscar por nombre/descripción y desplegar parámetros con tipo
y obligatoriedad. «Ver MCPs» ofrece acceso sin recorrer la sala. Terminales
paginadas de ocho en ocho para instalaciones mayores. Salida mediante puerta,
barra del interior o Vista ciudad. En móvil se cierra primero la ficha para
volver a los controles del interior.

## Fuente real
Se inspeccionó tools/mcp_schema_cache.py en Hermes instalado, commit 28aceb3451.
Se lee cache/mcp_schema_cache.json del perfil seleccionado, sin importar ni
ejecutar Hermes, MCP o herramientas. Nunca se usa la caché de otro perfil.
Para ejecutar una herramienta a mano, ver «Usar una herramienta» al final.

GET /api/hermes/profiles/:id/mcp/:serverId/tools exige el token local CSRF y
resuelve IDs contra el registro y configuración actuales. Eliminación de un
perfil/servidor revoca la consulta. No acepta rutas de archivos.

La huella se calcula como en Hermes: SHA-256 de JSON ordenado con escapes ASCII
de command, args, url, transport y filtros include/exclude; primeros 16 hex.
Se comparan huella y TTL antes de presentar el listado:
- cached: catálogo guardado compatible; no confirma conexión actual.
- expired: TTL caducado, solo referencia histórica.
- changed: configuración diferente; herramientas ocultas.
- missing: sin caché del servidor/perfil; no significa cero herramientas.
- unavailable: fichero no legible o formato no reconocido.

La API devuelve solo nombre, descripción redactada y nombres/tipos/requisitos de
parámetros. No expone esquemas completos, valores por defecto, comandos, env,
cabeceras ni credenciales. Límite de fichero 4 MiB, 500 herramientas y 100
parámetros por herramienta. Rechaza enlaces y archivos fuera del hogar Hermes.

En la instalación de desarrollo se verificaron cuatro servidores con caché
(61, 22, 9 y 2 herramientas históricas) en los perfiles que la tienen.
Los catálogos observados han caducado; no se muestran como disponibilidad actual.
No se inicia un servidor ni se ejecuta tools/list para rellenar cachés ausentes.

## Verificación
28 pruebas y build correctos. Nuevas pruebas: huella compatible con Python y
Unicode, aislamiento de caché por perfil, TTL/configuración modificada, campos
privados excluidos, protección HTTP y revocación al retirar el MCP.
Scripts: node scripts/verify-integrations.mjs y node scripts/verify-library.mjs.
Navegador del centro: entrada, clic de terminal 3D, 61 herramientas, búsqueda,
cambio a perfil sin caché, móvil y salida verificados; cero peticiones mutadoras.
Regresión de biblioteca correcta: interior, WASD, catálogo, búsqueda, lectura,
adjunto, salida y móvil. Aplicación de desarrollo reiniciada y disponible.
La etiqueta del personaje se mantiene inmóvil para facilitar selección mientras
el cuerpo conserva movimiento ambiental. Contraste de rótulos interiores mejorado.

## Pendiente
Estado y catálogo activos del gateway, actualización explícita de herramientas y
ejecución con permisos específicos. El centro actual es de consulta; no habilita
MCP en el chat. Mantener esta distinción al añadir actividad real al mundo.

## Usar una herramienta a mano (0.16.0)
Decisión del usuario (18/10/2026): desde la ficha de un MCP en el centro de integraciones se puede ejecutar una herramienta del catálogo guardado, con el perfil seleccionado.
- **Formulario**:
  - **Usar esta herramienta** abre un formulario generado a partir de su esquema: texto, números, sí o no, listas de opciones y JSON para listas y objetos.
  - Se comprueban los obligatorios y los formatos antes de enviar nada.
  - **Revisar antes de ejecutar** muestra el JSON exacto que se enviará y avisa de que se usarán las credenciales del perfil y de que puede cambiar cosas en el servicio. Solo **Ejecutar** lo lanza.
- **Ejecución** (`server/hermes_mcp_call.py`, un proceso por llamada en su propio grupo):
  - Retira del entorno las credenciales del perfil principal que carga Hermes al importarse y entra en el ámbito del perfil, así que solo usa su home y sus credenciales.
  - Arranca únicamente ese servidor con la maquinaria MCP de Hermes, llama a la herramienta (90 s como máximo) y apaga el servidor. Si algo se cuelga, a los 120 s se cierra todo el grupo y se avisa de que no se sabe si la acción llegó a completarse.
  - La confirmación en AgoraOne es la aprobación humana de esa llamada, así que la puerta de confianza de Hermes para servidores «no fiables» no vuelve a preguntar.
  - Solo se admiten herramientas que estén en el catálogo guardado de ese servidor y perfil, con los parámetros que declaran (y todos los obligatorios), y una llamada a la vez por servidor. Nombres y parámetros se validan con un patrón estricto en vez de enmascararse, para enviarlos tal cual.
  - Los servidores deshabilitados en Hermes no se pueden usar (409), y la ficha lo indica.
  - Durante la llamada, el servidor no puede pedir al modelo del perfil que escriba por él (*sampling*) ni hacer preguntas al usuario (*elicitation*): ambas se desactivan en memoria solo para esa llamada, así que no hay gasto ni datos enviados al proveedor del perfil.
  - Los fallos propios de Hermes (tiempo agotado con resultado incierto, servidor apartado tras varios fallos, sin conexión, inicio de sesión OAuth pendiente) se explican en castellano; solo los errores que devuelve el propio servicio se muestran marcados como tales.
  - Al conectar, Hermes puede actualizar en el home del perfil su catálogo de herramientas (`cache/mcp_schema_cache.json`), sus registros y, si el servidor usa OAuth, la renovación de su token, igual que cuando lo usa el bot.
- **Resultado**: hasta 50 000 caracteres, con las líneas que parecen claves ocultas. Los errores del propio servicio se muestran marcados como tales y pueden venir en inglés.
- **Verificación**:
  - `server/mcp-call.test.ts`: llamada real a través de Hermes con un perfil ficticio y un servidor MCP de eco local marcado como no fiable. Comprueba:
    - el resultado, con la clave oculta;
    - que el servidor no ve las credenciales del perfil principal;
    - el rechazo de herramientas fuera del catálogo, servidores desconocidos o deshabilitados, y parámetros que faltan o sobran;
    - que no quedan procesos.
  - `server/app.test.ts`: CSRF y cuerpo estricto.
  - `scripts/verify-mcp-call.mjs`: navegador con el catálogo y la llamada interceptados, sin conectar con ningún servicio.
