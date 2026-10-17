# AgoraOne

Tu instalación local de [Hermes](https://github.com/NousResearch/hermes-agent) convertida en una ciudad 3D navegable. Cada perfil de Hermes es un edificio con su propio espacio interior; sus servidores MCP, vaults de Obsidian y la actividad real del gateway aparecen en la ciudad. Incluye una biblioteca con documentos propios que puedes consultar con Luma.

Todo se ejecuta en tu ordenador: el servidor escucha solo en `127.0.0.1`, las credenciales se quedan en el backend y la ciudad se lee de `~/.hermes` en solo lectura. Nada modifica tu instalación ni tus perfiles de Hermes.

## Qué muestra
- **Ciudad** generada a partir de los perfiles detectados, con ciclo de día y noche según la hora real.
- **Espacio de cada perfil**: identidad (SOUL.md), memoria (MEMORY.md y USER.md), servidores MCP declarados, tareas programadas y tablero kanban.
- **Actividad real**: estado del gateway, conexiones por perfil y actividad registrada, leídos de los propios registros de Hermes sin contenido de mensajes.
- **Conversación** con Luma o con la identidad de un perfil, siempre por envío explícito y sin herramientas.
- **Biblioteca**: importación de TXT, Markdown, PDF y DOCX como copias privadas.

Los paseos y peatones son ambientales y no representan tareas reales.

## Requisitos
- macOS o Linux, Node.js 22.12 o superior.
- Hermes instalado en `~/.hermes` (o rutas indicadas con `AGORA_HERMES_HOME` y `AGORA_HERMES_PATH`).
- Un proveedor de inferencia compatible con OpenAI para conversar.

## Uso
Copia `.env.example` como `.env` y completa `AGORA_MODEL`, `AGORA_BASE_URL` y `AGORA_API_KEY`. Después:

```sh
npm ci
npm run dev
```

Abre http://127.0.0.1:5173. Más detalle en [docs/arranque.md](docs/arranque.md); arquitectura en [docs/arquitectura.md](docs/arquitectura.md).

## Pruebas
```sh
npm test
npm run build
```

## Licencia
Código bajo licencia [MIT](LICENSE). Los recursos visuales de `public/world` son CC0 (Poly Haven y Quaternius); procedencia en [docs/recursos-visuales.md](docs/recursos-visuales.md).
