# Reuniones y voz (1.3)

AgoraOne transcribe la voz en el propio equipo con **whisper.cpp**. Lo usa para dos cosas: dictar en los chats y grabar reuniones. El audio nunca sale del equipo. Solo el texto de una reunión normal va a Claude para resumirla.

## Lo que hace falta

| Pieza | macOS | Linux | Windows |
|---|---|---|---|
| `whisper-cli` (whisper.cpp) | `brew install whisper-cpp` | paquete de la distribución o compilado | versión publicada de whisper.cpp (`whisper-cli.exe`) |
| `ffmpeg` | `brew install ffmpeg` | gestor de paquetes (no el de Snap) | winget, scoop o chocolatey |
| Modelo `ggml-….bin` | se recomienda `ggml-large-v3-turbo` | igual | igual |
| Audio del sistema en reuniones | programa propio de ScreenCaptureKit | `pactl` y ffmpeg (PulseAudio o PipeWire) | todavía no: solo micrófono |

AgoraOne busca los programas y los modelos donde suele instalarlos cada sistema, y también en la caché de Hugging Face. En **Ajustes › Voz** se ve qué ha encontrado y se puede elegir otra ruta.

- Al guardar una ruta, AgoraOne comprueba que el programa responde como whisper.cpp o como ffmpeg. En Windows solo acepta archivos `.exe`.
- Si un programa elegido desaparece (porque se desinstaló o se actualizó), Ajustes lo dice en lugar de dar la voz por lista.
- Si hay un modelo *turbo*, se elige ese, porque es mucho más rápido.

En desarrollo, `pnpm dev` compila primero el programa de audio del sistema del Mac (`desktop/scripts/auxiliares.mjs`, que necesita las herramientas de Xcode). La app empaquetada lo compila y lo firma en `empaquetar.sh`.

## Dictar

Junto a la caja de texto del chat de Watson y de cada bot está el botón **Dictar**:

1. Pulsa **Dictar** para empezar a grabar, hasta un minuto.
2. Pulsa otra vez para parar.
3. Lo transcrito se añade a la caja. Nunca se envía solo: lo revisas y lo envías tú.

Cómo se comporta:

- El botón de parar nunca se desactiva.
- Si sales del chat mientras grabas (cambias de perfil o de sección), el micrófono se cierra y lo grabado se descarta.
- Graba a 32 kbps, así que un minuto ocupa unos 240 KB.
- Solo se hace una transcripción a la vez. Si hay otra en curso, AgoraOne avisa.
- Cada dictado acaba antes de que el servidor deje de esperar: whisper tiene 85 s como máximo y ffmpeg lee como mucho 65 s de audio.

## Grabar una reunión

En la sección **Reuniones**:

1. Escribe un título (opcional) y elige la confidencialidad: normal, solo en este Mac o privada.
2. Indica si quieres grabar también el audio del sistema, es decir, lo que dicen los demás.
3. Pulsa **Empezar a grabar**.

Las pistas son dos:

- **Tu micrófono** lo graba la pantalla y lo envía al núcleo a trozos de 5 s.
- **El audio del sistema** lo graba el núcleo:
  - En macOS, con `agora-system-audio` (`core/helpers/system-audio-macos.swift`). Pide el permiso «Grabación de pantalla y audio del sistema» y graba solo audio, nunca la pantalla.
  - En Linux, con ffmpeg sobre el *monitor* de la salida por defecto.
  - Sin adaptador, o sin permiso, la reunión sigue solo con el micrófono, y se dice.

Mientras graba:

- La barra lateral muestra un punto rojo en Reuniones todo el tiempo, y puedes cambiar de sección sin que la grabación se corte.
- Nada graba sin que se sepa. Si la pantalla deja de enviar el micrófono durante 45 s (porque se cerró, se colgó o el equipo se durmió), la grabación se detiene sola. También se detiene a las 4 horas.
- Solo se graba una reunión a la vez.
- Si el núcleo se cierra mientras graba, la reunión queda «interrumpida» y se conserva lo grabado hasta ese momento.
- Si grabas con altavoces, tu micrófono recoge también a los demás. Con auriculares las pistas salen limpias. Aun así, al transcribir se descarta la frase de tu pista que repite, en el mismo momento, lo que dice la del sistema.

El audio se guarda en los datos de AgoraOne, en `meetings/<id>/`, con permisos solo para ti. Nunca va al vault. Se borra con **Borrar**, que pide confirmación.

## De la grabación a la nota

**Transcribir y resumir** trabaja en segundo plano y la lista enseña cómo avanza:

1. **Transcripción.** Cada pista se transcribe con whisper.cpp y las dos se unen por tiempo, como «Tú» y «Los demás».
2. **Resumen** (con decisiones y tareas), según la confidencialidad de la reunión:
   - **Normal**: lo hace Claude, con la sesión de Claude Code o con la clave de API.
   - **Solo en este Mac o privada**: lo hace el modelo local elegido en **Ajustes › Voz › Resumen de reuniones**. Puede ser LM Studio (`http://127.0.0.1:1234/v1`), Ollama (`http://127.0.0.1:11434/v1`) o cualquier servidor con la API de chat de OpenAI. Solo se aceptan direcciones de este equipo y nunca se pasa por un proxy. Si no hay ningún modelo elegido, la reunión se queda solo con la transcripción.
   - La transcripción va siempre como dato entre marcas, junto con la fecha de la reunión, para que «el jueves» se entienda bien. Nunca va como instrucciones. La respuesta se valida: tiene que ser JSON y las fechas tienen que ser reales.
3. **Ver** abre el resumen, las decisiones, las tareas, la transcripción y la nota completa.

A partir de ahí, nada se escribe sin que lo confirmes:

- **Guardar en el vault…** crea la nota con el mismo mecanismo que el panel del vault. Eliges el vault, la carpeta y el título, y confirmas. Nunca sobrescribe una nota que ya exista. La nota lleva `confidencialidad:` en sus propiedades, para que el cerebro la trate como se marcó la reunión.
- Cada tarea puede pasar a **recordatorio** (en Recordatorios de macOS, a las 9:00 si tiene fecha) o a **encargo del bot central** (una tarjeta del kanban de Hermes). Las dos opciones piden confirmación, tarea a tarea.

## Rutas del núcleo

Todas pasan por `/api/core`, con la cookie de acceso y el CSRF.

| Ruta | Para qué |
|---|---|
| `GET /voice/status`, `PUT /voice/settings` | programas y modelo, encontrados o elegidos |
| `POST /voice/transcribe` | dictar un clip de hasta 1 MiB; responde 409 si hay otra transcripción en curso |
| `GET/POST /meetings` | lista de reuniones y empezar una (`mic_type`, `confidentiality`, `system`) |
| `POST /meetings/{id}/mic`, `POST /meetings/{id}/stop` | trozos del micrófono, en orden, y parar |
| `POST /meetings/{id}/process`, `GET /meetings/{id}` | transcribir y resumir (o solo resumir otra vez) y el detalle con la nota |
| `POST /meetings/{id}/saved`, `DELETE /meetings/{id}` | apuntar la nota creada y borrar el audio |
| `GET/PUT /meetings/settings`, `GET /meetings/local-models` | el modelo local de los resúmenes |

## Límites conocidos

- Windows todavía no graba el audio del sistema, y la app de escritorio solo existe para macOS. En Linux y Windows se usa el navegador, que en `127.0.0.1` sí permite el micrófono.
- La transcripción no distingue entre los demás participantes: todos aparecen como «Los demás».
- Hay que comprobar a mano, en la app firmada, el permiso de micrófono y el de grabación de pantalla y audio del sistema.
