# Mi fábrica en AgoraOne

Mi fábrica es un proyecto aparte del usuario: una fábrica de contenido que investiga, produce, espera aprobación,
publica y mide. Su panel es una web local (FastAPI y plantillas, sin API JSON) que sirve su propio proceso
`fabrica servir` en `http://127.0.0.1:{puerto}` (8742 por defecto), con su contraseña y su sesión.

AgoraOne no trae su código: muestra **su panel tal cual** en una ventana propia de la app de escritorio, y lo que se
haga allí (aprobar o rechazar una corrida, vigilar competidores, guardar ideas, cambiar ajustes) lo hace el panel de
la fábrica. Decisión del usuario del 18/11/2026 (`AGENTS.md`).

## Qué se ve

- Menú «Mi fábrica», justo antes de «Presupuestos». Sección a todo el ancho con el estado de la fábrica, leído al
  entrar y con «Volver a comprobar» (sin sondeo):
  - **En marcha** (su panel responde en `/salud`): «Abrir la fábrica» y una tarjeta por pantalla del panel (Estado,
    Corridas, Publicaciones, Competidores, Piezas, Ideas, Señales y Ajustes), cada una con «Abrir en la ventana».
  - **Parada** (la carpeta es la suya, pero el panel no responde): cómo arrancarla en la terminal y, en macOS, el
    botón «Arrancar la fábrica».
  - **Sin carpeta** o **Carpeta errónea**: «Ir a Conectores», donde se indica su carpeta (y su puerto).
- La primera vez se entra con la contraseña del panel (`fabrica panel-clave`); su sesión dura 8 horas y se recuerda
  al reabrir la app (macOS 14+, Windows y Linux).
- Sin la app de escritorio (AgoraOne en una pestaña del navegador), «Abrir en el navegador».

## Módulo

Módulo «Mi fábrica» (`fabrica`) en Ajustes › Módulos. Mientras el usuario no lo fije, está encendido si hay una
carpeta de la fábrica registrada en Conectores y apagado si no. Apagado: sale del menú, sus rutas dan 404 y la
ventana se cierra al momento. El modo discreto cierra la ventana y la sección no ofrece abrirla.

## Arrancar la fábrica

Excepción a «AgoraOne no arranca complementos», solo para la fábrica y solo en macOS: «Arrancar la fábrica» pide a
launchd que arranque el servicio que la propia fábrica instala (`fabrica servicio instalar`, etiqueta
`com.sn4p.fabrica`) con `launchctl kickstart`, sin `-k` (`core/agora_core/fabrica_service.py`,
`POST /fabrica/start`). Si el panel ya responde no se pide nada. AgoraOne nunca la para, ni la instala, activa o
cambia, ni ejecuta nada de la fábrica. Tras pedirlo, la sección comprueba unas pocas veces si responde y, si no, lo
dice (sus registros están en `~/Library/Logs/mi-fabrica`). Sin servicio instalado (código 113 de launchctl) se
indica `fabrica servicio instalar`; cualquier otro fallo (por ejemplo, el servicio desactivado), `fabrica servir`.

## Cómo se conecta

`POST /api/core/fabrica/window {ruta}` deja una orden en el núcleo
(`core/agora_core/routes_fabrica_window.py`), con la ruta de una lista cerrada y la dirección
`http://127.0.0.1:{puerto}` del complemento; la app de escritorio la recoge en `/internal/fabrica/window/next`
(inalcanzable desde el navegador), revalida el origen y abre o navega la ventana `fabrica`
(`desktop/app/src/fabrica_window.rs`, sobre la ventana común `addon_window.rs` que comparte con Central). Nada del
panel pasa por la API de AgoraOne salvo la comprobación de `/salud`.

## Seguridad

- **Origen**: la ventana solo carga `http://127.0.0.1:{puerto}` (no `localhost`: el panel solo escucha en IPv4 y
  otro programa podría escuchar en `::1`) y nunca uno de los puertos de AgoraOne (4317 y 4318). Lo comprueban el
  núcleo y la app. Las redirecciones y `target=_blank` pasan por el mismo filtro.
- **Almacén propio**: la ventana nunca usa el almacén por defecto de la ventana principal, así que la cookie de
  AgoraOne no llega a la fábrica ni la de la fábrica a AgoraOne o a Central. Identificador propio en macOS 14+,
  privada en macOS 13 (pide la contraseña cada vez) y carpeta `fabrica-web` en Windows y Linux.
- **Sin comandos ni permisos**: la ventana no tiene órdenes nativas y se le deniegan micrófono, cámara, ubicación,
  notificaciones y cualquier otro permiso.
- **Enlaces a otros sitios** (YouTube, Reddit…): no se siguen dentro; AgoraOne avisa «Esto se abre en tu navegador»
  (como mucho uno por segundo; dirección oculta en modo discreto) y los abre en el navegador del sistema.
- **Descargas**: solo los archivos de una corrida (`/corridas/{id}/archivos/{n}`) de su origen, a la carpeta
  Descargas, con el nombre propuesto saneado (sin carpetas, sin caracteres invisibles ni nombres reservados de
  Windows) y sin sobrescribir nunca (`guia (2).pdf`…; dos descargas seguidas del mismo nombre reciben archivos
  distintos). Al terminar, aviso «Descargado en Descargas: nombre» (nombre oculto en modo discreto). Cualquier otra
  descarga se deniega.
- **En el navegador del sistema** («Abrir en el navegador», sin la app de escritorio): si AgoraOne se usa en
  `http://127.0.0.1:4317`, el navegador envía también a la fábrica la cookie de acceso de AgoraOne, porque las
  cookies van por host y no por puerto (y `SameSite` considera el mismo sitio a dos puertos del mismo host). Se
  acepta, como en la ruta de navegador de Central: la fábrica es un proceso local del usuario, la cookie es
  `HttpOnly` y el panel no registra los accesos. La ventana de la app no tiene este problema (almacén propio).

## Límites

- WebKit en macOS pregunta también por los marcos: un iframe de otro sitio en el panel se cancelaría (hoy no tiene,
  y su CSP los prohíbe).
- El botón «Arrancar» solo existe en macOS (la fábrica solo instala servicio de launchd). En Windows y Linux, la
  fábrica se arranca a mano con `fabrica servir`.
- La app de escritorio aún no compila en Windows; lo dicho de WebView2 queda por probar allí.
