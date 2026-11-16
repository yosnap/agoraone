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

Junto a la caja de texto del chat de Watson y de cada bot está el botón del **micrófono** (decisión del usuario, 15/11/2026):

1. Pulsa el micrófono para empezar a hablar, hasta un minuto.
2. Pulsa otra vez para parar.
3. Lo transcrito se envía en ese momento como mensaje, detrás de lo que ya hubieras escrito.

Cómo se comporta:

- El botón de parar nunca se desactiva.
- Si sales del chat mientras grabas (cambias de perfil o de sección), el micrófono se cierra y lo grabado se descarta.
- Graba a 32 kbps, así que un minuto ocupa unos 240 KB.
- Solo se hace una transcripción a la vez. Si hay otra en curso, AgoraOne avisa.
- Cada dictado acaba antes de que el servidor deje de esperar: whisper tiene 85 s como máximo y ffmpeg lee como mucho 65 s de audio.

## Grabar una reunión

En la sección **Reuniones**:

1. Elige qué es (reunión, formación, entrevista, llamada u otra), el cliente y el proyecto (de las listas de Central; el núcleo rechaza los que no estén, y un proyecto tiene que ser de ese cliente) y con quién (se busca en los Contactos del Mac, que incluyen las cuentas de iCloud, Google y Microsoft añadidas en Ajustes del Sistema › Cuentas de Internet, y quien no esté se escribe con comas; los elegidos de Contactos se guardan con su correo y la nota lo lleva, pero a Watson, al resumen y al archivo para Claude o Codex solo les llegan los nombres; un correo pegado junto al nombre se separa; los contactos sin nombre ni empresa no salen en la búsqueda), todo opcional y editable después en **Ver**. Escribe un título si quieres; si no, se compone con el tipo, el cliente y la hora («Formación con Acme · 10.30»). Elige la confidencialidad: normal, solo en este Mac o privada.
2. Indica si quieres grabar también el audio del sistema, es decir, lo que dicen los demás.
3. Pulsa **Empezar a grabar**.

Las pistas son dos:

- **Tu micrófono** lo graba la pantalla y lo envía al núcleo a trozos de 5 s.
- **El audio del sistema** lo graba el núcleo:
  - En macOS, con `agora-system-audio` (`core/helpers/system-audio-macos.swift`). Pide el permiso «Grabación de pantalla y audio del sistema» y graba solo audio, nunca la pantalla.
  - En Linux, con ffmpeg sobre el *monitor* de la salida por defecto.
  - Sin adaptador, o sin permiso, la reunión sigue solo con el micrófono, y se dice.

También se graba desde el **Cerebro**, el centro de mando (1.4): el botón **Grabar reunión** de su barra superior empieza con las opciones de la última vez (confidencialidad y audio del sistema) y, pulsado otra vez, para; abajo, una tarjeta enseña el tiempo, el volumen de tu micrófono y quién la resumirá. La grabación sigue aunque cambies de sección, y la barra lateral lo indica en Reuniones.

Mientras graba:

- La barra lateral muestra un punto rojo en Reuniones todo el tiempo, y puedes cambiar de sección sin que la grabación se corte.
- Nada graba sin que se sepa. Si la pantalla deja de enviar el micrófono durante 45 s (porque se cerró, se colgó o el equipo se durmió), la grabación se detiene sola. También se detiene a las 4 horas.
- Solo se graba una reunión a la vez.
- Si el núcleo se cierra mientras graba, la reunión queda «interrumpida» y se conserva lo grabado hasta ese momento.
- Si grabas con altavoces, tu micrófono recoge también a los demás. Con auriculares las pistas salen limpias. Aun así, al transcribir se descarta la frase de tu pista que repite, en el mismo momento, lo que dice la del sistema.

El audio se guarda en los datos de AgoraOne, en `meetings/<id>/`, con permisos solo para ti. Nunca va al vault. Se borra con **Borrar**, que pide confirmación.

## De la grabación a la nota

Al parar, la reunión se transcribe y se resume sola (se puede desactivar en Ajustes › Voz › Resumen de reuniones; entonces está el botón **Transcribir y resumir**). Trabaja en segundo plano, con prioridad baja y la mitad de los núcleos para que el equipo siga usable; con Ollama, el modelo se descarga de la memoria al terminar. La lista enseña cómo avanza y, si algo falla, el error exacto y **Reintentar**. Si una de las dos pistas no se puede leer, se usa la otra y se avisa. El audio del sistema se escribe por fragmentos de 5 s, así que sigue siendo legible aunque la grabación se corte de golpe:

