# Watson que actúa (1.7)

Plan: `plans/261115-2240-watson-actua/plan.md`. Decisión del usuario del 15/11/2026, recogida en `AGENTS.md`:
Watson propone y el usuario confirma cada acción viendo exactamente qué se hará. Nada se ejecuta sin pulsar el
botón de la tarjeta. Watson solo lo usa cuando el usuario se lo pide, nunca porque lo diga un correo o una nota.

## Qué puede proponer

| Herramienta | Qué aparece en la pantalla | Al confirmar |
|---|---|---|
| `proponer_nota` | Título y carpeta editables, vault y texto completo | La nota se crea por la ruta del vault: nunca sobrescribe. Rechaza notas con contraseñas. |
| `proponer_evento` | Título, fecha, lugar y calendario | El evento se crea en el calendario elegido; si se solapa con otro, avisa y pide «Crear igualmente». |
| `proponer_presupuesto` | Cliente, partidas, base, IVA y total | Se crea en Central como borrador con `create_quote`, la única escritura permitida en Central. Se envía desde Central. |
| `proponer_limpieza` | La lista de correos de la bandeja de entrada, cada uno con su casilla | Solo los marcados se mueven al archivo o a la Papelera de su cuenta. |
| `proponer_regla` (1.2) | La regla del correo tal cual | Se crea la regla. |

Además, si se le pide una **ficha de cliente**, Watson reúne lo que sabe por Central, la Bandeja y el cerebro, y
la propone como nota en «Clientes/<Nombre>». La ficha tiene siempre las mismas secciones: resumen, contacto,
proyectos, correos, reuniones, tareas y próximos pasos.

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

## Rutas del núcleo

| Ruta | Para qué |
|---|---|
| `POST /assistant/proposals/{id}/quote` | crear en Central el presupuesto propuesto |
| `POST /assistant/proposals/{id}/mail` | mover los correos aprobados de la lista propuesta |
| `POST /assistant/proposals/{id}/dismiss` | descartar una propuesta o darla por usada |
| `GET /brain/review` | revisión del vault |
