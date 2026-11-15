# Agenda, llamadas y avisos (1.1)

AgoraOne lee tus calendarios, tus recordatorios y el historial de llamadas del Mac, con los permisos de macOS que tú concedes, y te avisa de lo que no conviene olvidar. Solo crea un evento o un recordatorio cuando lo confirmas, y nunca borra ninguno.

## Agenda
- Hoy, mañana o la semana, con los calendarios de macOS (iCloud, Google, Exchange… los que tengas en Calendario) y los recordatorios pendientes. Los eventos que coinciden en el tiempo van marcados como solape.
- Arriba se ven el resumen de la mañana y los avisos de ahora.
- «Nuevo evento o recordatorio», y «Crear el evento» en una tarjeta de la Bandeja, crean solo al pulsar el botón. Si el evento choca con otros, los enseña y pide un segundo sí («Crear de todos modos»). Un recordatorio con fecha lleva su alarma.
- En modo discreto los títulos se ocultan.

**Ajustes › Calendarios:** el permiso, y por cada calendario su ámbito, su confidencialidad (normal por defecto) y si se oculta.

**Watson:** `consultar_agenda` responde «¿qué tengo hoy, mañana o esta semana?» en tu hora, solo con los calendarios de nivel normal y nunca por el proveedor compatible. Todavía no crea ni cambia eventos desde el chat.

## Llamadas
- Se leen del historial de llamadas del Mac (el que comparte el iPhone con la misma cuenta), en solo lectura y sobre una copia: AgoraOne nunca lo cambia.
- Cuenta como pendiente una llamada perdida de los últimos tres días que no has devuelto. Las de número oculto también cuentan.
- Los nombres salen de Contactos, si le das permiso.
- Por defecto son **«solo en este Mac»**: no llegan a Watson salvo que en Ajustes › Avisos las marques como normales. Si las marcas como privadas, los avisos salen sin nombres.

## Avisos (Ajustes › Avisos)
| Aviso | Cuándo |
| --- | --- |
| Llamada perdida sin devolver | Hasta tres días después |
| Reunión próxima | 15 minutos antes (no los eventos de todo el día) |
| Plazo de un correo | Fechas de hoy o de mañana en un correo pendiente de la Bandeja |
| Resumen de la mañana | A la hora elegida (8:30 por defecto); si no ha podido salir, ya no sale pasado el mediodía (o tres horas después, si la hora elegida es tardía) |

- Con AgoraOne en segundo plano salen como notificaciones de macOS; con la ventana delante, dentro de la app (macOS no muestra avisos de la app que tienes delante).
- Cada aviso sale una sola vez, y solo se da por visto cuando se ha mostrado de verdad.
- Nunca salen en las horas de silencio (22:00–8:00 por defecto). Nada sale a Telegram.
- Cada tipo se activa o desactiva por separado. En modo discreto el aviso dice solo de qué tipo es, y lo privado nunca lleva nombres ni títulos.

**Watson:** `resumen_del_dia` da el mismo resumen cuando se lo pides, aunque los avisos estén apagados.

## Permisos de macOS
La app firmada declara para qué usa cada permiso, y macOS lo pregunta una vez:

| Permiso | Para qué | Dónde se da o se quita |
| --- | --- | --- |
| Calendarios y Recordatorios | Agenda, avisos de reuniones y crear lo que confirmas | «Dar permiso» en la Agenda, o Ajustes del Sistema › Privacidad y seguridad › Calendarios / Recordatorios |
| Contactos | Poner nombre a las llamadas perdidas | «Dar permiso» en Ajustes › Avisos, o Privacidad y seguridad › Contactos |
| Notificaciones | Mostrar los avisos con la app en segundo plano | Ajustes del Sistema › Notificaciones › AgoraOne |
| Acceso total al disco | Leer el historial de llamadas | Ver abajo |

### Acceso total al disco
macOS guarda el historial de llamadas en una carpeta protegida que ninguna app puede leer sin este permiso, y no hay aviso que lo pida.

1. En Ajustes › Avisos, pulsa «Abrir Ajustes del Sistema» (o ve a Ajustes del Sistema › Privacidad y seguridad › Acceso total al disco).
2. Activa AgoraOne. Si no aparece, pulsa «+» y elígela en Aplicaciones.
3. Cierra AgoraOne y vuelve a abrirla: el permiso cuenta desde el siguiente arranque.

AgoraOne solo lee el historial de llamadas con este permiso. Si prefieres no darlo, el resto funciona igual y los avisos de llamadas quedan sin datos. En desarrollo (`pnpm dev`) el permiso lo necesita la terminal desde la que arrancas, no la app.

## Límites
- Las llamadas rechazadas cuentan como perdidas: el historial no las distingue con claridad.
- El ámbito de cada calendario se guarda, pero todavía no filtra nada.

Pruebas: `core/tests/test_calendar.py`, `core/tests/test_alerts.py` y `scripts/verify-agenda.mjs`.
