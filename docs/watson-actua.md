# Watson que actúa (1.7 y 1.8)

Plan: `plans/261115-2240-watson-actua/plan.md`. Decisión del usuario del 15/11/2026, recogida en `AGENTS.md`:
Watson propone y el usuario confirma cada acción viendo exactamente qué se hará. Nada se ejecuta sin pulsar el
botón de la tarjeta. Watson solo lo usa cuando el usuario se lo pide, nunca porque lo diga un correo o una nota.

## Qué puede proponer

| Herramienta | Qué aparece en la pantalla | Al confirmar |
|---|---|---|
| `proponer_nota` | Título y carpeta editables, vault y texto completo | La nota se crea por la ruta del vault: nunca sobrescribe. Rechaza notas con contraseñas. |
| `proponer_evento` | Título, fecha, lugar y calendario | El evento se crea en el calendario elegido; si se solapa con otro, avisa y pide «Crear igualmente». |
| `proponer_presupuesto` | Cliente, partidas, base, IVA y total | Se crea en Central como borrador por su API (`POST /api/v1/presupuestos`). Se envía desde Central. Solo con el módulo Presupuestos encendido. |
| `proponer_limpieza` | La lista de correos de la bandeja de entrada, cada uno con su casilla | Solo los marcados se mueven al archivo o a la Papelera de su cuenta. |
| `proponer_reorganizacion` | Un lote de hasta 40 notas para mover o renombrar, cada una con su casilla, su motivo y el aviso de enlaces que se romperían | Solo los cambios marcados, uno a uno, por la ruta de mover del vault. |
| `proponer_regla` (1.2) | La regla del correo tal cual | Se crea la regla. |
| `proponer_investigacion` (1.8) | La pregunta y el alcance, editables, con los topes de Ajustes | Se lanza la investigación en internet aparte de la conversación (ver «Watson y la web»). |
| `proponer_encargo_hermes` (1.8) | El perfil y el texto exacto del encargo, editables | Se abre una conversación con ese perfil y se le envía el encargo (ver «Encargos a perfiles de Hermes»). |

Además, si se le pide una **ficha de cliente**, Watson reúne lo que sabe por Central, la Bandeja y el cerebro, y
la propone como nota en «Clientes/<Nombre>». La ficha tiene siempre las mismas secciones: resumen, contacto,
proyectos, correos, reuniones, tareas y próximos pasos.

## Presupuestos

El módulo Presupuestos (entrada «Presupuestos», justo antes de «Central») lee los presupuestos de Central por su
API con una clave que tenga el permiso `presupuestos`, aunque el módulo Central esté apagado
(`core/agora_core/central_quotes.py`, `routes_quotes.py`, `src/quotes/`). Sin conexión o sin ese permiso, la
sección lo explica y lleva a Conectores › Central. Con el módulo apagado no aparece en el menú, sus rutas responden 404
y Watson no ve `proponer_presupuesto`.

- Lista con número, cliente, título, estado y total con IVA, con filtros por cliente (exacto) y estado; ficha con
  partidas, hitos de pago con su importe, base, IVA y total.
- «Abrir PDF» y «Abrir Word»: el núcleo descarga el documento (solo `application/pdf` o Word, como mucho 20 MB) a
  `<datos>/central-documentos/`, con un nombre hecho solo del número de Central, y lo abre con el programa del
  sistema (`open`, `explorer` o `xdg-open`). Al arrancar se borran los de más de un día. La pantalla nunca ve la
  dirección de Central ni la clave.
- «Nuevo borrador»: cliente de Central del directorio, título, partidas desde las tarifas o a mano, hitos, alcance.
  «Crear en Central» enseña exactamente lo que se creará y solo «Confirmar y crear el borrador» lo envía. El núcleo
  lo comprueba con el esquema de Central y lo manda tal cual; un cliente solo propio se rechaza («Ese cliente no
  está en Central»). Un token por formulario, ligado al contenido enviado, impide crear dos con una doble pulsación o
  dos envíos a la vez (si cambia el contenido, es otro borrador); si no se sabe si Central lo creó, no se repite
  hasta volver a leer la lista. Las confirmaciones de Watson también se retiran antes de esperar. Siempre en
  borrador: nunca se envía un presupuesto.
- Hitos de pago: con una clave con los permisos `escritura` y `presupuestos`, el estado y la fecha prevista de cada
  hito se cambian desde la ficha del presupuesto, como los cambios de Central (abajo). Watson no lo propone.

