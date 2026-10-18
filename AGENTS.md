# AgoraOne

- Hablar siempre en español.
- Archivos de menos de 1000 líneas; documentación de menos de 800. Separar responsabilidades.
- Editar mediante parches; conservar instrucciones ajenas. No superar 200.000 tokens de contexto.
- Una tarea concreta: un agente. No delegar salvo autorización. Fast apagado; Batch para trabajos compatibles.
- Leer PROJECT_CONTEXT.md y docs/estado.md antes de continuar.
- Separar mundo 3D, interfaz, datos, servidor y adaptador Hermes.
- No modificar ni actualizar ~/.hermes/hermes-agent. AgoraOne solo escribe por sí mismo SOUL.md, memories/MEMORY.md y memories/USER.md de los perfiles, y únicamente desde el editor de la ficha (decisión del usuario, 18/10/2026): petición explícita confirmada, copia de seguridad previa, comprobación de revisión, bloqueo de memoria de Hermes y formato de entradas «§». En el chat de un perfil actúa el propio agente del perfil con sus herramientas (decisión del usuario, 18/10/2026): lo que escriba en su home (memoria, sesiones en state.db, ficheros) lo escribe Hermes, siempre tras «Permitir» para cada herramienta que no sea de lectura local, con copia previa de MEMORY/USER por turno; las tareas programadas y los trabajos en segundo plano no se crean desde AgoraOne. Las notas del vault de Obsidian se editan y crean solo desde el libro y el panel del vault (decisión del usuario, 18/10/2026): confirmación, comprobación de revisión, copia previa y escritura atómica; no se mueven, renombran ni borran.
- Credenciales solo en backend. Escuchar únicamente en loopback. Validar permisos en cada ejecución.
- Personaje, agente lógico, perfil, bot y conversación son entidades diferentes.
- Ningún movimiento 3D debe invocar modelos. Identificadores de recursos no son rutas físicas.
- Marcar explícitamente lo conectado, lo pendiente y lo ilustrativo; nunca simular una respuesta real.
- La ciudad se deriva del catálogo detectado de Hermes. No reintroducir agentes ficticios como si fueran perfiles reales. Leer SOUL/memoria no inicia ejecución; la conversación requiere envío explícito. Los chats de perfil usan el agente real del perfil con sus herramientas (decisión del usuario, 18/10/2026), y toda herramienta que no sea de solo lectura exige la confirmación del usuario en AgoraOne, aunque el perfil tenga las aprobaciones desactivadas; nunca se guardan permisos permanentes. Luma sigue sin herramientas.
- Documentación en docs/, planes en plans/. Mantener contexto y siguiente paso al terminar.
- Verificar con npm test y npm run build; añadir pruebas de aislamiento cuando cambien permisos.
