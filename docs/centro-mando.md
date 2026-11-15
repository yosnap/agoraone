# Centro de mando del Cerebro (1.4)

Desde la 1.4, la página del Cerebro es el centro de mando de AgoraOne. Toma ideas de CROW (llm-wiki-v2) y de
gbrain. Plan: `plans/261115-1455-centro-mando/plan.md`; maqueta aprobada por el usuario el 15/11/2026.

## Qué hay en la página

- Sin barra arriba (1.4.1): se pregunta y se habla con Watson, en su panel de la derecha, como en la maqueta.
- (1.4.0) Barra de mando, arriba, retirada en la 1.4.1. Escribe una pregunta y pulsa Enter, o pulsa el micrófono, habla y vuelve a
  pulsarlo. La pregunta va directa al panel de Watson de la derecha, que responde con sus pasos en directo y
  cita las notas. Nada se envía sin Enter o sin el micrófono.
- Grabar reunión. El botón de la barra empieza a grabar con las opciones de la última vez y, pulsado otra
  vez, para. Abajo aparece una tarjeta con:
  - el tiempo;
  - el volumen real de tu micrófono, medido en el navegador y nunca enviado;
  - si se graba el audio de los demás;
  - quién la resumirá.

  La grabación sigue aunque cambies de sección. Detalles en `docs/reuniones-voz.md`.
- Música. Su tarjeta y su botón están en su sitio, marcados como pendientes de la 1.5. No simulan nada.
- Áreas, a la izquierda. Son las carpetas de primer nivel del vault. Cada una enseña su número de notas, sus
  subcarpetas y cuándo cambió por última vez, además de una descripción:
  - la primera frase de su nota índice, si tiene una (`README`, `Índice`, `Inicio` o una nota con el nombre
    del área);
  - si no, sus subcarpetas principales, en cursiva.

  Pulsar un área resalta sus notas en el grafo. Debajo, «Últimamente» lista las notas cambiadas y las
  reuniones de hoy y de ayer; pulsar una nota la abre. «Notas más conectadas» queda plegada al final.
- Hoy, arriba de la columna (1.4.1): los próximos eventos de la Agenda, los recordatorios de hoy y lo que
  espera en la Bandeja, con sus primeros resúmenes.
- Agentes (1.4.2), según el registro de actividad de gbrain, con datos de Hermes y en solo lectura:
  - los encargos en curso del kanban, con quién los lleva y desde cuándo, y cuántas tarjetas están bloqueadas;
  - las próximas rutinas (tareas programadas activas);
  - lo último que han hecho los perfiles en 24 h, con su resultado («Hecho» o «Falló»). Un canal que sigue
    conectado no se muestra; uno que se cae, sí.
- Grafo por áreas. Las notas se agrupan por área, más separadas y compactas, y cada área grande lleva una
  etiqueta con su nombre y su número de notas. Pulsar la etiqueta resalta el área, igual que desde el panel.
- Franja de estado: Watson en línea, agentes y tokens de las últimas 24 horas.
- Paleta Laboratorio, en Ajustes › Apariencia: azul noche con acentos ámbar, pensada para el tema oscuro.

Todo es solo para la pantalla del dueño, nunca se envía a un modelo. En modo discreto, las áreas y
«Últimamente» solo cuentan lo normal.

## Ruta del núcleo

`GET /brain/home?discreet=0|1` (`core/agora_core/brain_home.py`) devuelve las áreas y «Últimamente».

## Pendiente

- El reproductor de música, la palabra de activación y abrir aplicaciones (1.5).
- Los topes diarios de tokens con barra de uso (I-07 del backlog).
- Las demás mejoras del backlog (`plans/backlog-mejoras.md`).
