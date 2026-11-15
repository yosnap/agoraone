# Voz, música y aplicaciones (1.5)

Plan: `plans/261115-1600-voz-musica/plan.md`. Todo funciona en este equipo, con un adaptador por sistema.

## Música

La tarjeta de música del pie del Cerebro enseña lo que suena en Apple Music o Spotify (título, artista,
progreso) y tiene sus controles: anterior, reproducir o pausar, siguiente y volumen. Su campo «Pon…» sirve
para pedir algo.

- macOS: funciona por AppleScript. La primera vez macOS pide el permiso de Automatización («AgoraOne quiere
  controlar Música»). La app lo declara (`NSAppleEventsUsageDescription` y `automation.apple-events`), y
  `empaquetar.sh` comprueba que esté en la firma.
- Linux: cualquier reproductor MPRIS, con `playerctl`.
- Windows: todavía no.
- Para ver lo que suena nunca se abre un reproductor: solo se pregunta a los que ya están abiertos.
- «Pon…» funciona distinto según el reproductor:
  - en Música, reproduce lo primero que coincida en tu biblioteca;
  - en Spotify, abre su búsqueda para que elijas, porque su AppleScript no permite buscar y reproducir.
- Las órdenes salen de una lista cerrada, y el texto de «pon…» se pasa como argumento de AppleScript, nunca
  escrito dentro del guion.

## Órdenes rápidas, sin modelo

Si todo el mensaje a Watson, escrito o dicho, es una de estas órdenes, la hace al momento y la anota en el chat
como «Orden rápida, sin modelo»:

- pausa, sigue, siguiente, anterior, sube o baja el volumen;
- «pon …» (como mucho 7 palabras);
- «abre …».

No cuentan como órdenes rápidas, y van a Watson:

- los «pon» que hablan de reglas, recordatorios, notas, eventos, tareas, correos o reuniones;
- los «abre» seguidos de artículo («abre una nota nueva…»).

Código: `src/assistant/quick-commands.ts`.

## Abrir aplicaciones

«Abre Notas» busca entre las aplicaciones instaladas:

- macOS: las carpetas de Aplicaciones, con el nombre que muestra el sistema en español y el original;
- Linux: sus archivos `.desktop`.

Las apps marcadas en Ajustes › Voz › «Aplicaciones que Watson puede abrir» se abren sin preguntar. Cualquier
otra se abre solo si respondes «sí» justo después. Siempre se abren por su identificador (`open -b`,
`gtk-launch`), nunca por un nombre o una orden escritos por alguien. Watson nunca cierra ni cambia una app.

## Watson responde hablando

Watson responde con las voces del sistema (la síntesis de voz del navegador, en este equipo), con una voz en
español si la hay. Lee la respuesta sin el formato Markdown y sin las citas, cortada en una frase cerca de los
700 caracteres. En Ajustes › Voz se elige cuándo: cuando le hablas con el micrófono (por defecto), siempre o
nunca.

## Rutas del núcleo

| Ruta | Para qué |
|---|---|
| `GET /music/status`, `POST /music/control`, `POST /music/play` | lo que suena, los controles y «pon…» |
| `GET /apps`, `PUT /apps/allowed`, `POST /apps/open` | apps instaladas, las permitidas y abrir una (409 si hace falta confirmar) |

## Pendiente

- Atajo global para pulsar y hablar, y «Oye Watson».
- La biblioteca local y YouTube.
- Probar Música y Spotify de verdad con la app firmada, por el permiso de Automatización.
