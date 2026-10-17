# Arranque reproducible

Requisitos: macOS, Node >=22.12 (verificado 22.23.1), npm, Hermes en el commit documentado y su entorno Python. No instalar paquetes ni actualizar Hermes.

Desde esta carpeta:

```sh
npm ci
npm run check:hermes
npm run dev
```

Abrir http://127.0.0.1:5173 (usar esta dirección, no otra interfaz de red). Seleccionar Luma o Biblioteca, escribir y pulsar **Enviar a Hermes**. Configuración actual guardada en `.env` privado. `check:hermes` instancia el agente y comprueba cero herramientas sin pedir inferencia; no confirma la conexión al proveedor.

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
- Primera persona: activar modo y pulsar Entrar al recorrido; WASD y ratón, Esc libera el cursor. Abrir un espacio también libera el cursor.
- Si el navegador rechaza la captura del ratón, se muestra la alternativa: WASD con el lienzo enfocado y arrastrar para mirar. Pulsa de nuevo Entrar al recorrido para enfocar el lienzo.
- Nueva: comienza otra conversación, sin borrar la anterior del servidor.
- Los perfiles y espacios se obtienen del catálogo Hermes; los personajes ficticios adicionales del prototipo ya no se muestran.

## Datos y diagnóstico
`.agora/conversations` contiene conversaciones privadas. `.agora/hermes` contiene estado de Hermes aislado. `.env`, `.agora`, node_modules y dist están ignorados. No compartir esos archivos ni logs sin revisarlos.

Errores del proveedor son visibles y no producen respuestas de prueba. Si cambia el commit de Hermes, el adaptador se detiene hasta revisar compatibilidad. El build puede avisar del tamaño del paquete 3D; no impide ejecutarlo. Hay interior de biblioteca; no hay soporte XR ni interiores de otros edificios.