## Cambios en Central desde sus fichas

Con una clave de Central con el permiso `escritura` (que lleva `lectura`), las fichas de la sección Central cambian
los datos de un cliente, añaden notas a un cliente o a un proyecto y cambian el estado y la fase de un proyecto; en
Trabajos › Clientes, «Crear en Central» da de alta en Central un cliente que solo está en AgoraOne y lo enlaza con el
propio (se ve una sola vez); antes lee los clientes de Central en ese momento y, si ya hay uno con el mismo nombre, NIF o
correo, ofrece «Enlazar con el existente» en vez de crear otro. Lo hace el usuario desde la ficha, nunca Watson ni un correo o un mensaje: Watson sigue
limitado a proponer borradores de presupuesto (`proponer_presupuesto`) y no tiene ninguna herramienta que llegue a
estas rutas (`core/agora_core/central_write.py`, `routes_central_write.py`, `src/central/central-change.tsx`).

- «Revisar el cambio» enseña el cambio exacto, campo a campo («Ahora en Central» y «Después»), leído en ese momento de
  Central y comprobado contra la versión de la ficha que se editó; vaciar un dato de contacto se avisa. Solo «Guardar
  en Central» lo envía, exactamente ese cuerpo y con esa versión, y solo a la misma Central de la vista previa, guardado en el núcleo con un token de un solo uso
  que se reserva antes de esperar nada: una doble pulsación o dos envíos a la vez escriben una sola vez.
- El formulario parte de los datos tal como los guarda Central (no de la copia que se muestra, con rutas e IP ocultas):
  un valor con «[ruta oculta]» o «[IP oculta]» no se guarda, y un valor que es solo el principio del actual se avisa como
  recortado. Correo y topes se comprueban como Central (topes en unidades UTF-16).
- Si alguien lo cambió en Central mientras tanto, Central responde 409 y no cambia nada: se ve lo que hay ahora y
  «Volver a revisar» vuelve a leer la ficha. Nada se reintenta solo. Si Central está ocupada, se puede pulsar otra vez;
  si un alta se queda sin respuesta, se avisa de que puede haberse creado y de revisarlo en Central antes de repetirlo.
- Nunca se borra nada. Archivar un proyecto o dejar de fijar su estado se hace en Central (quita auditorías, alertas
  y su monitor de Uptime Kuma); un estado fijado a mano sigue fijado y uno sin fijar se puede fijar.
- Sin el permiso, los botones no aparecen y la ficha explica cómo crear la clave en Ajustes › Apps conectadas de
  Central. Con el módulo Central apagado (o Presupuestos, para los hitos), las rutas responden 404. En modo discreto no
  hay botones de cambio. El registro de acciones apunta qué se cambió por nombre de campo, nunca los valores.
- Lo demás de cada cliente, proyecto, servidor, web, alerta o presupuesto se hace con «Abrir en Central», que abre
  su página exacta en la ventana de Central (o en el navegador sin la app de escritorio).
- En modo discreto se ocultan importes, clientes, títulos, proyectos y notas, y no se crean borradores ni se abren
  documentos.
- Si el documento ya está abierto (Word en Windows no deja sustituirlo), se reutiliza si es igual o se guarda con
  «-2», «-3»…; nunca con un nombre reservado de Windows.

## Limpieza del correo

Esto amplía, solo para esta acción confirmada, el correo en solo lectura (`core/agora_core/mail_cleanup.py`):

- Únicamente entran los correos de la bandeja de entrada que encajan con lo pedido (remitente, tipo, asunto,
  antigüedad o cuenta), como mucho 200. Solo se mueven los que el usuario deja marcados.
- El destino es la carpeta que el servidor marca como Papelera (`\Trash`) o como Archivo (`\Archive`; en Gmail,
  «Todos», `\All`).
- Antes de mover nada se comprueba que el buzón no se haya renumerado (UIDVALIDITY).
- Para mover se usa `MOVE`; si el servidor no lo tiene, se usa `UID COPY` y `UID EXPUNGE` solo de esos correos.
  Si no permite ninguna de las dos, no se toca nada.
- Nunca hay borrado definitivo ni se marca nada como leído.
- Lo movido queda anotado (migración 0023) y sale de la Bandeja.

## Revisar el vault

El botón «Revisar el vault», junto a las Áreas del Cerebro, abre un informe que no cambia nada
(`core/agora_core/vault_review.py`). Muestra:

