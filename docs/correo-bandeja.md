# Correo y Bandeja (1.1)

AgoraOne lee las cuentas de correo que conectas, las resume y te deja en la Bandeja lo que pide algo de ti. Ningún correo dispara una acción por sí mismo: archivar una factura, crear un evento, añadir algo al vault o responder solo ocurre cuando pulsas el botón de esa acción. El texto de un correo, de un adjunto o de una web es siempre dato, nunca instrucciones.

## Cuentas (Ajustes › Correo)
- IMAP en **solo lectura**: nunca marca como leído, mueve ni borra. Se lee cada cinco minutos y con «Leer ahora».
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
- **Añadir a la nota del proyecto** (correos de clientes): crea una nota nueva por correo en la carpeta del cliente del vault, `- Clientes/Proyectos/<Cliente>/<Cliente> - <asunto> DD-MM-AAAA.md`. Cliente, proyecto, carpeta, título y texto son editables y nada se escribe hasta «Crear la nota». Nunca se cambia una nota existente. La carpeta de un cliente nuevo se crea con su primera nota, y solo un nivel dentro de una carpeta que ya existe. La nota de un correo privado o «solo en este Mac» lleva esa confidencialidad en sus propiedades y Watson no la lee.
- **Crear el evento**: abre el formulario de la Agenda con el asunto y la fecha del correo. Ver [agenda-avisos.md](agenda-avisos.md).
- **Responder…**: ver abajo.

Los clientes y sus proyectos vienen de Central (complemento del usuario), leídos en solo lectura cada 30 minutos: un remitente cuyo dominio o dirección es de un cliente se marca como cliente y la tarjeta muestra sus proyectos activos.

## Responder
1. «Responder…» prepara el borrador con la misma cuenta, el remitente, «Re:» y el original citado.
2. Puedes escribirlo tú o pedir a Watson que lo redacte con unas indicaciones («dile que lo tendré el lunes»). Watson solo redacta correos de nivel normal; en los demás escribes tú. Lo que hayas escrito mientras tanto se conserva.
3. «Vista previa» enseña exactamente lo que saldrá: remitente, destinatarios, asunto y texto. Por ahora no se envían adjuntos.
4. Solo «Enviar» lo manda. El servidor sella la vista previa y envía únicamente ese texto, una sola vez: si cambias algo, hay que volver a previsualizar.

El envío usa el SMTP de la cuenta, siempre cifrado (puerto 465, o STARTTLS), con la contraseña de aplicación o el permiso de Microsoft. Guarda copia en «Enviados» por IMAP, salvo en Gmail y Outlook, que la guardan ellos. Si el servidor rechaza a algún destinatario, se avisa de a quién no le llegó. Cada envío queda en el registro de acciones del núcleo.

## Watson
- `consultar_bandeja`: lo pendiente, «¿qué me ha pedido X?» (por remitente o cliente, también lo ya hecho) y «¿qué incidencias tengo abiertas?». Solo ve lo de nivel normal.
- Al abrir el chat anuncia lo pendiente una vez. Un «sí» o un «no» a un único aviso se decide en la interfaz, sin pasar por un modelo.

## Límites
- No se envían adjuntos y la respuesta va al remitente aunque el correo traiga otra dirección de respuesta (`Reply-To`).
- La nota del proyecto no enlaza al correo (la tarjeta no guarda su identificador): lleva fecha, remitente y asunto.

Pruebas: `core/tests/test_mail.py`, `core/tests/test_mail_inbox.py`, `core/tests/test_mail_send.py`, `src/inbox/project-note-text.test.ts`, `scripts/verify-mail-settings.mjs`, `scripts/verify-inbox.mjs` y `scripts/verify-mail-reply.mjs`.
