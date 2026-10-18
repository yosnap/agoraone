# AgoraOne — contexto persistente

Última petición (18/10/2026): ocultar las líneas que parecen claves, que los perfiles hablen de sí mismos y editar su personalidad y memoria reales desde AgoraOne para unificarlas con Telegram y Desktop (docs/edicion-perfiles.md); después, vault como librería por carpetas (hecho en 0.11.0, docs/vault-obsidian.md); interiores vivos hechos en 0.12.0 (docs/espacios-perfil.md). Después: salir del modo lectura; el usuario eligió primero «bots con sus herramientas» con confirmación por acción (0.13.0, docs/conversaciones-perfiles.md). Orden acordado después (18/10/2026): editar el vault (hecho en 0.14.0, docs/vault-obsidian.md), gestionar tareas y kanban (hecho en 0.15.0, docs/actividad-hermes.md), y usar MCP a mano desde el centro (pendiente). Antes: vault de Obsidian por dentro (docs/vault-obsidian.md). Antes: actividad real de Hermes; implementada en solo lectura (gateway, conexiones por perfil, actividad registrada, tareas programadas y kanban; docs/actividad-hermes.md). Antes: peatones genéricos (docs/ciudad-viva.md). Antes: interiores propios por perfil (docs/espacios-perfil.md). Antes: figuras humanas realistas; implementadas con personas CC0 animadas (docs/recursos-visuales.md). Antes: más realismo con recursos externos (autorizado). Implementados HDRI, texturas PBR y modelos CC0 de Poly Haven locales; ver docs/recursos-visuales.md. Antes: noche según hora real; prioridad del usuario: vista primero, actividad real de Hermes después. Implementados ciclo solar (Madrid), posprocesado N8AO/Bloom/ACES y geometría detallada. Antes: realismo visual con calles derivadas del catálogo, mobiliario, vegetación, cielo, reflejos locales, materiales y personajes que pasean (animación ambiental, no actividad real). Detalle en docs/estado.md.

Decisión actual: agrupar todos los MCP en un edificio, Centro de integraciones, y entrar a seleccionar terminales y ver herramientas por perfil. Implementado con lectura de cachés Hermes y estado histórico explícito; no conexión/ejecución. Sustituye los edificios exteriores individuales de servicios. Ver docs/centro-integraciones.md.

Dirección reafirmada: representar todo el entorno real de Hermes y sus relaciones en una ciudad viva, como un videojuego. Vault significa Obsidian local; MCP conecta otros servicios. Implementados nodos de vault/MCP, relaciones declaradas por perfil y movimiento ambiental. Las notas del vault se leen, editan y crean con confirmación y copia previa (docs/vault-obsidian.md); la actividad real del gateway se lee desde sus registros (docs/actividad-hermes.md). Continuidad y siguiente evolución en docs/ciudad-viva.md.

El usuario solicita ahora edificios distintos. Implementados modelos procedurales por tipo visual y asignación automática a perfiles, sin llamadas a modelos ni cambios en Hermes. La apariencia no implica capacidades ni interiores nuevos. Ver docs/estado.md.

Última petición: reducir la espera del chat. Implementados procesos exclusivos reutilizables por conversación, agentes nuevos por turno y streaming visible con etapa/segundos. Pruebas y límites en docs/latencia-chat.md; siguiente paso: validar tiempos con el uso habitual del usuario. Hermes y sus perfiles originales siguen sin cambios.

## Objetivo
Aplicación web local en macOS: entorno digital como ciudad 3D navegable. Vista general SimCity y primera persona inspirada en el laboratorio de Iron Man. Edificios, objetos y personajes dan acceso a agentes, perfiles, herramientas y archivos de Hermes mediante un backend local.

## Decisiones del usuario
- Three.js definitivo; React, TypeScript, Vite, React Three Fiber. Drei y Rapier según necesidad.
- Aplicación independiente de Hermes. Skills para procedimientos especializados.
- Movimiento y animación sin llamadas a modelos.
- WebXR futuro; evaluar Meta Quest y Apple Vision Pro por separado.
- Biblioteca: documentos, búsqueda, lectura, resumen, organización.
- Cocina: recetas y planificación. Taller: código, repositorios, programas.
- Estudio audiovisual: imágenes, vídeos, generación. Archivo/baúl: colecciones privadas.
- Personajes no equivalen automáticamente a perfiles, bots ni sesiones.
- Edificios apuntan a recursos por ID. Moverlos nunca mueve archivos.
- Permisos en backend y herramientas efectivamente disponibles; no confiar en prompts.
- No acceso general a archivos, no credenciales en frontend, no exposición a Internet.
- No actualizar ni modificar Hermes sin explicar antes el cambio necesario.