- notas sueltas en la raíz;
- notas huérfanas;
- títulos repetidos;
- notas casi vacías;
- carpetas con una sola nota, demasiado llenas o demasiado profundas;
- notas con credenciales ocultas. De estas solo se ve el título: el índice ya guarda esas líneas como
  «[credencial omitida]» y nunca llegan a un modelo.

## Reordenar el vault

Desde «Revisar el vault», el botón «Pedir a Watson que lo ordene» le pide un primer lote; también se le puede
pedir en el chat. Watson mira el vault con `revisar_vault` (carpetas con su recuento y las notas sueltas,
huérfanas, repetidas o casi vacías) y propone con `proponer_reorganizacion` (`core/agora_core/vault_reorg.py`):

- Solo ve y puede nombrar notas normales, por el número que se le dio; lo privado y lo de solo en este Mac no
  entra nunca en la propuesta.
- El destino es una carpeta que ya existe, la raíz o una carpeta nueva dentro de una que exista (nunca una nueva
  en la raíz). No se aceptan dos cambios de la misma nota ni un destino donde ya hay otra con ese título.
- Si renombra una nota que otras enlazan por su título, la tarjeta avisa de cuántos enlaces dejarán de funcionar:
  AgoraOne no reescribe enlaces.
- Al pulsar «Aplicar», cada nota marcada se vuelve a leer para su revisión y se mueve con la ruta del vault: copia
  previa, mismo archivo (Obsidian conserva su fecha), nunca pisa otra nota y nunca borra. La tarjeta muestra el
  resultado de cada una; un fallo no detiene las demás.

## Watson y la web (1.8)

Decisión del usuario del 20/11/2026, recogida en `AGENTS.md`. Plan: `plans/261120-0251-watson-web-y-hermes/plan.md`.

**Direcciones pegadas por el usuario.** Si el último mensaje que escribe el usuario lleva direcciones web (como mucho
3), el núcleo las lee antes de responder con su propio lector (`core/agora_core/web_page.py`): solo `https` y `http`
públicos, nunca este Mac ni la red local (se comprueba la dirección resuelta en cada redirección, como mucho 5), sin
cookies ni credenciales, 2 MB y 25 s por página, HTML, texto o PDF, y hasta 40 000 caracteres. El texto llega a
Watson delimitado como dato de terceros, nunca como instrucciones. Las direcciones de un correo, una nota, un mensaje
o de la propia página nunca se abren solas. Watson no tiene red propia.

**Investigación.** Cuando el usuario pide investigar o buscar información actual, Watson propone
`proponer_investigacion`. No se busca nada hasta pulsar «Investigar». Entonces corre un turno aparte:

- Sin el historial de la conversación ni las herramientas privadas (correo, WhatsApp, clientes, agenda, reuniones,
  Orca, Hermes). Solo tiene las notas normales del cerebro (`buscar_en_cerebro`, `leer_nota`), `proponer_nota` y la web.
- Busca con los servidores de Anthropic: la herramienta `web_search` de la API, con tope exacto de búsquedas, o
  `WebSearch` de Claude Code, con tope aproximado porque no deja contarlas. El proveedor compatible no tiene
  buscador y solo lee las direcciones que vengan en la pregunta.
- Las páginas las lee el lector del núcleo (`leer_pagina`), nunca `WebFetch`. Solo abre direcciones que salieron en
  los resultados de búsqueda o en la pregunta, copiadas tal cual: el modelo no puede inventar una ni añadirle nada,
  así que una página no puede hacer que los datos de las notas salgan en una dirección (decisión del usuario: notas
  sí, web acotada).
- Topes en Ajustes › Asistente: búsquedas (5), páginas (6) y minutos (4). Si se superan los minutos, la investigación
  se corta y lo dice. Si el motor falla, no se pasa a otro.
- El resultado es un informe en Markdown con resumen, hallazgos con su fuente, dudas y fuentes. Al final propone
  guardarlo con `proponer_nota` en «Investigaciones», y solo se guarda si el usuario lo confirma. En las respuestas
  siguientes de esa conversación el informe llega a Watson marcado como dato de terceros.
- Lo que Watson pone en una búsqueda llega al buscador de Anthropic. Tiene la instrucción de no meter datos de las
  notas que no estén ya en la pregunta: es una instrucción, no un bloqueo.

## Encargos a perfiles de Hermes (1.8)

