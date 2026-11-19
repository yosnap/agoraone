# Voz, música y aplicaciones (1.5)

Plan: `plans/261115-1600-voz-musica/plan.md`. Todo funciona en este equipo, con un adaptador por sistema.

## Música

La tarjeta de música del pie del Cerebro enseña lo que suena (tu biblioteca, YouTube, Apple Music o Spotify):
título, artista, la carátula y sus controles: anterior, reproducir o pausar, siguiente, una barra para ir a
otro punto de la canción y otra de volumen (1.7.0-alpha.36). Las barras solo mandan la orden al soltarlas. La
carátula es la miniatura del vídeo de YouTube, la imagen dentro del archivo de tu biblioteca (MP3, FLAC o M4A) o
la del álbum a su lado (`cover.jpg`, `folder.jpg`…), o la que dan Apple Music o Spotify (`core/agora_core/music_cover.py`).
Su campo «Pon…» sirve para pedir algo; el desplegable se abre hacia arriba cuando no cabe debajo.

- macOS: funciona por AppleScript. La primera vez macOS pide el permiso de Automatización («AgoraOne quiere
  controlar Música»). La app lo declara (`NSAppleEventsUsageDescription` y `automation.apple-events`), y
  `empaquetar.sh` comprueba que esté en la firma.
- Linux: cualquier reproductor MPRIS, con `playerctl`.
- Windows: todavía no.
- Para ver lo que suena nunca se abre un reproductor: solo se pregunta a los que ya están abiertos.
- «Pon…» funciona distinto según el reproductor:
  - en Música, reproduce lo primero que coincida en tu biblioteca y, si no está, la canción del catálogo de Apple
    Music (la reproduce tu suscripción): Música abre su álbum y salta, en silencio, hasta esa canción (el nombre
    se compara sin mayúsculas, tildes ni puntuación, y vale «Corazón Partío (Remastered)» para «Corazón Partío»).
    Todo cabe en unos 20 s: si Música no llega a tiempo, se pausa, se le devuelve el volumen y suena en YouTube;
    el volumen se devuelve también si Música falla a medias. Si Música no responde a una búsqueda, se pausa para
    que no empiece a sonar encima de YouTube;
  - en Spotify, abre su búsqueda para que elijas, porque su AppleScript no permite buscar y reproducir.
- Las órdenes salen de una lista cerrada, y el texto de «pon…» se pasa como argumento de AppleScript, nunca
  escrito dentro del guion.
- Qué sale del equipo con «pon…»: solo las palabras pedidas, a dos sitios. A la API pública de búsqueda de iTunes
  de Apple (`itunes.apple.com/search`, tienda de España, `country=es`), cuando no está en tu biblioteca de
  Música, y a la búsqueda pública de YouTube cuando suena allí. Sin cuenta, clave, cookies ni identificadores tuyos;
  nada más de AgoraOne va con ellas.

## Tu biblioteca y YouTube

- En Ajustes › Voz › «Tu música» se eligen las carpetas de música, con el selector de macOS o escribiendo la
  ruta.
- AgoraOne las indexa por artista, álbum y título, a partir de la estructura `Artista/Álbum/01 Título.mp3` o del
  nombre «Artista - Título». Admite MP3, M4A, FLAC, WAV, AAC y OGG, hasta 20.000 archivos y 6 niveles de
  carpetas, y solo las lee.
- Las reproduce su propio reproductor, el mismo para toda la app, así que sigue sonando aunque cambies de
  sección. Cada canción se pide con la cabecera anti-CSRF y suena desde memoria.
- Solo se sirven archivos que están dentro de esas carpetas.
- «Pon…» decide dónde buscar así:
  - si no nombras dónde, busca primero en tu biblioteca, después en el reproductor que esté abierto, luego en
    Música (que solo busca en tu biblioteca de Apple Music) y, si no está en ninguno, en YouTube;
  - «en Spotify», «en Música» o «en mi biblioteca» lo fuerzan;
  - «en YouTube» (1.7) suena dentro de AgoraOne, en un reproductor pequeño que sigue en todas las secciones y solo
    se maneja desde la app (tarjeta de música, Watson y su ✕). El núcleo busca en la página pública de YouTube, sin
    cuenta ni clave (`core/agora_core/youtube.py`), y solo se queda con identificador, título, canal y duración. El
    vídeo es el de YouTube sin cookies, manejado por mensajes (`src/brain/youtube-player.tsx`): el script de
    YouTube nunca corre dentro de AgoraOne. Los vídeos que su dueño no deja incrustar (lo habitual en los de las
    discográficas) suenan, en la app de escritorio, en una ventana oculta con la página de YouTube
    (`desktop/app/src/youtube_window.rs`). También los que fallan sin avisar: con el error 153 («Error de
    configuración del reproductor») YouTube enseña su pantalla y no manda ningún mensaje, así que si en 5 s el
    reproductor no ha dicho nada, o en 12 s no da ninguna señal de arranque (duración, estado o tiempo), se pasa
    igual a la ventana oculta. Mientras, la mini ventana dice «Preparando el vídeo…» y, al pasar, que lo abre desde
    YouTube en segundo plano (alpha.30 y .31). Esa ventana no tiene órdenes nativas, no guarda nada entre arranques,
    solo carga páginas de YouTube, rechaza las cookies, salta los anuncios que dejan saltarse y no pasa sola al
    siguiente vídeo. La pantalla deja sus órdenes en el núcleo y la app las recoge; el estado del vídeo vuelve a la
    pantalla ya revisado. AgoraOne se sirve siempre desde `http://127.0.0.1` y YouTube no deja incrustar su
    reproductor en una página servida desde una IP (da el error 150 incluso con vídeos que sí lo permiten): por eso,
    en la app de escritorio, los vídeos van directos a la ventana oculta, y en la vista previa del navegador, que no
    la tiene, se avisa al momento y se ofrece «Abrir en YouTube». No se usa `localhost` a propósito: otro programa
    podría escuchar en `[::1]` en el mismo puerto, quedarse la ventana (`localhost` resuelve antes a `::1`) y leer
    el token de acceso de la dirección.