## Referencias aportadas
- Prototipo previo de la ciudad y un laboratorio Babylon.js (referencia solamente), aportados por el usuario.
- Ciudad original en Three.js directo, cinco edificios/personajes: Luma biblioteca, Pixel audiovisual, Miso recetas, Byte desarrollo, Nexo archivo.
- Prototipo con órbita, zoom, primera persona y peticiones de prueba en localStorage. Sin Hermes, interiores ni gafas; respuestas y movimientos programados.
- Carpeta local vacía al iniciar el 17/10/2026. No se encontró repositorio del prototipo. El lector web no pudo abrir las URLs; no se afirma fidelidad visual ni importación del código.

## Hermes
Instalación Git ~/.hermes/hermes-agent. Verificados en código/entorno: v0.21.4, fecha 2026.9.21, HEAD 28aceb3451, Python 3.11.15, OpenAI SDK 2.24.0. Intérprete en venv/bin/python. No se autoriza actualización.
Existe API de gateway y clase Python AIAgent. Decisión y evidencias: docs/integracion-hermes.md.
Usuario confirma arranque desde Hermes Desktop y proveedor privado OpenAI compatible. Se selecciona un modelo del proveedor configurado en Hermes; el modelo global de Hermes no se cambió. Se importaron únicamente parámetros de inferencia a `.env` privado del proyecto (0600), nunca al frontend.

## Primer hito
Seleccionar Luma → abrir chat → respuesta real de Hermes vía backend local. Después: biblioteca accesible con carpeta de prueba y permisos limitados. No declarar terminado el hito hasta verificar una respuesta real.

## Continuidad
Consultar docs/estado.md, docs/arquitectura.md, docs/arranque.md y plans/261017-0107-base-local/plan.md.

## Biblioteca de prueba (segundo hito)
Usuario confirmó respuesta de Luma y aceptó continuar. Interior navegable y lector de dos documentos ficticios en resources/library-test. El backend mapea IDs a archivos permitidos, valida solo lectura y revalida en cada petición. El usuario elige un documento y Luma recibe su texto como contexto; Hermes sigue sin herramientas genéricas ni acceso al disco. Ver docs/biblioteca.md y plans/261017-0204-biblioteca/plan.md. No se han conectado archivos personales.

## Importación (tercer hito)
Usuario confirmó el segundo hito y aceptó añadir documentos propios desde la interfaz. Se implementa selector TXT/Markdown UTF-8 de hasta 24 KiB, copia privada bajo .agora/library por identidad local y selección explícita para consultar con Luma. Sin acceso a carpetas ni cambios en originales/Hermes. Ver docs/importacion.md.

## Gestión de copias (cuarto hito)
Usuario confirmó respuestas sobre documentos importados y autorizó renombrar/eliminar copias. Operaciones restringidas al propietario, con CSRF y confirmación de borrado en la interfaz. Renombrar conserva ID y contenido; eliminar impide nuevas lecturas/adjuntos, sin borrar originales, conversaciones ni consultas ya iniciadas. Ver docs/importacion.md.

## PDF y DOCX (quinto hito)
Usuario confirmó el cuarto hito y aceptó PDF/DOCX. Importación local de hasta 5 MiB, guardando solo texto extraído (24 KiB), sin imágenes, maquetación ni OCR. PDF hasta 100 páginas. Extracción en proceso separado y limitado, sin credenciales; mismos permisos, selección explícita y adaptador de Hermes sin herramientas. Ver docs/importacion.md y plans/261017-0305-formatos-documentos/plan.md.

## Dirección actual: ciudad basada en Hermes real
Usuario confirmó PDF/DOCX y pidió priorizar mostrar agentes, bots y espacios existentes según memoria/SOUL, adaptándose automáticamente a cada instalación. Se reemplaza el catálogo fijo ilustrativo por detección de perfiles y espacios registrados; Luma/Biblioteca queda como función propia de AgoraOne. La lectura de SOUL/MEMORY/USER es local, sin inferencia ni activación de herramientas. Perfil, identidad representada, bot de Desktop, espacio y sesión conservan relaciones explícitas.

Detección por ubicación estándar/variables y estructuras reconocidas; no prometer compatibilidad universal con versiones no probadas. Se verifican cinco perfiles en la instalación actual. Los proyectos declarados están vacíos: los espacios proceden de cwd de sesiones y pueden ser históricos/temporales. Ver docs/catalogo-hermes.md.

## Conversación con perfiles (17/10/2026)
Usuario confirmó que ve el catálogo, aplazó diferencias visuales de edificios y aceptó conversar con perfiles reales. Modalidad implementada: sesión AIAgent aislada con snapshot de SOUL/MEMORY/USER revalidado por turno; proveedor de AgoraOne explícito, cero herramientas y sin escritura en memoria original. Historial separado por propietario/perfil/contexto, distinto de Desktop y de Luma. Ver docs/conversaciones-perfiles.md y plans/261017-0405-chat-perfiles/plan.md.