1. **Transcripción.** Cada pista se transcribe con whisper.cpp y las dos se unen por tiempo, como «Tú» y «Los demás».
2. **Resumen** (con un resumen extendido por temas, decisiones y tareas), según la confidencialidad de la reunión. El modelo recibe también el tipo, el cliente y los participantes:
   - **Normal**: lo hace Claude, con la sesión de Claude Code o con la clave de API.
   - **Solo en este Mac o privada**: lo hace el modelo local elegido en **Ajustes › Voz › Resumen de reuniones**. Puede ser LM Studio (`http://127.0.0.1:1234/v1`), Ollama (`http://127.0.0.1:11434/v1`) o cualquier servidor con la API de chat de OpenAI. Solo se aceptan direcciones de este equipo y nunca se pasa por un proxy. Ajustes parte del servidor que esté abierto y solo ofrece modelos de chat que se ejecutan aquí: descarta los de búsqueda (embeddings) y los «cloud» de Ollama, que se ejecutan en sus servidores; si no queda ninguno, indica cuál descargar (por ejemplo `ollama pull qwen3:14b`). Si no hay ningún modelo elegido, la reunión se queda solo con la transcripción.
   - La transcripción va siempre como dato entre marcas, junto con la fecha de la reunión, para que «el jueves» se entienda bien. Nunca va como instrucciones. La respuesta se valida: tiene que ser JSON y las fechas tienen que ser reales.
3. **Quién resume se ve antes de empezar**: el formulario de grabar dice «Resumen: Claude…» o «Resumen: qwen3:14b en Ollama, en este Mac» según la confidencialidad elegida; cada reunión dice «Se resumirá con…» y, después, «Resumida por Claude» o «Resumida en este Mac»; Ajustes › Voz › Resumen de reuniones lo resume en tres líneas (grabar y transcribir, reuniones normales, reuniones privadas) y avisa si el modelo local elegido no responde.
4. **Ver** abre el resumen, las decisiones, las tareas, la transcripción y la nota completa.

A partir de ahí, nada se escribe sin que lo confirmes:

- **Guardar en el vault…** crea la nota con el mismo mecanismo que el panel del vault. Eliges el vault, la carpeta y el título, y confirmas. Nunca sobrescribe una nota que ya exista. El título propuesto ya no lleva caracteres que el vault rechaza (la hora sale como «10.30»). La nota lleva en sus propiedades `tipo:`, `cliente:`, `participantes:` y `confidencialidad:`, para que el cerebro la trate como se marcó la reunión.
- **Para Claude o Codex**: **Descargar el archivo** deja toda la reunión en un Markdown en Descargas (propiedades, resumen, resumen extendido, decisiones, tareas y transcripción completa) y lo enseña en el Finder; nunca sobrescribe, un nombre repetido lleva «(2)». **Copiar todo** pone lo mismo en el portapapeles. Solo las reuniones normales: las privadas y las de solo en este Mac no salen de AgoraOne.
- Cada tarea puede pasar a **recordatorio** (en Recordatorios de macOS, a las 9:00 si tiene fecha) o a **encargo del bot central** (una tarjeta del kanban de Hermes). Las dos opciones piden confirmación, tarea a tarea.

## Preguntar a Watson por una reunión

Watson tiene `consultar_reuniones` (por palabras, fechas, tipo, cliente o personas) y `leer_reunion` (la transcripción, en partes, solo de una reunión que ya encontró), en `core/agora_core/meeting_tools.py`. Sabe la fecha de hoy, así que entiende «la semana pasada» o «el martes». Solo ve las reuniones **normales** ya transcritas de tu acceso: las de solo en este Mac y las privadas nunca le llegan. Con lo que encuentra redacta en el chat un correo o un acta, listos para copiar. Una **issue de GitHub** la propone con `proponer_issue` para el repositorio que Central guarda del proyecto de la reunión (o de un proyecto que se le nombre); la tarjeta enseña repositorio, título y cuerpo, y solo se crea con **Crear la issue**, mediante el GitHub CLI del usuario (`gh`, `core/agora_core/github_issues.py`). Si el proyecto no tiene repositorio en Central, lo dice. Las herramientas se apagan con el módulo Reuniones.

## Rutas del núcleo

Todas pasan por `/api/core`, con la cookie de acceso y el CSRF.

| Ruta | Para qué |
|---|---|
| `GET /voice/status`, `PUT /voice/settings` | programas y modelo, encontrados o elegidos |
| `POST /voice/transcribe` | dictar un clip de hasta 1 MiB; responde 409 si hay otra transcripción en curso |
| `GET/POST /meetings` | lista de reuniones y empezar una (`mic_type`, `confidentiality`, `system`, `kind`, `client`, `people`) |
| `POST /meetings/{id}/mic`, `POST /meetings/{id}/stop` | trozos del micrófono, en orden, y parar |
| `POST /meetings/{id}/process`, `GET /meetings/{id}` | transcribir y resumir (o solo resumir otra vez) y el detalle con la nota |
| `POST /meetings/{id}/saved`, `DELETE /meetings/{id}` | apuntar la nota creada y borrar el audio |
| `PATCH /meetings/{id}`, `POST /meetings/{id}/export` | cambiar título, tipo, cliente o personas, y el archivo Markdown en Descargas |
| `GET/PUT /meetings/settings`, `GET /meetings/local-models` | el modelo local de los resúmenes |

## Límites conocidos

- Windows todavía no graba el audio del sistema, y la app de escritorio solo existe para macOS. En Linux y Windows se usa el navegador, que en `127.0.0.1` sí permite el micrófono.
- La transcripción no distingue entre los demás participantes: todos aparecen como «Los demás».
- Hay que comprobar a mano, en la app firmada, el permiso de micrófono y el de grabación de pantalla y audio del sistema.
