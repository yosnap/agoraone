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
