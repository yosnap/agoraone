# AgoraOne

- Hablar siempre en español.
- Archivos de menos de 1000 líneas; documentación de menos de 800. Separar responsabilidades.
- Editar mediante parches; conservar instrucciones ajenas. No superar 200.000 tokens de contexto.
- Una tarea concreta: un agente. No delegar salvo autorización. Fast apagado; Batch para trabajos compatibles.
- Leer PROJECT_CONTEXT.md y docs/estado.md antes de continuar.
- Separar mundo 3D, interfaz, datos, servidor y adaptador Hermes.
- No modificar ni actualizar ~/.hermes/hermes-agent. De los perfiles existentes solo se escriben SOUL.md, memories/MEMORY.md y memories/USER.md, y únicamente desde el editor de la ficha (decisión del usuario, 18/10/2026): petición explícita confirmada, copia de seguridad previa, comprobación de revisión, bloqueo de memoria de Hermes y formato de entradas «§». Nada más del perfil se modifica.
- Credenciales solo en backend. Escuchar únicamente en loopback. Validar permisos en cada ejecución.
- Personaje, agente lógico, perfil, bot y conversación son entidades diferentes.
- Ningún movimiento 3D debe invocar modelos. Identificadores de recursos no son rutas físicas.
- Marcar explícitamente lo conectado, lo pendiente y lo ilustrativo; nunca simular una respuesta real.
- La ciudad se deriva del catálogo detectado de Hermes. No reintroducir agentes ficticios como si fueran perfiles reales. Leer SOUL/memoria no habilita herramientas ni inicia ejecución automáticamente; la conversación requiere envío explícito.
- Documentación en docs/, planes en plans/. Mantener contexto y siguiente paso al terminar.
- Verificar con npm test y npm run build; añadir pruebas de aislamiento cuando cambien permisos.