Watson puede proponer un encargo para un perfil de Hermes con `proponer_encargo_hermes` (perfil y texto exacto,
hasta 4000 caracteres). El núcleo nunca habla con Hermes: la tarjeta, al pulsar «Enviar a <perfil>», abre una
conversación con ese perfil por las rutas de chat del servidor (`/api/conversations`), donde cada herramienta que no
sea de lectura local sigue pidiendo «Permitir». La respuesta del perfil vuelve a Watson solo si el usuario pulsa
«Pasar la respuesta a Watson». Llega delimitada como dato de terceros, sin las líneas que parecen claves y cortada a
20 000 caracteres. Los perfiles se detectan como en el catálogo del servidor, comprobando solo que sus archivos
existen, sin leerlos. Ver [conversaciones-perfiles.md](conversaciones-perfiles.md).

**Watson sigue en segundo plano.** La respuesta de Watson ya no depende de que su chat esté en pantalla: si el
usuario cambia de sección o de conversación, la respuesta sigue y al volver se ve dónde va o cómo terminó, con sus
tarjetas. Responde a una pregunta cada vez (`src/assistant/live-turns.ts`).

## Watson y CRMDev (1.9)

Decisión del usuario del 20/11/2026. Solo con Claude y con el módulo CRMDev encendido y conectado
(`core/agora_core/crmdev_tools.py`):

- `consultar_crmdev` lee las tareas o los tickets más recientes por la lista cerrada (caché de 60 s): id, título,
  estado, prioridad, categoría, fecha, proyecto, empresa del cliente y un trozo de la descripción sin líneas con
  pinta de clave. Nunca correos, teléfonos ni nombres de personas (quién abrió un ticket o a quién está asignada una
  tarea). Llega con un aviso de que es dato, no instrucciones.
- `proponer_cambio_crmdev` propone una tarea nueva (en un proyecto que haya visto), un cambio de tarea (título,
  descripción, estado, prioridad) o de ticket (estado, prioridad, categoría), solo de lo que haya visto en esa
  respuesta. Se comprueba con las mismas reglas que los formularios de la sección CRMDev y abre una tarjeta en el
  chat (`src/assistant/crmdev-proposals.tsx`) con lo propuesto. «Revisar el cambio» lee CRMDev y enseña el antes y
  después exactos, y solo «Guardar en CRMDev» lo guarda, por `/crmdev/write/*` como un formulario. Un «sí» en el chat
  no guarda nada y Watson no tiene herramienta para guardar.
- El registro de acciones guarda qué lista leyó y cuántos, y la clase y los nombres de los campos propuestos; nunca
  sus valores.
- Desde el 21/11/2026 también propone una respuesta a un ticket que haya visto (`respuesta_ticket`), diciendo siempre si es
  una nota interna o una respuesta que lee el cliente; se envía solo con «Guardar en CRMDev» tras ver el texto exacto.
- Con varias organizaciones de CRMDev (decisión del usuario del 21/11/2026), `consultar_crmdev` lee todas las que
  tienen clave, una tras otra y cada una con su clave, y dice de cuál es cada registro. Con `organizacion` lee solo
  la que tiene ese nombre. Si una organización falla, se dice cuál y las demás se leen igual.
- Cada propuesta va a la organización donde Watson vio el registro; una tarea nueva, a la de su proyecto. Si el mismo
  id aparece en dos organizaciones, la propuesta se rechaza en vez de adivinar. La tarjeta dice a qué organización va,
  y la revisión lo comprueba otra vez con la clave de esa organización.

## Rutas del núcleo

| Ruta | Para qué |
|---|---|
| `POST /assistant/proposals/{id}/quote` | crear en Central el presupuesto propuesto |
| `GET /quotes`, `GET /quotes/{id}`, `GET /quotes/rates` | presupuestos y tarifas de Central |
| `POST /quotes/{id}/open?format=pdf\|docx` | descargar y abrir el PDF o el Word |
| `POST /quotes` | crear un borrador desde el formulario (con su token) |
| `GET /central/write/permissions` | si la clave puede cambiar Central y los hitos de presupuesto |
| `POST /central/write/preview` | el cambio exacto (antes y después) y su token de un solo uso |
| `POST /central/write/confirm` | enviar a Central ese cambio, una sola vez |
| `POST /assistant/proposals/{id}/mail` | mover los correos aprobados de la lista propuesta |
| `POST /assistant/proposals/{id}/dismiss` | descartar una propuesta o darla por usada |
| `GET /brain/review` | revisión del vault |
