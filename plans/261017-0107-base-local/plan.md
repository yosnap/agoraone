# Plan por hitos — AgoraOne

## H0 · Base y contrato
Estado: completado y documentado.
Carpeta e instrucciones inspeccionadas, contexto conservado, reconstrucción React/Three.js, backend loopback, adapter Python fijado a versión, arranque y verificaciones. Sin cambios a Hermes.

## H1 · Luma conectada
Estado: completado; respuesta real, dos turnos y recarga verificados. Navegación y móvil verificados aparte sin inferencia.
Selección desde ciudad/directorio → chat → respuesta real de Hermes con el modelo configurado. Aceptación: herramientas vacías, continuidad de dos turnos, usuario/conversación separados, error explícito, navegación sin inferencia.

## H2 · Biblioteca limitada
Estado: implementado con selección explícita del documento y lectura backend; Hermes conserva cero herramientas. Detalles en plans/261017-0204-biblioteca/plan.md y docs/biblioteca.md.
Crear carpeta de prueba y recurso registrado, interior accesible y panel de documentos. Herramientas específicas de lectura/búsqueda con raíz y permisos backend. Pruebas de traversal, symlinks, archivos grandes, IDs ajenos y rechazo de escritura. No usar archivos personales ni habilitar herramientas genéricas.

## H3 · Espacios y relaciones
Definir por acción los enlaces de personajes a agentes/perfiles/bots. Confirmar con usuario qué perfiles desea enlazar; no migrar sesiones Desktop automáticamente. Añadir cocina, taller, audiovisual y archivo uno a uno, con estados y permisos visibles.

## H4 · Experiencia espacial
Interiores, objetos manipulables, paneles, persistencia de posiciones por IDs; nunca mover archivos físicos. Colisiones/animación con Three.js y Rapier solo cuando aporte valor. Streaming de chat y cancelación según contrato verificado.

## H5 · WebXR
Evaluar capacidades, controles, rendimiento y requisitos HTTPS por dispositivo. Probar Quest y Vision Pro por separado. Mantener alternativa escritorio y navegación accesible.

## Decisiones pendientes
Diseño interior de biblioteca y operaciones exactas del siguiente hito. Política futura de cuentas, conservación/borrado de conversaciones y cifrado en disco. No bloquean el primer hito local.