- En la tarjeta de música, el desplegable elige la fuente: tu biblioteca si tienes carpetas de música, YouTube si
  no. Con «Tu biblioteca», lo que no está en ella se busca en YouTube y se dice. Cuando nada suena, la tarjeta dice qué reproductor está abierto. Un reproductor que no está instalado (Spotify)
  se avisa sin preguntarle a macOS, que abriría «¿Dónde está…?».
- La búsqueda de YouTube lee sus resultados en las dos formas en que YouTube los sirve (`videoRenderer` y, a ratos,
  `lockupViewModel`; antes de 1.7.0-alpha.36 la segunda daba «No encuentro…») y, si una página llega sin ellos,
  repite una vez.
- Si el reproductor incrustado de YouTube falla sin decir nada (el error 153 de la ventana de la app), AgoraOne lo
  recuerda en este Mac y los siguientes vídeos van directos a la ventana oculta, sin esperar esos segundos cada vez.

## Órdenes rápidas, sin modelo

Si todo el mensaje a Watson, escrito o dicho, es una de estas órdenes, la hace al momento y la anota en el chat
como «Orden rápida, sin modelo»:

- pausa, sigue, siguiente, anterior, sube o baja el volumen;
- «pon …» (como mucho 10 palabras), también dicho con naturalidad: con «Watson» u «Oye Watson» delante, «¿me puedes poner…?» o «por favor» al final (1.7.0-alpha.23). Si el dictado oye mal la llamada («Wilson, pon música»), se ignora esa palabra antes de la coma, y «Música, por favor» vale como «pon música»; mientras Watson responde, estas órdenes también pasan (1.7.0-alpha.36). «Pon música» o «ponme algo», sin decir qué, reanuda lo que estaba sonando (tu biblioteca, YouTube, Música o Spotify) y, si no hay nada abierto, pone música tranquila en YouTube;
- música pedida sin «pon»: «Música de Alejandro Sanz desde YouTube», «canciones de Rosalía en Spotify», «quiero oír…» («desde» vale como «en»);
- «abre …»;
- grabar una reunión: «graba la reunión», «empieza a grabar», y pararla: «para la grabación», «deja de grabar»,
  «hemos terminado» (`src/assistant/meeting-commands.ts`). Graba como el botón del raíl, con las últimas opciones
  del formulario, y se ve en el raíl como siempre.

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

## La voz de Watson (1.7)

En Ajustes › Voz › «Voz de Watson» se elige quién lee las respuestas:
- Automática (por defecto): el perfil «Watson (AgoraOne)» de VoiceStudio cuando la app está abierta; si no, macOS.
- Una voz de VoiceStudio (sus perfiles) o una voz de macOS en español.
- Velocidad, «Rapidez de VoiceStudio» (rápida, equilibrada por defecto o más natural) y «Probar».
- «Abrir VoiceStudio en segundo plano al arrancar AgoraOne» (activada por defecto; petición del usuario, 16/11/2026).

VoiceStudio (OmniVoice) corre en este Mac, en `127.0.0.1:3900`, una dirección fija en el núcleo (`core/agora_core/tts.py`).
El texto de la respuesta no sale del equipo. La pantalla corta la respuesta en frases mientras llega
(`src/assistant/voice-pieces.ts`): la primera suena en cuanto está escrita y las siguientes se preparan mientras habla
(`src/assistant/voice-player.ts`). Si VoiceStudio está en marcha o abriéndose, Watson lo espera (hasta dos minutos) en vez de hablar con macOS; si no está abierto o deja de responder, habla con la voz de macOS y el panel de Watson lo dice. Voicebox
queda para más adelante: genera en segundo plano y necesita descargar antes su modelo.

