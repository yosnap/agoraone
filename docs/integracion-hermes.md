# Integración verificada — 17/10/2026

## Fuente de verdad
Código local `~/.hermes/hermes-agent`, HEAD `d1b46d718ffe675427928eff7e5fff69bcb4519b` (14/11/2026; el usuario actualizó Hermes el 15/11/2026 desde la del 23/09, `28aceb3451`). No se ejecutó ninguna actualización ni se modificó la instalación desde AgoraOne.

**Desde noviembre de 2026 Hermes gestiona su propio Python** (3.14, en `~/.hermes/tools`, registrado en `tools/facts.json`) y elige sus dependencias al arrancar con `hermes_bootstrap`, que importa todo punto de entrada (`run_agent` incluido). El antiguo `venv/bin/python` queda sin uso. AgoraOne (`desktop/server/src/hermes/location.rs` y los cuatro puentes de `desktop/server/python`):
- usa ese Python cuando la instalación trae `hermes_bootstrap.py` (si no, el entorno virtual de antes; `AGORA_HERMES_PYTHON` lo fuerza);
- importa `hermes_bootstrap` antes que nada de Hermes, con la raíz de datos dueña de la instalación (`pm.environments.owning_home_root`) para que elija las dependencias ya instaladas;
- fija `HERMES_DISABLE_LAZY_INSTALLS=1`, el interruptor del propio Hermes para que su arranque no instale paquetes, no termine una actualización a medias ni relance el proceso. Si Hermes tiene una actualización sin terminar, se termina abriendo Hermes o con `hermes update`, nunca desde AgoraOne.

Comprobado: las firmas de las 47 funciones y clases de Hermes que usan los puentes (solo cambios compatibles: parámetros opcionales nuevos), y las pruebas de los puentes contra el Hermes instalado con un modelo falso (chat con herramientas y confirmación, tareas y kanban, MCP a mano).

Usuario confirma arranque mediante Hermes Desktop y proveedor privado OpenAI compatible, modelo elegido por el usuario. Configuración inspeccionada selectivamente: proveedor y modelo disponibles. AgoraOne selecciona su modelo sin cambiar el predeterminado de Hermes. No se imprimieron valores de claves ni contenidos completos de archivos secretos.

## Interfaces reales
| Interfaz | Evidencia instalada | Decisión |
| --- | --- | --- |
| API gateway HTTP | `gateway/platforms/api_server.py`: tabla `_CAPABILITY_ENDPOINTS`, `/v1/chat/completions`, `/v1/responses`, `/api/sessions`, `/v1/runs` | Existe, pero no se arrancó ni se alteró el gateway |
| Continuidad HTTP | `api_server_openai_routes.py` usa `X-Hermes-Session-Id` y requiere `API_SERVER_KEY` para continuidad | No inventar compatibilidad de sesiones con OpenAI estándar |
| Herramientas HTTP | `api_server.py` construye agente con `_get_platform_tools(config, "api_server")` | No asumir que enviar `tools: []` desactiva herramientas del perfil |
| API Python | `run_agent.py` documenta `AIAgent`; constructor delega a `agent/agent_init.py` | Elegida para el hito 1 |
| Historial Python | `agent/turn_facade.py::run_conversation(conversation_history=...)` | Backend conserva historial y proporciona ID separado |
| Cero herramientas | `model_tools.py::_select_tool_names`: `[]` no equivale a `None` | `enabled_toolsets=[]`, comprobar superficie efectiva vacía |
| Rechazo de llamadas | `agent/turn_tool_round.py` filtra llamadas fuera de `valid_tool_names` | El control no depende del prompt |

En la inspección inicial no había listener TCP en 8642. Esto no prueba que Desktop no use otro transporte/puerto. No se investigaron ni reutilizaron sesiones de Desktop.

## Adaptador elegido
Express ejecuta el Python instalado de Hermes, con script propio `desktop/server/python/hermes_bridge.py`, por stdin/stdout JSON. Un proceso por turno. Importa y ejecuta el agente real; no llama directamente al SDK OpenAI en lugar de Hermes.

- Solo recibe modelo, URL y credencial seleccionados del backend.
- Entorno hijo construido desde lista explícita; `HOME` y `HERMES_HOME` apuntan a `.agora/hermes`.
- `PYTHONDONTWRITEBYTECODE=1` evita escribir bytecode en la instalación.
- `run_agent.py` carga por defecto `.env` del repositorio. El adaptador limita el cargador **en memoria del proceso hijo** al home aislado, sin editar Hermes.
- Sin memoria personal, archivos de contexto, identidad SOUL del usuario, revisiones de fondo ni herramientas. Hermes puede crear su propio estado/logs dentro de `.agora/hermes`.
- Se comprueba el commit y la superficie efectiva de herramientas; una revisión distinta se rechaza hasta auditar compatibilidad.
- El código Python instalado se considera confiable. Esto es aislamiento de configuración y capacidades, no un sandbox del sistema operativo. No habilitar terminal/MCP para el siguiente hito.
- Timeout externo 120 s, máximo dos ejecuciones simultáneas y un turno por conversación.
- No se propagan logs ni excepciones crudas al navegador.

## Credenciales
`scripts/configure-provider.py <proveedor> <modelo>` importa únicamente URL, nombre de modelo y clave de inferencia a `.env` del proyecto con permisos 0600. No copia perfiles, memoria ni conversaciones. No sobrescribe `.env` existente. Credenciales excluidas del control de versiones y del frontend. Si rota la clave, actualizar exclusivamente esa configuración local.

## Limitaciones
API Python interna fijada a este commit; no se afirma estabilidad entre versiones. No streaming, bots, perfiles Desktop, herramientas ni WebXR. La biblioteca de prueba añade contexto documental validado por el backend, conservando cero herramientas en Hermes (docs/biblioteca.md). Conversaciones aisladas por identidad local de navegador, agente lógico, contexto e ID; no es autenticación multiusuario de producción. Ante un timeout no reintentar automáticamente: el proveedor podría haber procesado la petición.
