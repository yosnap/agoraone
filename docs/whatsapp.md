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
- Solo lectura, por sondeo cada 5 minutos y con «Leer ahora»; nada de webhooks ni puertos abiertos.
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
- En WhatsApp no se borra, archiva ni cambia nada. Responder llega en la fase siguiente.

## Pendiente
Responder con vista previa y Watson: ver el plan `plans/261118-0155-whatsapp-zernio-e-instinct/plan.md`.

Código: `core/agora_core/zernio.py`, `chat_sync.py`, `routes_chat.py`, `chat_rules.py`, `chat_inbox.py`,
`chat_summarizer.py`, migraciones `0030_chat.sql` y `0031_chat_summary.sql`, `src/settings/settings-whatsapp.tsx`,
`settings-whatsapp-rules.tsx`, `src/inbox/chat-card.tsx` e `inbox-cards.ts`. Pruebas: `core/tests/test_zernio.py`,
`test_chat_sync.py`, `test_chat_inbox.py`, `test_chat_bandeja.py`, `src/inbox/inbox-cards.test.ts`, `card-actions.test.ts` y
`scripts/verify-inbox.mjs` (con datos de ejemplo; `VERIFY_LIVE=1` añade la lectura de la app en marcha).