**Rapidez y consumo (alpha.27).** VoiceStudio trae su perfil «max», que hace 64 pasos por frase. AgoraOne pide
los suyos: 8 (rápida), 16 (equilibrada) o 32 (más natural). Medido en el Mac del usuario con el perfil de Watson,
una frase de unos 5 s de audio tardaba 5,4 s sin indicar pasos, 2,7 s con 16 y 1,8 s con 8. El modelo ocupa
cerca de 1 GB de memoria y solo gasta procesador mientras habla. La primera petición tras abrir VoiceStudio tarda
entre 10 y 15 s, porque carga el modelo, aunque `/model/loaded` ya lo dé por cargado. Por eso, al arrancar y al
enviar una pregunta (`POST /voice/warm`), si AgoraOne no ha oído hablar a VoiceStudio en los últimos 10 minutos, le
hace decir «Hola.» sin reproducirlo mientras Watson piensa. No se usa
`/setup/warmup` de VoiceStudio: carga otro modelo de 2 GB que la voz no usa y la frena.

**Abrir VoiceStudio al arrancar.** Si la voz no es la de macOS, la opción está activada y VoiceStudio está
instalado en `/Applications` o `~/Applications` pero cerrado, el núcleo lo abre con `open -g -j`, oculto y sin
quitar el foco. Espera hasta 2 minutos a que responda y prepara la voz. Mientras arranca, Watson habla con la voz
de macOS y Ajustes dice «Abriendo VoiceStudio».

## Llamar a Watson

- ⌃⌥W desde cualquier app (lo registra la app de escritorio con el plugin de atajos globales de Tauri): AgoraOne
  pasa delante, abre el Cerebro y el micrófono de Watson empieza a escuchar. Para solo cuando terminas de hablar
  (1,8 s de silencio tras al menos 0,4 s de voz; el primer 0,8 s solo mide la sala, para que el final de «Oye Watson» no cuente; si no dices nada en 10 s, lo deja sin enviar: `src/ui/silence.ts`), y otra
  pulsación, o el botón, también para y envía. Si otra app ya usa ese atajo, AgoraOne arranca igual, sin él.
- «Oye Watson», que se enciende en Ajustes › Voz y está apagado por defecto:
  - Lo escucha `agora-wake` (`core/helpers/wake-macos.swift`), con el reconocimiento de voz de Apple en este
    Mac. Si el Mac no puede reconocer sin red, el auxiliar no arranca.
  - Solo escribe «wake» cuando oye la frase. No guarda ni envía nada de lo que oye, y reinicia la sesión cada
    50 s.
  - La app de escritorio lo arranca y lo para según el ajuste, y cada «wake» funciona como pulsar ⌃⌥W.
  - Mientras esté activo, el micrófono queda abierto y macOS enseña su punto naranja.
  - El auxiliar lleva dentro su Info.plist con los motivos de los permisos de micrófono y de reconocimiento
    de voz.
  - Ajustes › Voz dice si está escuchando o por qué no arranca, con el arreglo: falta el permiso de
    reconocimiento de voz o de micrófono, este Mac no reconoce el español sin internet (se descarga activando
    el Dictado en español) o el micrófono no se abre. Tras un fallo la app no lo relanza sola, para que macOS
    no pida permisos en bucle: se vuelve a intentar con «Reintentar» o al encenderlo otra vez.

## Rutas del núcleo

| Ruta | Para qué |
|---|---|
| `GET /music/status`, `POST /music/control`, `POST /music/play` | lo que suena, los controles (también `volume` y `seek` con `value`) y «pon…» |
| `GET /music/cover?player=&key=`, `GET /music/library/{id}/cover` | carátula de lo que suena en Apple Music o Spotify, o de una canción de tu biblioteca (204 si no hay) |
| `GET /apps`, `PUT /apps/allowed`, `POST /apps/open` | apps instaladas, las permitidas y abrir una (409 si hace falta confirmar) |
| `GET/PUT /voice/tts` | Voz de Watson: lo elegido, lo que habla ahora y las voces de VoiceStudio |
| `POST /voice/speak` | Un trozo de respuesta dicho por VoiceStudio (audio WAV), con los pasos de la rapidez elegida |
| `POST /voice/warm` | Carga la voz de VoiceStudio en segundo plano si no está cargada (al enviar una pregunta) |
| `GET/PUT /wake/settings` | «Oye Watson» encendido o apagado, y el estado del oyente |
| `POST /internal/wake/status` | La app de escritorio cuenta cómo va el oyente (el navegador no llega a `/internal`) |
| `GET /music/library`, `PUT /music/library/folders`, `POST /music/library/choose`, `GET /music/library/{id}/file` | biblioteca: carpetas, búsqueda y archivo |
| `GET /music/youtube/search` | vídeos de YouTube para el reproductor de AgoraOne |
| `POST /music/youtube` | abre una búsqueda de YouTube en el navegador |
| `GET/POST /music/youtube/hidden` | si existe la ventana oculta de YouTube y las órdenes para ella |
| `GET /internal/youtube/hidden/next` | la app de escritorio recoge esas órdenes (espera hasta 25 s) |

## Pendiente

- Probar ⌃⌥W y «Oye Watson» en la app firmada (permisos de micrófono y de reconocimiento de voz).
- Probar Música y Spotify de verdad con la app firmada, por el permiso de Automatización.
