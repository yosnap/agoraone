# Conectores (1.7)

«Conectores» es el único sitio donde se conecta cada módulo externo de AgoraOne: Central, CRMDev, Mi fábrica,
CostGuard y el MCP del cerebro. Decisión del usuario del 19/11/2026 (`AGENTS.md`). La sección se ve siempre: ya no
hay un módulo «Conectores» que se pueda apagar, y cada conector conserva el interruptor de sus propios módulos.

WhatsApp (Zernio), Jev, Qonto y las cuentas de correo no son conectores: siguen en sus pestañas de Ajustes.

## Qué es un conector

Cada conector es una entrada del registro del núcleo (`connectors.REGISTRY`) con un tipo, y cada tipo tiene un
adaptador que responde siempre con el mismo estado (`GET /connectors`):

| Tipo | Cómo se conecta | Conectores |
|---|---|---|
| `web_api` | Dirección y clave. La clave va solo al almacén de secretos del sistema (Llavero en macOS), con una cuenta propia por conector, y nunca sale en respuestas, errores, registros ni la base. | Central, CRMDev |
| `local_port` | Una web de este equipo en un puerto de `127.0.0.1`. | Mi fábrica |
| `local_file` | Un archivo de datos de este equipo, leído en solo lectura. | CostGuard |
| `guide` | Nada que conectar: la tarjeta enseña los pasos para hacerlo a mano. | MCP del cerebro |

Lo que llega de un conector es dato: nunca se interpreta como instrucciones ni dispara ninguna acción.

## La tarjeta

Todas las tarjetas tienen el mismo esqueleto:

- nombre, estado («Sin configurar», «Dirección y clave guardadas», «En marcha · responde», «No responde», «Hay que
  volver a conectarlo»…) y qué es;
- cómo se conecta y el formulario de su tipo;
- **Probar**: prueba con lo escrito o, si falta, con lo guardado. No guarda nada;
- **Guardar**: un campo vacío no cambia lo guardado. Una dirección de otro servidor, puerto o esquema exige volver
  a escribir la clave, para que la guardada nunca viaje a un servidor nuevo;
- **Olvidar…**, con confirmación: en una web API borra solo la clave y conserva la dirección y lo ya leído; en uno
  local olvida su carpeta, puerto o archivo sin tocar nada del equipo;
- los interruptores de sus módulos (Central y Presupuestos en la de Central, CRMDev en la suya, Mi fábrica en la
  suya).

Conectar, probar y olvidar funcionan con cualquier módulo apagado. Ajustes › Módulos solo lista los módulos internos
y lleva a Conectores para el resto ([instalacion-modulos.md](instalacion-modulos.md)).

## Central

Central es una app aparte del usuario y su código no se trae a AgoraOne.

- **Conexión**: solo por su API web (`/api/v1/*`), con su dirección y una clave que se crea en Ajustes › Apps
  conectadas de Central. Fuera de este equipo solo se admite https, sin seguir redirecciones. El modo antiguo por
  carpeta (con bun y stdio) está retirado.
- **Permisos de la clave**: tras «Probar», la tarjeta enseña la versión de Central y lo que permite la clave:
  - `lectura`: clientes, proyectos, webs, servidores y agenda;
  - `presupuestos`: ver y crear presupuestos en borrador;
  - `escritura`: cambiar clientes, sus notas y el estado y la fase de un proyecto, viendo antes el cambio exacto.
- **Módulos**: «Central» (la sección y la lectura de sus clientes cada 30 minutos) y «Presupuestos» (la sección y
  los borradores de Watson, que solo necesitan el permiso `presupuestos`). Se encienden y apagan por separado en la
  tarjeta. Presupuestos y lo que Watson propone están en [watson-actua.md](watson-actua.md).
- **Quien solo tenía la carpeta**: conserva la instantánea ya leída, que siguen usando la Bandeja, WhatsApp,
  Reuniones, Fiscal y Watson, y la tarjeta dice «Ahora Central se conecta con su dirección y una clave de acceso».
  Al guardar una conexión completa, el ajuste antiguo de la carpeta se borra; la instantánea se queda.
- Su web se abre en una ventana propia de la app de escritorio, nunca en un marco.

La API de Central está documentada en su propio repositorio (`docs/API.md`).

## CRMDev

CRMDev es el CRM de proyectos, tareas, tickets y clientes de la organización del usuario, otra app aparte.

### Conexión

