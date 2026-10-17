# Espacios de perfil

Cada perfil Hermes tiene un interior propio al que se entra desde su ficha
(«Entrar en el espacio de …»). Es de solo lectura: muestra datos reales del catálogo y
abre los paneles existentes; no inicia el agente ni activa herramientas.

## Estaciones
| Lugar | Dato real | Acción |
| --- | --- | --- |
| Retrato en la pared del fondo | Estado y tamaño de SOUL.md | Abre la ficha del perfil |
| Archivo en la pared izquierda | Estado y tamaño de MEMORY.md y USER.md | Abre la ficha del perfil |
| Pantallas en la pared derecha | MCP declarados para el perfil (máx. 6) y si están habilitados en configuración | Lleva a su terminal del centro de integraciones |
| Escritorio con la persona | Misma figura que pasea en la ciudad | Abre la pestaña de conversación |

Las pantallas reflejan configuración, no conexión activa. En móvil las pantallas
laterales pueden quedar fuera de vista al entrar; la ficha ofrece los mismos enlaces.

## Ambientación
El tema sigue al tipo de edificio del perfil (taller, observatorio, invernadero,
pabellón, torre, archivo): decoración sin capacidades. La persona usa la animación de
reposo; no hay animaciones de hablar o trabajar para no simular actividad.

## Código
- `src/world/profile-interior.tsx`: sala, estaciones y obstáculos.
- `src/world/profile-decor.tsx`: decoración temática.
- `src/world/standing-person.tsx`: persona en reposo (también Luma en la biblioteca).
- `src/ui/scene-copy.tsx`: textos de cada escena.
- Verificación: `node scripts/verify-profile-room.mjs` (escritorio y móvil, sin inferencia).
