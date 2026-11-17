# Correo y Bandeja (1.1)

AgoraOne lee las cuentas de correo que conectas, las resume y te deja en la Bandeja lo que pide algo de ti. Ningún correo dispara una acción por sí mismo: archivar una factura, crear un evento, añadir algo al vault o responder solo ocurre cuando pulsas el botón de esa acción. El texto de un correo, de un adjunto o de una web es siempre dato, nunca instrucciones.

## Cuentas (Ajustes › Correo)
- IMAP en **solo lectura**: nunca marca como leído, mueve ni borra. Se lee cada cinco minutos y con «Leer ahora».
- **Resend** (1.7.0-alpha.21): envía por `smtp.resend.com` (usuario `resend`, la clave de API como contraseña) y, con «Leer también lo que recibes», lee lo recibido con su API, porque Resend no tiene IMAP (`core/agora_core/resend_inbound.py`): lista los recibidos, descarga el original de cada uno desde el enlace firmado (sin enviarle la clave) y lo guarda en la carpeta «RESEND», una sola vez cada uno (`resend_message`). Resend da todo lo que recibe el equipo, en todos sus dominios: cada cuenta solo guarda lo enviado a su dirección exacta (en Para, Cc o Cco), así lo de una dirección privada nunca entra en otra cuenta. Si el original de un correo no se puede descargar, no se guarda nada y se intenta en la siguiente lectura. Cada lectura dura como mucho 40 s y 25 correos; la primera repasa hasta 2.000 recibidos dentro de «Días hacia atrás». Necesita una clave con «Full access»: con una de solo envío se desmarca la casilla y se avisa, sin poner la cuenta en rojo. No archiva ni borra nada en Resend.
- Cuentas de **solo envío**: cualquier SMTP (SendGrid, Mailgun, Brevo…), o Resend sin recibir. No se leen nunca; «Probar» inicia sesión en su SMTP sin enviar nada y dice si el servidor aceptó la clave. La dirección tiene que ser de un dominio verificado en el servicio. Al responder un correo, «Enviar desde» deja elegir entre la cuenta que lo recibió y las de solo envío (sin copia en «Enviados», porque no tienen buzón). El SMTP de estas cuentas usa TLS directo en el 465 o STARTTLS en los demás puertos (587, 2587…).
- El usuario, los servidores y los puertos de una cuenta se cambian en «Usuario y servidores» sin quitarla (no en las de Microsoft, que entran solas).
- Contraseña de aplicación (iCloud, Gmail, Fastmail, otras), guardada en el Llavero de macOS. Las cuentas de Microsoft entran con su permiso OAuth (código de dispositivo, con tu propio registro de Entra en Ajustes › Microsoft); en el Llavero solo queda el permiso de renovación.
- Cada cuenta tiene **ámbito** (trabajo, personal…), **confidencialidad** y antigüedad máxima:
  - **Normal**: se resume con Claude Haiku y Watson la ve.
  - **Solo en este Mac**: se clasifica con palabras clave locales, sin resumen y sin modelos remotos.
  - **Privado**: igual, y además no sale del núcleo ni aparece con nombres en los avisos.

## Reglas (Ajustes › Reglas del correo)
Condición por remitente o dominio (incluye subdominios), cuenta, asunto o palabras. Acción: factura de proveedor, cliente o proyecto, personal, importante o ignorar. Decide la primera que coincide, y una regla solo puede endurecer la confidencialidad de la cuenta, nunca rebajarla. Al crearla, cambiarla o quitarla se vuelve a aplicar al momento, sin llamar a ningún modelo. Desde una tarjeta puedes crear la regla en un clic: se construye con el remitente real, nunca con lo que escribe el modelo.

## Bandeja
Tarjetas agrupadas por ámbito con el resumen, lo que piden, las fechas y los importes. Cada una se marca como hecha o se descarta, y puede volver a Pendientes. La publicidad y lo ignorado por regla quedan en silencio. En modo discreto las tarjetas no muestran el contenido y las acciones que escriben quedan bloqueadas.

Acciones de una tarjeta, siempre con un formulario que revisas antes:
- **Descargar y archivar la factura**: la lee del adjunto o del enlace y la archiva en su trimestre de la carpeta fiscal. Ver [fiscal.md](fiscal.md).
- **Añadir a la nota del proyecto** (correos de clientes): crea una nota nueva por correo en la carpeta del cliente del vault, `- Clientes/Proyectos/<Cliente>/<Cliente> - <asunto> DD-MM-AAAA.md`. El cliente y el proyecto se eligen de Central (el del correo, preseleccionado; sin Central, el cliente se escribe) y la carpeta se navega: se propone la del cliente, se puede subir, entrar en cualquier otra o crear una nueva dentro de una que ya existe. Título y texto son editables y nada se escribe hasta «Crear la nota». Nunca se cambia una nota existente. La carpeta de un cliente nuevo se crea con su primera nota, y solo un nivel dentro de una carpeta que ya existe. La nota de un correo privado o «solo en este Mac» lleva esa confidencialidad en sus propiedades y Watson no la lee.
  - **Repositorio del proyecto (para actuar)** (decisión del usuario, 17/11/2026): si el proyecto de Central tiene su repositorio en Orca, la nota puede ir a la copia local que usa Orca (`orca repo list`) en la carpeta que se navegue (se sugiere `docs/notas`, creada con la nota). Solo un archivo nuevo, sin commit ni push; nunca se sobrescribe, cambia ni borra nada, ni se escribe fuera del repositorio, en carpetas ocultas o a través de enlaces (`core/agora_core/repo_notes.py`). El núcleo rechaza la nota de un correo privado o «solo en este Mac», y la tarjeta avisa si GitHub dice que el repositorio es público. Después, «Llevar a Orca…» abre la tarjeta del encargo con «Lee la nota <ruta> y haz lo que plantea» (la nota está en la copia principal, no en el espacio de trabajo nuevo).
