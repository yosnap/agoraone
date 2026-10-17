# Latencia del chat

El 17/10/2026 se detectó un arranque de Hermes de 22.366 ms sin inferencia.
Leer los contextos de perfiles tardaba 249–632 ms. El cliente esperaba el JSON
completo y cada turno importaba Hermes en un proceso nuevo.

Ahora `hermes-worker.ts` conserva un proceso exclusivo por ID de conversación,
con hogar propio tanto para Luma como para perfiles. Máximo cuatro procesos,
dos consultas simultáneas desde HTTP; se descartan tras cinco minutos inactivos,
un fallo o el límite de 120 segundos. Si falta capacidad se elimina un proceso
inactivo. Un agente AIAgent nuevo por turno conserva la relectura de identidad,
el historial explícito del servidor y cero herramientas. No cambia Hermes instalado.

Se verificó en el código instalado `stream_delta_callback`, separado de
`reasoning_callback`. Solo se transmite texto visible; no se conecta razonamiento.
El puente usa NDJSON interno. HTTP conserva JSON por defecto y acepta
`Accept: application/x-ndjson` para estados, fragmentos, resultado final o error.
El cliente muestra etapa, segundos y texto provisional. Solo se guarda el turno
tras la respuesta completa; al fallar se retira el texto provisional.

Medición real con dos mensajes sintéticos «Responde solo: listo»:

| Medida | Primer turno | Proceso reutilizado |
| --- | ---: | ---: |
| Preparación de Hermes | 1717 ms | 199 ms |
| Primer texto visible en el adaptador | 4250 ms | 939 ms |
| Total | 4355 ms | 960 ms |

La variación entre el arranque inicial de 22 s y el posterior de 1,7 s impide
atribuir toda la diferencia al cambio. La reutilización evita repetir imports;
los tiempos de proveedor, longitud de contexto y carga local siguen variando.
El primer turno tras reinicio/expiración paga el arranque. No hay precarga ni
llamadas al modelo por abrir edificios. No se cambió proveedor, modelo o razonamiento.

Verificación: `npm test` (23 pruebas), `npm run build`; navegador con
`node --env-file-if-exists=.env --import tsx scripts/verify-chat-stream.ts`
(4317 libre, servidor temporal, sin inferencia), mostrando fragmento antes del
fin, reemplazo por resultado definitivo y persistencia al recargar.

Medición reproducible con dos consultas facturables:
`node --env-file=.env --import tsx scripts/measure-chat.ts --live`.
Solo imprime tiempos; no claves, rutas de proveedor ni contenidos de perfiles.

Pendiente: cancelación explícita, mediciones con conversaciones largas y revisar
tiempo de proveedor si persiste la espera. Cerrar el panel no cancela una consulta
en curso; su resultado completo puede recuperarse desde el historial.
