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

## Estado
1.7.0-alpha.50: adaptador, ajustes y registro. Ninguna zona pregunta todavía a Jev; la siguiente fase lo pone en
sombra en el correo y WhatsApp. Prueba con la cuenta real: 0,4 s por llamada y unos 600 tokens con cuatro
preguntas.

Código: `core/agora_core/jev.py`, `routes_jev.py`, migración `0032_jev_decision.sql`,
`src/settings/settings-jev.tsx`. Pruebas: `core/tests/test_jev.py`.