- **Crear el evento**: abre el formulario de la Agenda con el asunto y la fecha del correo. Ver [agenda-avisos.md](agenda-avisos.md).
- **Responder…**: ver abajo.

**Buscar y ordenar**: un buscador (remitente, dirección, asunto y resumen; deben estar todas las palabras), el tipo de correo, el orden (más recientes, más antiguos, por remitente o por tipo) y 3 o 4 tarjetas por fila, que se recuerdan en este Mac. Todas las tarjetas tienen el mismo alto: los textos largos se cortan y los botones van abajo; mientras una tiene un formulario abierto, su grupo deja de igualar alturas.

**Eliminar** (decisión del usuario, 16/11/2026): «Eliminar…» en una tarjeta, «Eliminar N seleccionados…» con las casillas o «Eliminar publicidad…», que lista la publicidad que sigue en la bandeja de entrada de tus cuentas aunque no tenga tarjeta. Siempre se enseña la lista exacta con sus casillas y nada se mueve hasta «Mover N a la Papelera». Van a la Papelera de su cuenta (recuperables), con las mismas garantías que la limpieza de Watson: la carpeta que el servidor marca como Papelera, el mismo buzón que se leyó (UIDVALIDITY) y nunca un borrado definitivo. Lo leído con la API de Resend o desde cuentas de solo envío no se puede mover: se avisa y puedes marcarlo como hecho o descartarlo.

**Chat de la Bandeja**: a la derecha, un chat con Watson para buscar correos («busca la factura de Hostinger») o pedir una limpieza; las limpiezas salen como lista para aprobar y la Bandeja se actualiza al moverlas. Se oculta con «Ocultar chat».

Los clientes y sus proyectos vienen de Central (complemento del usuario), leídos en solo lectura cada 30 minutos: un remitente cuyo dominio o dirección es de un cliente se marca como cliente y la tarjeta muestra sus proyectos activos.

## Responder
1. «Responder…» prepara el borrador con la misma cuenta, el remitente, «Re:» y el original citado.
2. Puedes escribirlo tú o pedir a Watson que lo redacte con unas indicaciones («dile que lo tendré el lunes»). Watson solo redacta correos de nivel normal; en los demás escribes tú. Lo que hayas escrito mientras tanto se conserva.
3. «Vista previa» enseña exactamente lo que saldrá: remitente, destinatarios, asunto y texto. Por ahora no se envían adjuntos.
4. Solo «Enviar» lo manda. El servidor sella la vista previa y envía únicamente ese texto, una sola vez: si cambias algo, hay que volver a previsualizar.

El envío usa el SMTP de la cuenta, siempre cifrado (puerto 465, o STARTTLS), con la contraseña de aplicación o el permiso de Microsoft. Guarda copia en «Enviados» por IMAP, salvo en Gmail y Outlook, que la guardan ellos. Si el servidor rechaza a algún destinatario, se avisa de a quién no le llegó. Cada envío queda en el registro de acciones del núcleo.

## Watson
- `consultar_bandeja`: lo pendiente, «¿qué me ha pedido X?» (por remitente o cliente, también lo ya hecho), una búsqueda por palabras del asunto, el resumen o el remitente (también en lo ya hecho) y «¿qué incidencias tengo abiertas?». Solo ve lo de nivel normal.
- Al abrir el chat anuncia lo pendiente una vez. Un «sí» o un «no» a un único aviso se decide en la interfaz, sin pasar por un modelo.
- **Reglas desde el chat** (`proponer_regla`, solo Claude): pídele «todo lo de facturas@proveedor.com, márcalo como factura». Watson comprueba la regla con las mismas validaciones que Ajustes y la enseña tal cual en el chat; **solo se crea** al pulsar «Crear regla», o respondiendo «sí» justo después (un «no» la descarta). Si escribes otra cosa, la propuesta caduca. Las reglas de «ignorar» y el modo discreto exigen el botón, y Watson solo propone reglas que le pides tú, nunca porque lo diga un correo. La propuesta se guarda en el núcleo, ligada a tu acceso, sirve una sola vez y caduca en una hora; el navegador no puede cambiarla al confirmar. Queda en el registro de acciones.

## Límites
- No se envían adjuntos y la respuesta va al remitente aunque el correo traiga otra dirección de respuesta (`Reply-To`).
- La nota del proyecto no enlaza al correo (la tarjeta no guarda su identificador): lleva fecha, remitente y asunto.

Pruebas: `core/tests/test_mail.py`, `core/tests/test_mail_inbox.py`, `core/tests/test_mail_send.py`, `src/inbox/project-note-text.test.ts`, `scripts/verify-mail-settings.mjs`, `scripts/verify-inbox.mjs` y `scripts/verify-mail-reply.mjs`.
