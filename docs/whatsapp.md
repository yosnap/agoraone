# WhatsApp (1.7)

AgoraOne lee los chats de WhatsApp del número del usuario a través de [Zernio](https://zernio.com), un servicio
sobre la WhatsApp Cloud API de Meta. El número sigue funcionando en la app WhatsApp Business del móvil (modo
«coexistence»). Decisión del usuario en `AGENTS.md` (18/11/2026).

## Conexión
1. El número se conecta en el panel de Zernio: «Connect WhatsApp» › «Use my own number» › «I chat from the
   WhatsApp Business app», y se escanea el QR desde la app del móvil (WhatsApp Business 2.24.17 o superior).
2. Si Meta marca el número como «No cumple los requisitos», suele estar ya conectado a otro proveedor: hay que
   desconectarlo en el móvil (Ajustes › Cuenta › Plataforma para empresas › Desconectar) y repetir el alta.
3. La clave de API de Zernio (empieza por `sk_`) se pega en **Ajustes › WhatsApp** y se guarda en el Llavero.
   «Probar» dice cuántas cuentas de WhatsApp ve Zernio.

Meta corta la conexión si la app del móvil no se abre en 14 días.

## Lectura
- Por sondeo cada 5 minutos y con «Leer ahora»; nada de webhooks ni puertos abiertos. Leer nunca escribe nada en
  Zernio: lo único que se envía es la respuesta que confirmas (ver «Responder»).
- Cada lectura dura como mucho unos 40 s y va a menos de 60 peticiones por minuto; lo que falte, en la siguiente.
  Solo se piden los mensajes de las conversaciones que han cambiado.
- La primera lectura trae lo de los últimos «Días hacia atrás» (60 por defecto); Zernio guarda hasta seis meses
  de historial.
- Se guardan texto, dirección, remitente y fecha. De los adjuntos, solo el tipo; nunca su enlace. Lo que Meta no
  entrega llega como «mensaje no disponible».
- AgoraOne nunca marca nada como leído ni usa el indicador de «escribiendo» (en WhatsApp lo marca como leído).
- **Los grupos no llegan**: Meta no los pasa a la API en coexistence. Tampoco los mensajes temporales ni los de
  ver una vez.
- Cada cuenta tiene ámbito, confidencialidad (normal, solo en este Mac, privado) y días hacia atrás, como el
  correo. Una lectura nunca cambia la confidencialidad.
- El módulo «WhatsApp» se apaga en Ajustes › Módulos; entonces no hay lectura ni peticiones a Zernio.

## Clasificación (1.7.0-alpha.49)
- Cada conversación con mensajes recibidos nuevos recibe clase, resumen, lo que pide, fechas e importes, y queda
  pendiente, hecha, descartada o en silencio. Vuelve a pendiente solo cuando llega algo recibido; lo que escribe
  el usuario no la reabre. La primera vez, lo que lleva más de 7 días sin recibir nada queda en silencio.
- **Reglas** (Ajustes › WhatsApp › Reglas): por contacto (número; con «+» exige todos los dígitos, sin «+» admite
  que falte el prefijo de país, con 9 dígitos como mínimo), cuenta o palabras, con etiqueta opcional para la
  fuente (p. ej. «Instinct», cuyo número fijo le escribe al usuario por WhatsApp). Decide la primera que
  coincide y solo endurece la confidencialidad. Las palabras se buscan en **toda** la conversación, también en
  lo que escribe el usuario (decisión del usuario, 18/11/2026). Crear, cambiar o quitar una regla la reaplica sin
  modelo.
- Lo normal lo resume Claude Haiku (últimos 30 mensajes, como mucho 4000 caracteres, como dato delimitado). Lo
  «solo en este Mac» y lo privado se clasifican con palabras clave locales, sin resumen. Los mensajes no
  disponibles no se envían. El correo y WhatsApp comparten el límite de 40 llamadas por hora.
- Una conversación se marca como de cliente cuando su número es el de un cliente del directorio (Central, CRMDev o
  los clientes propios); lo privado nunca.
- `GET /chat/summaries` nunca devuelve el texto de los mensajes; lo privado, sin nombre ni número.

## Bandeja (1.7.0-alpha.74)
- Las conversaciones pendientes, hechas y descartadas salen en la Bandeja junto al correo, en la misma lista, con
  el distintivo «WhatsApp» y la etiqueta de la regla si la tiene. Las pestañas suman las dos fuentes; el filtro
  «Fuente» (Todas, Correo, WhatsApp) solo aparece con el módulo encendido y una clave guardada. El buscador mira el
  nombre, la etiqueta y el resumen, nunca el número.
- «Hecho», «Descartar» y «Volver a Pendientes»; una conversación vuelve sola cuando recibes algo nuevo.
  «Archivar todo lo que hay ahora» pasa también las conversaciones pendientes a «Hechos» (decisión del usuario,
  19/11/2026), en la misma operación que el correo y solo si la Bandeja las enseña (módulo encendido y clave guardada).
- «Ver mensajes» enseña los últimos 10 mensajes tal como los guarda AgoraOne, como texto plano: no pide nada a
  Zernio y no puede marcar nada como leído. Lo no entregado sale como «Mensaje no disponible» y los adjuntos solo
  por su tipo.
- Acciones, con los mismos formularios que el correo: «Añadir a la nota del proyecto» (si hay cliente), «Crear
  evento…» (si hay fechas o es una cita; la conversación pasa a «Hechos»), y solo de lo normal «Crear issue…»,
  «Llevar a Orca…» y la nota en el repositorio. La nota lista por tipo y número los adjuntos que ha mandado el
  contacto en los últimos 30 mensajes, sin descargarlos. Orca recibe solo los mensajes que ya cubrió la
  clasificación (nunca lo llegado después), como datos delimitados y tapando lo que parece un teléfono o un enlace
  (es texto libre: se tapa lo que tiene esa forma). El núcleo vuelve a comprobar el nivel en cada acción y justo
  antes de lanzar (`chat_inbox.level_of`), con las reglas de ese momento aplicadas a todos los mensajes: una palabra
  que hace privada la conversación la frena aunque el mensaje aún no esté clasificado. Con el módulo apagado no
  sale nada de una conversación.
- El cliente sale del directorio unificado por el número, con sus proyectos activos; lo privado, sin cliente.
- Modo discreto: se ven el distintivo, la clase y el nombre; se ocultan el número, el resumen y los mensajes.
- En WhatsApp no se borra, archiva ni cambia nada.

## Responder (1.7.0-alpha.75)
- «Responder…» en una tarjeta pendiente abre el texto, con un contador hasta 4096 caracteres (el límite de
  WhatsApp) y sin adjuntos. Solo en lo normal hay «Indicaciones para Watson» y «Redactar con Watson»: Watson lee los
  últimos mensajes como dato delimitado (sin teléfonos ni enlaces), con tus indicaciones aparte, y solo propone el
  texto; no tiene ninguna herramienta de envío. En lo «solo en este Mac» y lo privado escribes tú, y el núcleo
  rechaza redactarlo aunque se fuerce.
- La vista previa enseña a quién va (en lo privado, solo «Conversación privada»), desde qué número, el texto exacto,
  «Adjuntos: ninguno», la ventana de 24 h, el aviso de que responder puede marcar como leídos sus mensajes
  anteriores (decisión del usuario, 19/11/2026) y el coste de Meta. El servidor la sella (`sha256` de la cuenta de
  Zernio, la conversación, el último mensaje recibido y el texto normalizado), así que el mismo texto se puede volver a
  enviar cuando la persona escribe algo nuevo (decisión del usuario, 19/11/2026).
- «Enviar» manda el borrador y el sello. El núcleo comprueba que el sello coincide; que la conversación sigue en la
  Bandeja con el módulo encendido y la cuenta activa; que no ha llegado nada nuevo desde la vista previa (si llega,
  avisa «Ha llegado un mensaje nuevo: revisa antes de enviar» y pide otra vista previa); y, **justo antes**, que a la
  ventana le queda al menos un minuto. Después reserva el sello en una sola transacción de escritura: si ya se envió,
  se está enviando o quedó sin saber si llegó, se niega, también con dos núcleos sobre la misma base. Hace una sola petición
  (`POST /v1/inbox/conversations/{id}/messages` con `accountId`, `message` e `Idempotency-Key`), sin reintentos.
- Ventana de 24 h: Zernio no la expone; se cuenta desde el último mensaje **recibido** que guarda AgoraOne, con la
  hora de WhatsApp (un mensaje sin ella no cuenta), que nunca es más nueva que la real (el cálculo sale conservador). Lo que escribes no la abre. Cerrada, la tarjeta desactiva
  «Vista previa» y «Enviar» y explica que WhatsApp solo deja responder con plantillas aprobadas, que AgoraOne no envía.
- Un rechazo (ventana cerrada para Meta, número que no puede recibir, demasiados mensajes seguidos, clave caducada,
  límite de peticiones o saldo de Zernio) se explica sin la clave ni la respuesta en bruto, y se puede volver a
  pulsar a mano. Un tiempo agotado o un error del servidor deja el resultado como **desconocido**: no se reintenta,
  ese envío queda bloqueado y se pide comprobarlo en el móvil o con «Leer ahora». Otro texto se puede enviar enseguida,
  con ese aviso a la vista (decisión del usuario, 19/11/2026). Si el Llavero no deja leer la clave, se dice y no sale nada.
- Cada intento queda en el registro de acciones (`chat.send`, con el sello, la conversación y el resultado; nunca el
  texto ni la clave), con un motivo legible. Antes de la petición se anota como «enviando», así que si el núcleo se
  parase a medias ese envío también queda bloqueado. En la Actividad, un envío desconocido sale como «Desconocido»,
  con «comprueba en el móvil si llegó». Enviado, la tarjeta pasa a «Hechos»; el mensaje enviado llega con la siguiente
  lectura (sin duplicar, por su id) y no reabre la tarjeta.
- Nada más se envía: ni el indicador de «escribiendo», ni el de leído, ni reacciones, ni plantillas.
- Modo discreto: «Responder…» se desactiva.
- **Coste de Meta** (aviso en Ajustes › WhatsApp, según su página de precios el 19/11/2026): cada respuesta es un
  mensaje de servicio; desde el 01/10/2026 Meta da 1.000 gratis al mes por número y cobra desde el 1.001, y sin
  método de pago en la cuenta de Meta los que pasan de esos 1.000 no se entregan.

## Watson y portada (1.7.0-alpha.76)
- `consultar_bandeja` incluye WhatsApp con el módulo encendido (parámetro `fuente`: todas, correo o whatsapp). Watson
  solo ve lo **normal ahora** (nivel guardado, de la cuenta, de la regla guardada y de las reglas que casan hoy): lo
  «solo en este Mac» y lo privado no aparecen, ni contados. De cada conversación ve el id, el contacto por su nombre o
  etiqueta (nunca el número), el cliente, la fecha, el resumen, lo que piden, importes, fechas, ámbito, estado y si la
  ventana de 24 h está abierta; **nunca el texto de los mensajes**, y lo que parezca un teléfono o un enlace se tapa.
  «¿Qué me ha escrito X?» busca también en lo hecho.
- `proponer_respuesta_whatsapp` (módulo WhatsApp, solo Claude) guarda una propuesta para una conversación que Watson
  haya visto, normal, con la ventana abierta y un texto de hasta 4096 caracteres sin líneas con pinta de clave. La
  tarjeta del chat (de Watson y de la Bandeja) enseña contacto, resumen y texto, con «Revisar y enviar…» y
  «Descartar». «Revisar y enviar…» gasta la propuesta (`POST /assistant/proposals/{id}/chat-reply`, que no envía) y
  abre el compositor de «Responder» con ese texto: vista previa sellada y «Enviar», como desde la tarjeta. Watson no
  tiene herramienta de envío y un «sí» en el chat no envía nada.
- Anuncio al abrir el chat (decisión del usuario, 19/11/2026): las conversaciones pendientes de clase cliente,
  incidencia, cita, factura o pago, o de un cliente del directorio, una sola vez cada una (`chat_summary.announced_at`,
  migración `0035_chat_announced.sql`; algo nuevo recibido la vuelve a anunciar). Lo privado sale sin nombre, y en modo
  discreto ningún detalle, tampoco en la nota tras responder. «Sí» la marca como hecha y «no» la descarta, sin modelo.
  Si la parte de WhatsApp falla, el anuncio sigue devolviendo los correos.
- Con el correo apagado y WhatsApp encendido, Watson sigue viendo WhatsApp y proponiendo respuestas (decisión del
  usuario, 19/11/2026): `consultar_bandeja` solo se oculta con los dos módulos apagados y cada parte mira su módulo.
- La lista de la Bandeja, la portada y el anuncio usan el nivel de ahora, con las reglas que casan hoy: una regla nueva
  que vuelve privada una conversación quita al momento su nombre, su cliente y su resumen.
- Portada (decisión del usuario, 19/11/2026): un solo bloque «Mensajes recibidos» con correo y WhatsApp mezclados por
  fecha, con distintivo «WhatsApp», contacto, hora, clase, resumen y lo que piden, y el mismo tope que el correo. En
  modo discreto solo lo normal y sin resumen ni peticiones. Con el módulo apagado no se pide nada.

Código: `core/agora_core/zernio.py`, `chat_sync.py`, `routes_chat.py`, `chat_rules.py`, `chat_inbox.py`,
`chat_summarizer.py`, `chat_send.py`, `routes_chat_send.py`, `brain_chat.py`, migraciones `0030_chat.sql`, `0031_chat_summary.sql` y `0035_chat_announced.sql`, `src/settings/settings-whatsapp.tsx`,
`settings-whatsapp-rules.tsx`, `src/inbox/chat-card.tsx`, `chat-reply.tsx`, `chat-reply-text.ts`, `inbox-cards.ts`, `src/assistant/chat-reply-proposals.tsx` y `src/home/home-parts.tsx`.
Pruebas: `core/tests/test_zernio.py`, `test_chat_sync.py`, `test_chat_inbox.py`, `test_chat_bandeja.py`, `test_chat_send.py`, `test_brain_chat.py`,
`src/inbox/inbox-cards.test.ts`, `chat-reply.test.ts`, `card-actions.test.ts`, `src/home/received.test.ts` y
`scripts/verify-inbox.mjs` (con datos de ejemplo; `VERIFY_LIVE=1` añade la lectura de la app en marcha).
