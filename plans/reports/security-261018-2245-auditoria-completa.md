# Auditoría de seguridad · AgoraOne 0.17.0 → 0.18.0

**Fecha:** 18/10/2026 · **Alcance:** todo el proyecto, con el servidor Express (`server/`), los puentes Python con Hermes (`server/*.py`) y el frontend (`src/`).

**Modo:** auditoría completa en cuatro pasos:
1. Comprobaciones rápidas de archivos de entorno, secretos, dependencias y patrones de código.
2. Análisis STRIDE + OWASP de la capa web, a cargo de un revisor con el modelo Opus.
3. El mismo análisis de la integración con Hermes, a cargo de un revisor con el modelo Sonnet. Incluye pruebas reales con perfiles ficticios, un modelo falso y un servidor MCP de eco.
4. Corrección de los hallazgos en la rama `fix/auditoria-seguridad`.

**Límites:** no se leyeron archivos de entorno, perfiles reales ni el vault del usuario, y no se ejecutó nada contra servicios reales. No es una prueba de intrusión externa.

## Resumen

| Categoría | Crítico | Alto | Medio | Bajo | Info |
|---|---|---|---|---|---|
| Secretos | 0 | 0 | 0 | 0 | 1 |
| Dependencias | 0 | 0 | 3 (no alcanzables) | 0 | 0 |
| Código y web | 0 | 1 | 3 | 4 | 5 |
| Integración con Hermes | 0 | 1 | 3 | 5 | 6 |

## Comprobaciones rápidas
- **Archivos de entorno:** solo está en git la plantilla `.env.example`. `.env`, `.env.*` y `.agora/` están en `.gitignore`.
- **Secretos:** ninguno real. Las dos coincidencias son claves inventadas a propósito en pruebas (`server/hermes-agent-bridge.test.ts` y `server/secret-lines.test.ts`). (Info)
- **Dependencias:**
  - `npm audit` da 3 avisos moderados de la misma cadena, `mammoth → argparse → sprintf-js` (denegación de servicio con especificadores de precisión).
  - `argparse` solo lo usa la línea de órdenes de `mammoth`, y AgoraOne la usa como librería, así que el código vulnerable no es alcanzable.
  - El arreglo propuesto, bajar `mammoth` a 0.3.29, es incompatible. Se acepta y se vigila.
- **Patrones peligrosos:** no hay `eval`, `new Function`, `innerHTML`, `dangerouslySetInnerHTML`, `shell=True` ni deserialización insegura. Todos los procesos hijos se lanzan con argumentos fijos y reciben los datos por stdin.

## Hallazgos y estado

