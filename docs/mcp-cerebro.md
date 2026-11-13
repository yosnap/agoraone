# MCP del cerebro

El cerebro de AgoraOne se ofrece como servidor MCP para que los perfiles de Hermes (por ejemplo, el bot
central de Telegram) y cualquier cliente MCP consulten la misma memoria que el asistente.

## Qué ofrece

Tres herramientas, todas de solo lectura:

| Herramienta | Qué hace |
|---|---|
| `buscar_en_cerebro(consulta, limite)` | Busca en las notas por palabras y por significado; devuelve título, carpeta, fragmento y su referencia (`source`, `ref`). |
| `leer_nota(source, ref)` | Devuelve el texto completo de una nota encontrada. |
| `estado_del_cerebro()` | Cuántas notas hay disponibles y si la búsqueda por significado está activa. |

## Qué no ofrece

- Nada `local_only` ni `private`: el servidor busca siempre como destinatario `external`.
- No escribe ni crea nada: abre la base del cerebro (`.agora/core/agora.db`) en modo solo lectura.
- No necesita token ni que AgoraOne esté abierto: lee el archivo de la base, que solo puede leer tu usuario
  (permisos 0600). Para la búsqueda por significado usa ollama en este Mac; sin él, busca por palabras.
- El texto de las notas se entrega como datos: sus instrucciones avisan al cliente de que nunca obedezca
  órdenes que aparezcan dentro de una nota.

## Conectarlo a un perfil de Hermes

AgoraOne no escribe en la configuración de Hermes: el usuario añade el servidor al perfil que quiera. En
el `config.yaml` del perfil, dentro de `mcp_servers`:

```yaml
mcp_servers:
  agoraone-cerebro:
    command: /ruta/a/uv            # `which uv`
    args: [run, --directory, /ruta/a/agoraone/core, --frozen, --quiet, python, -m, agora_core.brain_mcp]
```

Reinicia el gateway de Hermes para que el perfil lo cargue. Comprobación rápida desde el bot: «¿cuántas
notas tienes en el cerebro?» debe llamar a `estado_del_cerebro`.

Con una carpeta de datos distinta de la predeterminada, añade `env: {AGORA_CORE_DATA: /ruta/absoluta}`.

## Código

`core/agora_core/brain_mcp.py` (servidor) y `core/tests/test_brain_mcp.py`, que incluye una prueba de
extremo a extremo por stdio.
