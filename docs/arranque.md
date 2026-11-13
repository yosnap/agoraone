# Arranque reproducible

Requisitos: macOS, Node >=22.12 (verificado 22.23.1), npm, [uv](https://docs.astral.sh/uv/) (instala por sí mismo Python 3.13 para el núcleo), Hermes en el commit documentado y su entorno Python. No instalar paquetes ni actualizar Hermes.

Desde esta carpeta:

```sh
npm ci
(cd core && uv sync --frozen)
npm run check:hermes
npm run dev
```

Para la búsqueda por significado hace falta [ollama](https://ollama.com) con el modelo de embeddings (`ollama pull qwen3-embedding:0.6b`); sin él, el cerebro busca solo por palabras.

`npm run dev` y `npm start` arrancan también el núcleo Python en 127.0.0.1:4318 y lo detienen al salir; si el backend muere de golpe, el núcleo termina solo en unos segundos. El puerto es fijo: si está ocupado, el núcleo lo dice y no arranca, y `/api/core/*` responde 503 mientras el resto de AgoraOne funciona igual. Para comprobar quién lo ocupa: `lsof -iTCP:4318 -sTCP:LISTEN`. Pruebas del núcleo: `npm run test:core`. A los pocos segundos de arrancar, el backend indexa las notas de tus vaults de Obsidian en el núcleo y repite cada 5 minutos; para que una nota no salga nunca hacia modelos externos, añade en sus propiedades `confidencialidad: solo-local` (o `privado` para que tampoco salga por Telegram ni MCP).

Abrir el enlace de acceso que muestra la terminal (`http://127.0.0.1:5173/#acceso=…`) o ejecutar `npm run open` (usar esta dirección, no otra interfaz de red). El navegador canjea el token por una cookie y lo borra de la barra de direcciones; las siguientes veces basta con http://127.0.0.1:5173. Sin esa cookie la API responde 401 y la página explica cómo entrar. Seleccionar Luma o Biblioteca, escribir y pulsar **Enviar a Hermes**. Configuración actual guardada en `.env` privado. `check:hermes` instancia el agente y comprueba cero herramientas sin pedir inferencia; no confirma la conexión al proveedor.

La ciudad detecta además los perfiles y espacios de tu Hermes y actualiza el catálogo automáticamente cada 30 s. Seleccionar un perfil permite leer su identidad/memoria; **Conversar con <nombre> → escribir → Enviar a Hermes** inicia una conversación aislada con esa identidad. El envío transmite SOUL/MEMORY/USER al proveedor de AgoraOne, sin herramientas ni escritura en memoria original; detalles en docs/conversaciones-perfiles.md. Luma sigue siendo la biblioteca de AgoraOne. Para datos en ubicación no estándar, definir AGORA_HERMES_HOME en el backend; para código/intérprete distintos, AGORA_HERMES_PATH/AGORA_HERMES_PYTHON. Ver docs/catalogo-hermes.md.

Para el segundo hito: **Luma → Entrar en la biblioteca → Abrir catálogo → documento → Consultar este documento con Luma**. También se puede abrir la pestaña Documentos desde la ciudad. El catálogo incluye ejemplos y las copias que hayas importado; detalles en docs/biblioteca.md.

Para añadir archivos propios: **Luma → Documentos → Añadir documento**. TXT/Markdown UTF-8 de hasta 24 KiB o PDF/DOCX de hasta 5 MiB (texto extraído: máximo 24 KiB; PDF: 100 páginas). Se guarda una copia privada del texto, sin OCR ni maquetación. Después usar **Consultar este documento con Luma**. Ver docs/importacion.md.

Para gestionar una copia, abrirla en Documentos y usar **Renombrar** o **Eliminar copia** debajo del texto. El borrado requiere confirmación y no afecta al archivo original ni a conversaciones anteriores.

En otra máquina, copiar `.env.example` a `.env` y completar AGORA_MODEL, AGORA_BASE_URL y AGORA_API_KEY mediante editor local. Nunca pegar claves en el chat ni usar variables VITE_. Ajustar las dos rutas de Hermes si procede. Para esta configuración concreta existe el importador selectivo opcional:

```sh
~/.hermes/hermes-agent/venv/bin/python server/configure-provider.py <proveedor> <modelo>
```

Se niega a sobrescribir un `.env` existente. No modifica la configuración de Hermes. Proteger `.env` con permisos 0600. Reiniciar el backend tras cambiarlo.

## Build local
```sh
npm test
npm run build
npm start
```

Abrir http://127.0.0.1:4317. `npm start` sirve `dist` y la API desde el mismo puerto. No ejecutar a la vez dos backends en 4317. Ctrl+C detiene el arranque de desarrollo.

## Verificación de navegador
Requiere Chromium de Playwright (`npx playwright install chromium` si falta). Con build generado y backend arrancado:

```sh
node scripts/verify-browser.mjs
# Opcional: dos peticiones reales con coste de inferencia
node scripts/verify-browser.mjs --live
```

La comprobación normal no llama a modelos. La variante live verifica dos turnos, continuidad, recarga, selección, primera persona y móvil. Capturas locales en `.agora/`.

## Controles
- Vista ciudad: arrastrar para orbitar, rueda para zoom, seleccionar personaje o directorio.
- Primera persona: al activar el modo el teclado ya mueve la escena. Flechas arriba y abajo para avanzar y retroceder, izquierda y derecha para girar; W, A, S y D para caminar y moverse de lado. «Entrar al recorrido» captura el ratón para mirar; Esc lo libera. Abrir un espacio también libera el cursor. En la ciudad, un minimapa abajo a la derecha muestra tu posición y hacia dónde miras (norte arriba); pulsar un edificio del minimapa abre su ficha.
- Si el navegador rechaza la captura del ratón, se muestra la alternativa: WASD con el lienzo enfocado y arrastrar para mirar. Pulsa de nuevo Entrar al recorrido para enfocar el lienzo.
- Nueva: comienza otra conversación, sin borrar la anterior del servidor.
- Los perfiles y espacios se obtienen del catálogo Hermes; los personajes ficticios adicionales del prototipo ya no se muestran.

## Copias de seguridad del núcleo
La base de datos del núcleo (`.agora/core/agora.db`) se copia cifrada en `.agora/core/backups`: una vez al día (al arrancar si la última tiene más de 24 h, y comprobando cada hora) y antes de cada cambio de estructura. Se conservan una diaria por cada uno de los últimos 14 días, una por semana durante 8 semanas, las 10 últimas copias manuales y las 5 últimas previas a una migración. Una copia con fecha futura (reloj atrasado) no se borra. Límite: la base no puede superar 2 GiB comprimida; si se acerca, la copia falla con un aviso.

La clave de cifrado se crea con la primera copia y vive en el Llavero de macOS (servicio «AgoraOne», cuenta «backup-key»). Si ya hay copias y la clave falta, AgoraOne no crea otra en silencio: deja de copiar y pide restaurar con la clave de recuperación.

Guarda la clave de recuperación fuera de este Mac (gestor de contraseñas o papel). Sin ella, si pierdes el Mac o su Llavero, las copias no se pueden abrir. **Ejecuta estos comandos en tu propia terminal, nunca desde un chat con un asistente** (en Claude Code, no con `!`): lo que se imprime acaba en el historial de la conversación.

```sh
cd core
uv run python -m agora_core.cli recovery-key      # se muestra mientras no la hayas guardado; --again para repetir
uv run python -m agora_core.cli list              # copias existentes, y aviso si la clave de recuperación está pendiente
uv run python -m agora_core.cli backup            # copia manual ahora
uv run python -m agora_core.cli restore <archivo> # con AgoraOne parado; --recovery pide la clave de recuperación
```

Restaurar conserva la base anterior junto a la nueva como `agora.db.before-restore-<fecha>`. En otro Mac, `restore --recovery` guarda además esa clave en su Llavero para las copias siguientes. AgoraOne recuerda la huella (no la clave) de la última clave de recuperación que te mostró y avisa si la del Llavero es otra.

## Datos y diagnóstico
`.agora/conversations` contiene conversaciones privadas. `.agora/hermes` contiene estado de Hermes aislado. `.env`, `.agora`, node_modules y dist están ignorados. No compartir esos archivos ni logs sin revisarlos.

Errores del proveedor son visibles y no producen respuestas de prueba. Si cambia el commit de Hermes, el adaptador se detiene hasta revisar compatibilidad. El build puede avisar del tamaño del paquete 3D; no impide ejecutarlo. Hay interior de biblioteca; no hay soporte XR ni interiores de otros edificios.