- Dirección (por ejemplo `https://crm.example.com`) y una **clave de organización** `crm_…`, que crea un propietario o
  un administrador en Ajustes › API Keys de CRMDev. Se guarda solo en el Llavero.
- Por qué esta clave: es la que da acceso a las listas de proyectos, tareas, tickets y clientes de toda la
  organización por `/api/mcp/rest`. Las claves por proyecto no ven la lista de proyectos ni la de clientes.
- La clave tiene los permisos completos de quien la creó, también los de borrar. Por eso el núcleo solo deja salir
  una **lista cerrada** de herramientas. Lecturas: `list_projects`, `list_tasks`, `list_clients`, `list_tickets`,
  `list_members` y `get_project_time_report`. Escrituras: las de [Escrituras](#escrituras). Ninguna `delete_*` está
  en la lista, y hay una prueba que las recorre todas y comprueba que no sale ninguna petición. El transporte
  vuelve a comprobar cada petición antes de enviarla.
- «Probar» pregunta a CRMDev qué herramientas ofrece, sin ejecutar ninguna, y enseña «Conectado: organización» con
  las que usará AgoraOne. Un 403 explica que el plan de CRMDev no incluye la API (módulo MCP).
- **Límite de peticiones**: CRMDev no deja hacer muchas seguidas. Cada lista se guarda 60 s en memoria y, si CRMDev
  pide esperar (429), AgoraOne lo dice y respeta la espera sin reintentar por su cuenta.
- **Sin paginación**: CRMDev no tiene páginas, así que las listas son las 100 más recientes y la pantalla lo dice.
  Para el directorio de clientes se piden hasta 1000.
- Módulo «CRMDev»: mientras el usuario no lo toque, está encendido si hay una dirección guardada. Apagado, sale del
  menú, sus rutas responden 404 sin pedir nada, no hay lectura en segundo plano y su ventana se cierra.

### Varias organizaciones

Decisión del usuario del 21/11/2026. Una clave `crm_…` da acceso a una sola organización y la API de CRMDev no dice
cuál es, así que el usuario pone el nombre a cada una en el bloque «Organizaciones» de la tarjeta de CRMDev:

- Cada organización tiene su clave en su propia cuenta del Llavero. La primera conserva la clave de antes y se llama
  «Organización 1» hasta que el usuario la renombra. La dirección de CRMDev es la misma para todas.
- La caché de 60 s y la espera tras un 429 van por clave, y AgoraOne lee todas las organizaciones cada media hora.
- Cada cliente y cada proyecto de Central pertenece a una sola organización, y AgoraOne la recuerda. Se decide así:
  la del registro enlazado gana; si no hay enlace, la que eligió el usuario; un proyecto sin ninguna de las dos va
  con la de su cliente. Lo que no tiene organización sale en «Clientes sin organización» y «Proyectos sin
  organización», dentro de «Desde Central», cada grupo con su propio envío.
- Con más de una organización con clave, la sección CRMDev tiene un selector encima de las pestañas. Las lecturas,
  los cambios, «Lanzar en Orca» y los contadores son los de la organización elegida, con su clave. El navegador
  recuerda la elección.
- Cada revisión de un cambio o de un envío dice a qué organización va. Nada pasa de una organización a otra.
- Watson lee todas las organizaciones con clave y dice de cuál es cada tarea o ticket. Cada propuesta suya va a la
  organización del registro que cambia; una tarea nueva, a la de su proyecto.
- La ventana de CRMDev no cambia. Su web tiene su propio inicio de sesión, y la organización se elige allí.

### Vistas

La sección «CRMDev» del menú tiene cuatro pestañas a todo el ancho, con filtros y fichas, de la organización elegida
arriba si hay varias:

- **Proyectos**: nombre, estado, progreso, tipo y fecha límite. La ficha suma las horas (total de CRMDev, por
  persona y por tarea) y lista sus tareas.
- **Tareas**: título, descripción, estado, prioridad, fecha, persona asignada (solo su nombre) y proyecto.
- **Tickets**: título, descripción, estado, prioridad, categoría, quién lo abrió, cliente, proyecto y fecha. Si el
  plan de CRMDev no tiene el módulo de soporte, se dice.
- **Clientes**: nombre, empresa y estado. Solo la ficha trae el correo, y sus tickets.

Todo se pinta como texto: sin HTML, sin Markdown y sin enlaces creados a partir de lo que llega.

### Ventana «Abrir en CRMDev»

«Abrir CRMDev», «Abrir en CRMDev» (proyectos, clientes y tickets) y «Abrir las tareas en CRMDev» abren su web en
una ventana propia de la app de escritorio, nunca en un marco. Solo se abre lo que pide el usuario, de una lista
cerrada de páginas (`panel`, `proyectos`, `tareas`, `clientes`, `soporte` y la ficha de un proyecto, un cliente o un
ticket), con la dirección guardada.

- Solo carga el origen de la dirección guardada (https, o http solo en `localhost`; nunca `127.0.0.1`, `::1` ni un
  puerto de AgoraOne). Los enlaces a otros sitios no se siguen dentro: AgoraOne avisa y los abre en el navegador.
- Tiene su propio almacén de sesión, distinto del de AgoraOne, Central y Mi fábrica. La clave de la API nunca llega
  a la ventana: se entra con el inicio de sesión de CRMDev.
- **Passkeys**: pueden no funcionar en el visor web de la app (WebKitGTK en Linux y algunas versiones de macOS). En
  la ventana se entra con el código por correo o con la contraseña, y siempre está «Abrir en el navegador».
- **Entrar con GitHub** no funciona dentro de la ventana, porque la vuelta de GitHub llega al navegador. El aviso
  lo explica y ofrece abrir CRMDev en el navegador.
- **Sin descargas** (decisión del usuario, 19/11/2026): la ventana nunca descarga. Una descarga o una exportación
  (también `blob:` o `data:`) se avisa en AgoraOne con «Abrir en el navegador» en la misma página.
- **Ticket o Soporte sin sesión**: tras entrar, CRMDev lleva a su panel en vez de a la página pedida, y hay que
  volver a pulsar el botón. AgoraOne lo avisa. Es una limitación de CRMDev, apuntada como mejora suya.
- Sin la app de escritorio (AgoraOne en el navegador) se ofrece «Abrir en el navegador».

### Escrituras

Decisión del usuario del 19/11/2026: crear y cambiar en CRMDev solo tras ver el cambio exacto y pulsar «Guardar en
CRMDev». **Nunca se borra nada.**

- Qué se puede hacer: «Nueva tarea» (pestaña Tareas y ficha de proyecto), «Editar» en tareas, tickets, la ficha de
  proyecto y la de cliente, «Nuevo cliente» y «Crear en CRMDev» para un cliente sin ubicar. Son las herramientas
  `create_task`, `update_task`, `update_project`, `create_client`, `update_client`, `update_ticket` y `reply_ticket`. No se crean
  tickets, y no se tocan las notas del cliente ni la descripción del proyecto. Desde el 20/11/2026 la lista incluye
  también `create_project`, solo para crear un proyecto de Central con «Enviar a CRMDev» (ver «Pendiente en CRMDev»).
- Cada formulario pide antes «Revisar el cambio», que enseña las filas antes y después. La herramienta la elige el
  núcleo según la clase de cambio, nunca la pantalla. La ficha de confirmación sirve una vez y caduca a los 15
  minutos.
- Al confirmar se vuelve a leer la ficha. Si algo de lo enseñado cambió entretanto, se avisa y no se envía; si
  CRMDev ya tiene el valor nuevo, no se envía nada y se da por hecho.
- Un cliente nuevo busca antes duplicados por nombre o correo entre los 100 más recientes y ofrece «Ver el
  existente».
- Un alta que no recibió respuesta puede haberse creado: durante 24 h, repetirla pide revisarlo en CRMDev y solo
  sale con «Crear de todos modos».
- **Responder tickets** (21/11/2026, cuando CRMDev ofreció `reply_ticket` con la clave de organización): «Responder»
  en la ficha de un ticket. Se elige cada vez quién la ve, sin valor por defecto: «Solo el equipo (nota interna)» o
  «El cliente», que la lee en su portal y se avisa en la revisión. El texto va tal cual (hasta 2000 caracteres) y se
  publica a nombre de quien creó la clave. Una respuesta no se borra desde AgoraOne. Si la respuesta de CRMDev no
  llega, se trata como un alta dudosa («Crear de todos modos»).
- Cada cambio queda en el registro de acciones, solo con los nombres de los campos.
- Watson lee tareas y tickets y solo propone cambios, también una respuesta a un ticket (diciendo siempre si es
  interna) (desde la 1.9; ver [watson-actua.md](watson-actua.md#watson-y-crmdev-19)).

La API de CRMDev está documentada en su propio repositorio (`docs/api/`).

## Directorio de clientes

El directorio (Trabajos › Clientes) tiene tres fuentes, que se usan a la vez cuando sus conectores están activos:
Central, CRMDev y los clientes manuales guardados en AgoraOne. De ahí leen la Bandeja, WhatsApp, Reuniones, Fiscal
y Watson.

- **Sin duplicar**: cada entrada reúne como mucho un cliente de cada fuente. Se unen por un enlace del usuario
  («Enlazar»), por NIF de Central, por correo exacto único o por nombre exacto único. Las personas de CRMDev cuya
  empresa coincide con un único cliente van con él como contactos. Lo que solo se parece queda como sugerencia, que
  el usuario enlaza o marca como «Son distintos» (y lo puede deshacer).
- **Quién manda**: si un cliente está en los dos CRM, Central manda en lo fiscal y de contacto, y CRMDev aporta su
  estado comercial y sus tickets. La ficha enseña las diferencias y nada se sincroniza entre ellos.
- **Sin ubicar**: los clientes manuales que no están en ningún CRM conectado salen como «sin ubicar» (filtro propio
  y tarjeta en el Resumen), para hacerles seguimiento. Desde su ficha, «Crear en Central» o «Crear en CRMDev»
  enseñan el cambio exacto y, al confirmarlo, lo crean y lo enlazan. A CRMDev nunca se envía el NIF.
- **Fichas del vault sin cliente**: las notas `Clientes/<Nombre>.md` o las de `Clientes/<Nombre>/` de un vault cuyo
  nombre no está en el directorio. Se detectan en solo lectura, por la carpeta y el nombre del archivo del índice
  del cerebro, nunca por su texto, y se ofrece «Crear cliente manual…» con confirmación.
- **Instantánea de CRMDev**: sus clientes (id, nombre, empresa, correo, estado y dominio) se guardan en la base del
  núcleo cada 30 minutos con el módulo encendido, y con «Actualizar CRMDev». Solo se usa con el módulo encendido y
  la dirección guardada. Al apagar el módulo o desconectar, la instantánea **se conserva sin usarse** hasta que se
  vuelva a encender, igual que la de Central, y los enlaces del usuario tampoco se borran. Olvidar solo la clave
  sigue usando lo ya leído; «Crear en CRMDev» desaparece porque necesita la clave.
- **Proyectos enlazados** (1.9, decisión del usuario del 20/11/2026: Central es la fuente y CRMDev la sigue): la
  instantánea de CRMDev guarda también sus proyectos (id, nombre, estado, tipo y cliente si CRMDev lo da) y la de
  Central el id de cada proyecto. Un proyecto de Central y uno de CRMDev son el mismo si el usuario los enlaza, o si
  se llaman igual, cada nombre es único en su lado y sus clientes no se contradicen. Lo que solo se parece es una
  sugerencia («Enlazar» / «Son distintos», reversible). La ficha de proyecto de cada lado enseña su par (bloques «En
  CRMDev» y «En Central»). Enlazar no copia nada entre ellos.
- **Pendiente en CRMDev** (1.9): con Central y CRMDev encendidos y leídos, el núcleo compara en solo lectura
  (`crmdev_pending.py`) y avisa de clientes de Central sin CRMDev, contactos de Central que no están en ninguna de
  sus personas de CRMDev, clientes y proyectos enlazados con nombre, empresa, correo, estado o cliente distintos,
  proyectos de Central (no archivados) sin CRMDev y clientes de CRMDev que no están en Central. Un correo distinto
  solo dice que difiere: su valor nunca va en el aviso. Se ve en la pestaña CRMDev › «Desde Central» y,
  contado, en una tarjeta del Resumen. «Descartar» guarda solo la clave del aviso y una huella de lo que decía, y el
  aviso vuelve cuando algo cambia. Las dos listas (esta y «Por crear») usan la misma tabla (`src/sync/`): grupos con
  contador, búsqueda, filtros por tipo y estado, una casilla por fila y una barra con lo marcado y «Revisar».
- **Enviar a CRMDev** (1.9): en esa lista se marcan los avisos que se quieren enviar. Desde la 1.10 cada grupo se
  envía por separado («Enviar clientes», «Enviar proyectos», «Revisar envío» en los demás; al cambiar de grupo se
  quitan las marcas): primero los clientes y luego los proyectos. La revisión enseña cada
  operación con sus campos antes y después, con Central y CRMDev leídos en ese momento (si Central no responde, no se
  revisa nada: nunca se envía una copia vieja; «Comparar de nuevo» también los lee), y lo que no puede ir con su motivo. La
  herramienta la elige el núcleo (`crmdev_batch.py`): un cliente que falta va con `create_client` (nombre, correo,
  empresa y teléfono, como «Cliente»); un contacto, con `update_client` del cliente si no tiene correo o con
  `create_client` de una persona de esa empresa; los datos distintos (también una empresa que CRMDev no tiene), con
  `update_client` o `update_project`; el teléfono se compara y se envía solo cuando CRMDev lo devuelve en
  `list_clients` (sus versiones anteriores ni lo dan ni lo aceptan en `update_client`); un
  proyecto que falta, con `create_project`, con el estado equivalente al de Central, GITHUB si tiene repositorio,
  su cliente de CRMDev (el enlazado; si no, el de CRMDev con el mismo nombre leído en ese momento, o el creado en el
  mismo envío; sin ninguno, la lista y la revisión avisan y el proyecto queda sin cliente) y una descripción con el repositorio y las webs del
  cliente, que se escribe solo al crearlo. El NIF y la dirección no van nunca. Un cliente de CRMDev sin Central no se
  envía. Una sola pulsación de «Enviar a CRMDev» manda todo: la revisión sirve una vez y caduca a los 15 minutos.
  Antes de enviar se vuelve a leer CRMDev: lo que cambió no se envía y lo que ya apareció no se crea otra vez. Los
  envíos van uno tras otro con una pausa y, si CRMDev pide esperar, el resto se queda sin enviar. Un alta sin
  respuesta no se vuelve a ofrecer en 24 h salvo con «Revisado en CRMDev: incluirlos». Cada alta queda enlazada con
  su ficha de Central. El registro de acciones solo guarda la clase de cambio y los nombres de los campos.
- **Los clientes nacen en Central** (1.9): la pestaña Central › «Por crear» reúne los clientes que solo
  están en AgoraOne, los de CRMDev que no están en Central y propuestas de quien escribe o se reúne con el usuario
  sin ser cliente (`client_births.py`). Las propuestas salen de correos y conversaciones de WhatsApp clasificados
  como de cliente o de trabajo (los correos, agrupados por dominio cuando representa a un cliente, nunca el de un
  proveedor de correo) y del cliente y las personas con correo de las reuniones; solo de lo «normal», nunca de lo
  «solo en este Mac» ni de lo privado, y nunca de lo que el directorio ya conoce. La lista no lleva correos ni
  números (solo el dominio como pista); «Descartar» guarda solo la clave. El usuario marca, puede cambiar el nombre
  de una propuesta, revisa cada cliente tal cual irá (correo y teléfono incluidos) y los crea todos con «Crear en
  Central» (`central_batch.py`, rutas `/central/batch/preview` y `/central/batch/confirm`, clave con «escritura»).
  Se vuelve a leer Central: lo que ya tiene (nombre, NIF o correo) no se crea. Cada cliente propio queda enlazado y
  cada cliente de CRMDev, enlazado con el nuevo de Central. Nada se crea solo: un correo, un mensaje o una reunión
  nunca disparan la creación.
- Watson (`consultar_clientes`) recibe de cada cliente su nombre, su empresa, su origen (Central, AgoraOne o ambos),
  sus dominios, sus webs, sus proyectos activos o en mantenimiento, su estado en CRMDev (si tiene ficha allí) y si
  está sin ubicar. Nunca recibe el correo, el teléfono, el NIF, las notas, las diferencias entre fuentes ni los
  nombres o correos de sus contactos de CRMDev.

## Modo discreto

- Cierra las ventanas de Central, CRMDev y Mi fábrica, y los botones de abrirlas desaparecen.
- En CRMDev oculta el correo del cliente (ni siquiera se pide), quién abrió cada ticket en la lista, las
  descripciones y los campos de contacto de los formularios.
- En el directorio se ven los nombres de los clientes, pero no su contacto, su NIF, los nombres de sus contactos de
  CRMDev ni las fichas reservadas del vault.

## Mi fábrica, CostGuard y el MCP del cerebro

- **Mi fábrica** (`local_port`): su carpeta y su puerto se indican en su tarjeta, que también tiene el interruptor
  del módulo. Su panel se usa tal cual en una ventana propia: [mi-fabrica.md](mi-fabrica.md).
- **CostGuard** (`local_file`): la ruta de su base de datos, leída en solo lectura. La tarjeta enseña el consumo de
  tokens por agente.
- **MCP del cerebro** (`guide`): las órdenes para dar a un perfil de Hermes las herramientas del cerebro en solo
  lectura: [mcp-cerebro.md](mcp-cerebro.md).

## Añadir un conector

Pasos para un conector nuevo de web API (por ejemplo, uno de SEO). No hace falta tocar la pantalla de Conectores:
la tarjeta sale sola del registro.

1. **Especificación web** en un módulo propio del núcleo (`core/agora_core/seo_api.py`): un
   `web_api.WebApiSpec` con la cuenta del secreto, la fila de `setting`, el patrón de la clave, dónde se crea, la
   dirección de ejemplo, el prefijo de la API y sus permisos. `web_api.py` ya pone la URL validada, el origen fijo,
   la ausencia de redirecciones, la clave solo en `Authorization` y borrada de los errores, y el tope de tamaño.
2. **`probe`**: una función que recibe una `web_api.Connection` y pregunta al servicio sin cambiar nada. Devuelve su
   versión y sus permisos (`{version, scopes, …}`).
3. **Registro**: una entrada `Connector(...)` en `connectors.REGISTRY` con tipo `web_api`, sus módulos, sus vistas,
   su ventana (o `None`), sus permisos y `WebApiAdapter(spec, probe, …)`. Si guarda una caché, se vacía con
   `after_save` y `after_forget`.
4. **Módulo**: su nombre en `modules.MODULES` (y, si debe seguir a su conexión, como `FOLLOW_CRMDEV`) y en
   `ModuleName` de `src/api/core.ts`. Qué hace apagarlo, en `src/connectors/module-meaning.ts`. Lo que necesite
   textos propios en la tarjeta va en `src/connectors/connector-extras.tsx`.
5. **Vistas** (si tiene): sus rutas en el núcleo, que responden 404 con el módulo apagado y 409 sin conexión, y su
   sección en `src/shell/shell-state.ts` (`Section`, `sections`, `sectionModule` y el enlace `?seccion=`).
6. **Ventana** (si tiene web): en la app de escritorio, un `Spec` de `addon_window.rs` de unas 30 líneas
   (`desktop/app/src/seo_window.rs`, como `crmdev_window.rs`, con su etiqueta, su almacén propio, `remote_origin` y
   sin descargas), arrancado en `main.rs`. En el núcleo, sus páginas con `connector_window.window_router`, como
   `routes_crmdev_window.py`, y su etiqueta en `KNOWN_WINDOWS` de `src/shell/modules.ts`. La ruta
   `/internal/{etiqueta}/window/next` se añade a las rutas internas de `desktop/server/tests/foundation.rs`.
7. **Pruebas**: claves que no se filtran, el módulo apagado sin peticiones y la lista cerrada si el servicio tiene
   herramientas que borran.

## Código y pruebas

Núcleo: `connectors.py`, `routes_connectors.py`, `web_api.py`, `central.py`, `central_api.py`, `crmdev_api.py`,
`crmdev_sync.py`, `crmdev_write.py`, `crmdev_values.py`, `confirmed_change.py`, `routes_crmdev.py`,
`routes_crmdev_write.py`, `connector_window.py`, `routes_crmdev_window.py`, `clients.py`, `client_sources.py`,
`client_cards.py` y `routes_clients.py`, con la migración `0034_client_link.sql`. App de escritorio:
`desktop/app/src/addon_window.rs`, `central_window.rs` y `crmdev_window.rs`. Interfaz: `src/connectors/`,
`src/crmdev/` y los archivos `client-*` y `clients-*` de `src/jobs/`.

Pruebas: `core/tests/test_connectors.py`, `test_web_api.py`, `test_crmdev_api.py`, `test_crmdev_routes.py`,
`test_crmdev_write.py`, `test_crmdev_window.py`, `test_clients_crmdev.py`, `test_client_sources.py` y
`test_central_*.py`; `src/connectors/*.test.ts`, `src/crmdev/*.test.ts` y `src/jobs/clients-directory.test.ts`; y
`cargo test --manifest-path desktop/Cargo.toml`.
