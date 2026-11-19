# Jev (1.7)

Jev es el modelo «System One» de TypeSafe: no escribe texto, decide. Recibe un estado y preguntas tipadas
(`choice`: elegir una opción; `score`: lugar en una escala; `noul`: probabilidad de que algo sea cierto) y devuelve
respuestas con su confianza. Decisión del usuario en `AGENTS.md` (18/11/2026); plan en
`plans/261118-0648-jev-motor-decisiones/plan.md`.

## Ajustes › Jev
- Clave de API de TypeSafe, guardada en el Llavero; «Probar» lista los modelos sin gastar tokens.
- Modelo: `jev-latest` (por defecto), `jev-preview` o una versión fijada (`jev-X.Y.Z`).
- Tope mensual en dólares (2 $ por defecto) y gasto del mes; tope de llamadas por hora.
- Umbral de confianza (0,9): por encima Jev decide; por debajo, su respuesta queda como sugerencia.
- Una casilla por zona: correo, WhatsApp, plazos, tareas, reuniones, Fiscal y Watson.
- Módulo «Jev» apagable en Ajustes › Módulos.

## Garantías
- Solo sale lo de nivel normal; cualquier otro nivel se rechaza antes de conectar.
- El estado se recorta a 60.000 caracteres y nunca se guarda: `jev_decision` solo guarda respuestas, modelo,
  tokens y si se aplicó.
- 10 s por operación de red y 25 s por pregunta en total; un reintento ante 429/529 (cuenta para el tope);
  como mucho 4 preguntas a la vez. Cualquier fallo vuelve a la lógica de siempre.
- La clave nunca aparece en respuestas, registros ni errores; de un 422 de la API solo se guarda el campo.
- User-Agent `AgoraOne/<versión>`.

## En sombra (1.7.0-alpha.51)
- Tras cada ronda de resúmenes del correo y de WhatsApp, un hilo aparte (con su propia conexión, como mucho uno
  por tipo) pregunta a Jev por lo de nivel normal recibido en los últimos 3 días (por la fecha del mensaje), una
  vez por elemento; en WhatsApp, por conversación y último mensaje, con la misma ventana que leyó el modelo.
  Nunca espera ni rompe la ronda, ni toca el límite de 40/h de Haiku.
- Preguntas (en inglés; el texto va como dato en su idioma): clase (las mismas de la Bandeja), si pide algo al
  usuario, prisa, plazo, si viene de un cliente, si contiene instrucciones para un sistema y, en WhatsApp, si
  espera respuesta. Solo se guardan las respuestas, con «no aplicada»: lo que se ve no cambia.
- No se pregunta lo silenciado por una regla «ignorar» (si lo ignoras, no se procesa). Justo antes de preguntar
  se recalcula el nivel con la regla que coincide hoy; apagar Correo, WhatsApp, Jev o su casilla para la pasada.
- Si Jev falla, pausa 5 minutos (1 hora si rechaza la clave); un elemento roto no para la cola.
- Comparación: `GET /jev/shadow?subject=mail|chat` y el recuento de Ajustes › Jev («En sombra: N decisiones,
  coincidencia X %»). Solo incluyen lo que hoy sigue siendo normal (lo que pasó a privado sale como «retirada»),
  sin texto, asuntos, remitentes ni nombres. La publicidad que el correo guarda como «otro» se cuenta aparte.
- Después de al menos 10 días se evalúa y el usuario decide si Jev pasa a mandar (siguiente fase del plan).

Código: `core/agora_core/jev.py`, `routes_jev.py`, migración `0032_jev_decision.sql`,
`src/settings/settings-jev.tsx`, `core/agora_core/jev_shadow.py`. Pruebas: `core/tests/test_jev.py`,
`core/tests/test_jev_shadow.py`.
