# Ciudad viva: recursos y relaciones

## Dirección confirmada por el usuario
AgoraOne debe representar el entorno real de Hermes y sus relaciones como un
mundo navegable con vida, inspirado en un videojuego. No basta con edificios
decorativos ni un directorio. El vault referido es Obsidian, usado directamente
como carpeta local; los MCP corresponden a otros servicios/plataformas.

## Implementado el 17/10/2026
- Registro local de Obsidian: detección automática de vaults. En el equipo de
  desarrollo, un vault. El catálogo solo guarda nombre, ID y disponibilidad; desde el
  18/10 sus notas se leen en solo lectura (docs/vault-obsidian.md). Sin adjuntos,
  índice en disco, plugins ni asociación supuesta con perfiles.
- MCP de mcp_servers en config.yaml de cada perfil: nombre, ID por perfil,
  transporte y habilitación declarada. Semántica enabled contrastada con
  tools/mcp_tool_common.py del Hermes instalado. Sin comandos, argumentos,
  URLs, env, cabeceras ni autenticación en respuestas del backend.
- Terminales de servicio en la ciudad: agrupación visual por nombre con fichas
  separadas por perfil. No supone destinos ni credenciales iguales.
- Relaciones declaradas visibles al seleccionar un perfil o servicio. No son
  tráfico ni un indicador de conexión. No se inventan enlaces al vault.
- Movimiento ambiental local de personajes, detenido al seleccionarlos y con
  respeto a prefers-reduced-motion. Sin inferencia ni nuevas llamadas de red.

Catálogo observado: cinco perfiles, un vault, siete nombres MCP, 19 declaraciones
MCP por perfil; cero espacios derivados del historial de sesiones. Se mantiene
Luma como biblioteca propia. Total: catorce nodos urbanos.

## Estados y permisos
Un servicio puede estar habilitado en configuración sin estar conectado. No se
ha consultado el runtime del gateway ni ejecutado servidores o herramientas MCP.
No se incluyen servicios dinámicos de plugins. Los chats mantienen cero
herramientas. La lectura de notas de Obsidian todavía no está habilitada.

El registro se busca en el directorio de configuración de Obsidian del sistema;
AGORA_OBSIDIAN_REGISTRY permite indicar otro fichero local. Lectura acotada,
sin enlaces de fichero ni exploración recursiva. Falta de registro no dispara
búsquedas generales. Las rutas completas no se envían al frontend.

## Verificación
25 pruebas correctas: aislamiento previo, extracción, streaming, MCP sin secretos,
IDs por perfil y registros Obsidian inválidos/grandes/enlazados/no disponibles.
Build correcto. Navegador: catorce nodos, ficha de vault presente, tres vínculos
de un MCP con habilitación por perfil, móvil sin desbordamiento, cero errores JS
y cero llamadas de inferencia durante navegación. Inspección visual de
.agora/resource-relations.png.

## Siguiente evolución
1. Acceso limitado y explícito a las notas del vault desde la biblioteca;
   lectura por ID y revalidación del backend, sin acceso general al disco.
2. Estado real del gateway por perfil: conectividad MCP, herramientas disponibles,
   tareas en curso y eventos. Contrastar contratos de la versión instalada y
   alcance de autenticación; no iniciar otro MCP para simular una conexión.
3. Traducir eventos comprobados a acciones en el mundo: personaje ocupado,
   servicio utilizado, documento consultado, tarea completada o bloqueada.
4. Mejorar realismo visual: materiales, iluminación, calles, interiores y
   personajes con recorridos. Primera iteración hecha el 17/10/2026 (ver
   docs/estado.md); segunda iteración con ciclo día/noche real, posprocesado y
   geometría detallada. Tercera iteración con HDRI, PBR y modelos CC0
   (docs/recursos-visuales.md). Personas realistas e interiores de perfil hechos
   (docs/espacios-perfil.md). Peatones genéricos hechos (abajo). Siguiente:
   actividad real de Hermes. La animación ambiental y la actividad real deben
   seguir siendo distinguibles.

Pendiente: conexión activa MCP, relación real de cada perfil con Obsidian y
política concreta de lectura del vault. No se modificó Hermes ni sus archivos.

## Peatones genéricos
Hasta seis transeúntes (la mitad de noche; ninguno con movimiento reducido) pasean por
la acera norte de cada avenida, cruzando las calles. Son ambiente puro: sin etiqueta,
sin anillo, no seleccionables y con ropa neutra, frente a los perfiles, que llevan su
color, nombre y anillo. No representan agentes, sesiones ni actividad de Hermes.
Código: `src/world/city-pedestrians.tsx`; el patrón de paseo (`patrol`, `blendGait`) es
compartido con los personajes de perfil en `src/world/walker.tsx`.
