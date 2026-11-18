# Watson que actúa (1.7)

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

Además, si se le pide una **ficha de cliente**, Watson reúne lo que sabe por Central, la Bandeja y el cerebro, y
la propone como nota en «Clientes/<Nombre>». La ficha tiene siempre las mismas secciones: resumen, contacto,
proyectos, correos, reuniones, tareas y próximos pasos.

## Presupuestos

El módulo Presupuestos (entrada «Presupuestos», justo antes de «Central») lee los presupuestos de Central por su
API con una clave que tenga el permiso `presupuestos`, aunque el módulo Central esté apagado
(`core/agora_core/central_quotes.py`, `routes_quotes.py`, `src/quotes/`). Sin conexión o sin ese permiso, la
sección lo explica y lleva a Ajustes › Central. Con el módulo apagado no aparece en el menú, sus rutas responden 404
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
  borrador: nunca se envía ni se cambian fases.
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

## Rutas del núcleo

| Ruta | Para qué |
|---|---|
| `POST /assistant/proposals/{id}/quote` | crear en Central el presupuesto propuesto |
| `GET /quotes`, `GET /quotes/{id}`, `GET /quotes/rates` | presupuestos y tarifas de Central |
| `POST /quotes/{id}/open?format=pdf\|docx` | descargar y abrir el PDF o el Word |
| `POST /quotes` | crear un borrador desde el formulario (con su token) |
| `POST /assistant/proposals/{id}/mail` | mover los correos aprobados de la lista propuesta |
| `POST /assistant/proposals/{id}/dismiss` | descartar una propuesta o darla por usada |
| `GET /brain/review` | revisión del vault |
