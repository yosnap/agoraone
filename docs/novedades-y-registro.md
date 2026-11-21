# Versión, Novedades, Hoja de ruta y Registro

## Versión visible
La barra lateral enseña la versión en uso debajo del logo «a» (por ejemplo `v1.10.0-alpha.4`). Sale de `package.json`
al compilar (`__APP_VERSION__` en `vite.config.ts`, leída en `src/about/app-version.ts`), así que cambia sola con cada
subida de versión. En el móvil, donde la barra va abajo, no se muestra.

## Pestañas de Ajustes
Van en una sola fila con desplazamiento horizontal. Al elegir una, queda a la vista.

## Novedades (Ajustes › Novedades)
Todas las versiones publicadas, de la más reciente a la primera, cada una en un acordeón. La versión en uso viene
abierta y marcada como «Tu versión». Cada cambio tiene un tipo (Novedad, Mejora, Arreglo, Seguridad o Cambio) con
icono y color de fondo, y se despliega cuando trae detalle. Se puede filtrar por tipo.

- Datos: `src/about/changelog-data.ts` (tipos en `changelog-types.ts`). Las versiones 0.1 a 1.9 salen de las notas de
  sus releases de GitHub; la 1.6, que no tiene release, del estado del proyecto.
- La versión en preparación aparece con fecha vacía («En preparación») y se va completando en cada fase.
- **Al publicar una versión**: poner su fecha y título, con el mismo texto que la release. Una prueba
  (`src/about/changelog.test.ts`) falla si la versión de `package.json` no está en la lista o si el orden no es de la
  más nueva a la más antigua.

## Hoja de ruta (Ajustes › Hoja de ruta)
Lo que viene, en tres columnas: En curso, Planificado y Pensado. No es un compromiso: se va rellenando poco a poco y,
cuando algo se publica, sale de aquí y pasa a Novedades. Datos en `src/about/roadmap-data.ts`. Como el repositorio es
público, los textos son genéricos y no llevan datos del usuario.

## Registro (Ajustes › Registro)
Lo que pasa en AgoraOne: el arranque del núcleo, sus avisos y errores (también los de los hilos de fondo), las rutas
que responden con error y los errores sin controlar de la interfaz.

- **Dónde**: `<datos del núcleo>/logs/agoraone.log`, una entrada JSON por línea (hora UTC, nivel, origen, área y
  mensaje). Rota al llegar a 1 MB y guarda cuatro archivos anteriores: 5 MB como mucho.
- **Privacidad**: se queda en este equipo y nunca va a un modelo. Las líneas con pinta de clave se sustituyen por
  «[oculto: parece una clave]», los tokens conocidos (`sk-…`, `ghp_…`, JWT…) se tapan y cada mensaje se recorta a
  1000 caracteres. No se guardan cuerpos de peticiones, ni la parte de consulta de las direcciones, ni textos de
  correos o mensajes.
- **Interfaz**: `src/api/client-log.ts` envía los `error` y `unhandledrejection` de la ventana con el nombre del
  archivo y la línea, sin la dirección (su fragmento lleva el token de acceso). Como mucho 20 entradas por minuto y el
  mismo texto una vez cada 30 s; si el envío falla, no se reintenta.
- **API del núcleo**: `GET /logs` (`level`, `q`, `source`, `limit` hasta 2000) y `POST /logs/client` (nivel `info`,
  `warning` o `error`, área de hasta 60 caracteres y mensaje de hasta 2000), ambas tras las comprobaciones habituales
  del servidor (`/api/core/*`).
- **Código**: `core/agora_core/app_log.py` (escritura, redacción y lectura) y `routes_logs.py`; un error sin controlar
  en una ruta devuelve 500 con «Está en Ajustes › Registro».
- Aún no recoge lo que pasa en el servidor en Rust ni en la ventana de escritorio (está en la Hoja de ruta).
