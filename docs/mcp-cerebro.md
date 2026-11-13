# MCP del cerebro

El cerebro de AgoraOne se ofrece como servidor MCP para que los perfiles de Hermes (por ejemplo, el bot
central de Telegram) y cualquier cliente MCP consulten la misma memoria que el asistente.

## Qué ofrece

Tres herramientas, todas de solo lectura:

| Herramienta | Qué hace |
|---|---|
| `buscar_en_cerebro(consulta, limite)` | Busca en las notas por palabras y por significado; devuelve título, carpeta, fragmento y su referencia (`source`, `ref`). |
| `leer_nota(source, ref, parte)` | Devuelve el texto de una nota encontrada, en partes de 8.000 caracteres (`part` de `parts`). |
| `estado_del_cerebro()` | Cuántas notas hay disponibles y si la búsqueda por significado está activa. |

## Qué no ofrece

- Nada `local_only` ni `private`: el servidor busca siempre como destinatario `external`.
- No escribe: abre la base del cerebro (`.agora/core/agora.db`) en modo solo lectura. Como lector de una
  base en modo WAL, SQLite puede crear `agora.db-wal` y `agora.db-shm` (0600) junto a ella.
- No necesita token ni que AgoraOne esté abierto: lee el archivo de la base, que solo puede leer tu usuario
  (permisos 0600). Para la búsqueda por significado usa ollama en este Mac; sin él, busca por palabras.
- El texto de las notas se entrega como datos: el aviso de no obedecer órdenes que aparezcan en una nota va
  en la descripción de cada herramienta y en cada resultado, porque Hermes no pasa al modelo las
  instrucciones generales del servidor.

## Conectarlo a un perfil de Hermes

AgoraOne no escribe en la configuración de Hermes: el usuario añade el servidor al perfil que quiera con el
propio Hermes (`--args` va al final; todo lo que le sigue son los argumentos del servidor):

```sh
hermes -p <perfil> mcp add agoraone-cerebro --command "$(which uv)" --args run --directory /ruta/a/agoraone/core --frozen --quiet python -m agora_core.brain_mcp
hermes -p <perfil> mcp test agoraone-cerebro
hermes -p <perfil> gateway restart
```

Usa exactamente el nombre `agoraone-cerebro`: con él, los chats de perfil dentro de AgoraOne tratan estas
tres herramientas como lectura y no piden «Permitir» (decisión del usuario, 13/11/2026). El primer
arranque de `uv` puede tardar más de lo normal; si `mcp test` agota el tiempo, repítelo. En una
conversación ya abierta, `/reload-mcp` recarga los servidores sin reiniciar.

Con una carpeta de datos distinta de la predeterminada, añade `--env AGORA_CORE_DATA=/ruta/absoluta`.

## Código

`core/agora_core/brain_mcp.py` (servidor) y `core/tests/test_brain_mcp.py`, que incluye una prueba de
extremo a extremo por stdio.
