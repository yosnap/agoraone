# Política de seguridad

AgoraOne accede a datos sensibles: la memoria de tus agentes, tus notas y las credenciales de los perfiles de Hermes. Nos tomamos en serio cualquier fallo de seguridad.

## Versiones con soporte

Solo se mantiene la rama `main`. Las correcciones de seguridad se publican allí.

## Cómo informar de una vulnerabilidad

**No abras un issue público.** Usa un [aviso de seguridad privado en GitHub](https://github.com/yosnap/agoraone/security/advisories/new) e incluye:

- Una descripción del problema y de su impacto.
- Los pasos para reproducirlo o una prueba de concepto.
- La versión o el commit afectado.

Responderemos lo antes posible. Te iremos informando del avance y te reconoceremos la aportación al publicar la corrección, si así lo quieres.

## Modelo de amenaza

Qué protege AgoraOne:

- Que otra aplicación, usuario o contenedor del mismo equipo use la API sin el token de acceso.
- Que una página web externa llame a la API o incruste AgoraOne en un marco.
- Que las credenciales lleguen al navegador o al modelo.
- Que se lea o se escriba fuera de las carpetas permitidas mediante rutas manipuladas.
- Que el agente ejecute acciones con efectos sin tu aprobación explícita.

Qué queda fuera:

- Un atacante que ya controla tu usuario del sistema.
- La seguridad de Hermes, de los servidores MCP o de los proveedores de modelos.
- Exponer AgoraOne fuera de `127.0.0.1`, cosa que el proyecto no admite.