| # | Sev. | Categoría | Dónde | Hallazgo | Estado |
|---|---|---|---|---|---|
| W1 | Alto* | S/E · A01/A07 | `server/app.ts` | Sin autenticación ante procesos locales. Otro usuario del Mac, una app aislada o un contenedor (`host.docker.internal`) podía falsificar Host y Origin, obtener el token CSRF y usar la API con las credenciales del usuario. | **Corregido.** Token de acceso persistente (`.agora/access-token`, 0600). El navegador lo canjea una vez por la cookie `agora_access` (HttpOnly, SameSite=Strict, con un resumen del token y no el token) y toda la API la exige, incluida `/api/status`. Se entra con el enlace que muestra `npm run dev` o con `npm run open`. |
| W2 | Medio | T · A05 | toda la app | Clickjacking: otra web podía incrustar AgoraOne en un marco. | **Corregido.** `X-Frame-Options: DENY` y `Content-Security-Policy: frame-ancestors 'none'` en Express y en Vite. |
| W3 | Medio | D | `server/secret-lines.ts` | ReDoS cuadrático en el patrón `usuario:contraseña@` (3,8 s con 128 K caracteres) que bloqueaba el servidor. | **Corregido.** Repeticiones acotadas, con todos los casos hostiles por debajo de 15 ms. Hay una prueba de rendimiento permanente. |
| W4 / H1 | Alto | I · A01 | `server/hermes_agent_bridge.py` | `read_file` y `search_files` sin permiso podían leer credenciales de otros perfiles y del usuario (claves SSH, tokens), con riesgo de inyección de prompts. | **Corregido.** Se bloquea sin tarjeta todo lo de otros perfiles, los datos privados de AgoraOne (`.agora`) y las búsquedas que abarcarían esas zonas. Se pide «Permitir» para credenciales del usuario (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `.netrc`, `.docker`, `.kube`, Keychains, `.env*`, `*.pem`, `*.key`, `id_*`, `auth.json`). El puente trabaja desde el home del propio perfil. Hay pruebas reales de ambos casos. |
| W5 | Bajo | S | `server/app.ts` | La identidad de navegador (`agora_user`) es común entre puertos y el límite de turnos es global. | Aceptado: es una app de un solo usuario y la cookie de acceso protege ahora toda la API. |
| W6 | Bajo | I | `mcp-call.ts`, `hermes-manage.ts` | El texto de error del servicio se devolvía sin enmascarar. | **Corregido.** Ahora pasa por `maskSecrets`. |
| W7 | Bajo | E | `server/document-extraction.ts` | El extractor de PDF/DOCX podía leer cualquier archivo si pdf.js o mammoth tuvieran un fallo. | **Corregido.** Usa el modelo de permisos de Node: solo lee su propio código y sus librerías, sin escritura, procesos hijos ni workers. |
| W8 | Bajo | I | `server/app.ts` | Mensajes de error internos, posiblemente con rutas, llegaban al usuario. | **Corregido.** Solo se muestran los mensajes escritos para el usuario. |
| H2 | Medio | T/E | puente del chat | Una recarga forzada de plugins de Hermes podía retirar el gancho de aprobación. | **Corregido.** Se reinstala en cada turno y tras cualquier `discover_and_load`. |
| H3 | Medio | D | puente del chat | «Detener» se perdía si llegaba durante el arranque en frío. | **Corregido.** El estado se reinicia al aceptar el turno y se comprueba antes de crear el agente. |
| H4 | Medio | S/T | tarjeta de aprobación | Al ocultar fragmentos con aspecto de clave, o al recortar, podía esconderse el verbo de una orden. | **Corregido.** En `terminal`, `execute_code`, MCP y órdenes peligrosas, «Permitir» queda desactivado si algo está oculto o recortado. Los caracteres invisibles y de dirección se muestran como `<U+XXXX>`. |
| H5 | Bajo-Medio | I | puente del chat | Un proveedor de memoria externo del perfil recibe cada turno. | Aceptado por decisión del usuario («memoria como en Telegram»). Está documentado. |
| H6 | Bajo | T | puente del chat | Trabajo persistente que el bot podía dejar: `kanban_create`, `kanban_link`, `nohup`, `setsid`, `disown` y `&` al final. | **Corregido.** Se bloquea igual que las tareas programadas. |
| H7 | Bajo | S | puente del chat | Las peticiones propias de Hermes salían etiquetadas como «terminal». | **Corregido.** Ahora se etiquetan «pregunta de un servidor MCP» u «orden de terminal peligrosa». |
| H8 | Bajo | I | puente del chat | Sampling MCP activo en el chat, de modo que un servidor podía pedir textos al modelo del perfil. | **Corregido.** Se desactiva en memoria para todos los servidores del chat. |
| H9 | Bajo | T | puente del chat | El aviso «datos reescribibles» se calculaba una sola vez y no contaba el middleware. | **Corregido.** Se calcula por llamada e incluye el middleware. |
| H10 | Bajo | T | los 4 puentes | La verificación de versión de Hermes usaba un prefijo de 10 caracteres. | **Corregido.** Ahora exige el commit completo y ningún cambio local en archivos rastreados. |
| H11 | Info | varios | — | Ruta del puente relativa al cwd; `ha_*` en la lista de solo lectura; respuestas del bot guardadas sin enmascarar. | **Corregido.** La ruta va con `import.meta.url`, `ha_*` pasa a pedir permiso y las respuestas se guardan enmascaradas. |
| I1–I5 | Info | — | — | CSP completa como defensa en profundidad; tareas que corren solas (decisión del usuario); `Object.hasOwn` en parámetros MCP (**corregido**); la búsqueda revela si existe un secreto (requiere acceso); ventana mínima al guardar notas (requiere escritura en el vault). | Pendientes de bajo riesgo o aceptados. |

\* El W1 era Alto si había otros usuarios, apps aisladas o contenedores en el equipo, y Medio en un Mac de un solo usuario sin contenedores.

## Lo que se verificó y resistió
- **CSRF, DNS rebinding y CORS:** lista de Host permitidos, Origin, cabecera CSRF y ninguna cabecera CORS.
- **XSS:** el lector Markdown solo construye elementos React, `safeHref`, widgets con `textContent` y expresiones acotadas.
- **Path traversal y enlaces:** identificadores opacos, `realpath`, `O_NOFOLLOW`, `nlink === 1` y comparación de inodo.
- **Puerta «Permitir»:**
  - resistió escritura, `delegate_task`, `execute_code` (incluida su llamada interna a `terminal`), herramientas en paralelo, MCP, alias y fallos del gancho;
  - anula `approvals.mode: off` y YOLO;
  - no guarda permisos;
  - el codex runtime se rechaza.
- **Aislamiento de credenciales:** el entorno queda limpio de las del perfil principal, con prueba que falla sin la protección.
- **Extracción de documentos:** límites de tamaño, ZIP, páginas, tiempo y memoria.

## Verificación tras los arreglos
- **Pruebas:** `npm test` pasa 71 de 71. Incluye pruebas nuevas de acceso sin enlace, enlace incorrecto, falta de Origin y cookie sin el token; clickjacking; ReDoS; lectura bloqueada de otro perfil; lectura de credenciales con «Permitir».
- **Build:** `npm run build` correcto.
- **Navegador:** las verificaciones abren AgoraOne con el enlace de acceso (`appUrl()` en `scripts/verify-targets.mjs`). Los resultados están en el informe de la versión.

## Pendiente o recomendado
- CSP completa (`default-src 'self'` …), probándola con los workers de three/drei.
- Vigilar `mammoth` por si publica una versión sin `argparse` vulnerable.
- Registro propio de aprobaciones y ediciones (repudio): hoy solo hay copias de seguridad y nombres de herramientas.
