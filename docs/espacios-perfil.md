# Espacios de perfil

La personalidad y la memoria se editan desde la ficha del perfil (docs/edicion-perfiles.md).

Cada perfil Hermes tiene un interior propio al que se entra desde su ficha
(«Entrar en el espacio de …»). El espacio en sí no modifica nada: muestra datos reales del
catálogo y abre los paneles existentes; no inicia el agente ni activa herramientas.

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
Cada tipo de edificio tiene su propia arquitectura interior, con la misma huella de
14 × 16 m para que estaciones y obstáculos no cambien:

| Tipo | Sala |
| --- | --- |
| Taller | Nave más alta de hormigón, cerchas de acero, lámparas industriales de luz fría y franjas de seguridad |
| Observatorio | Paredes oscuras, techo con cielo estrellado pintado, anillo luminoso y rosa de los vientos en el suelo |
| Invernadero | Paredes claras bajo una cubierta a dos aguas de cristal con montantes blancos y mucha luz natural |
| Pabellón | Toldos de tela a rayas con el color del perfil y guirnaldas de bombillas |
| Torre | Planta de oficina con suelo pulido, fachada de cristal en la entrada y luminarias lineales |
| Archivo | Friso de madera, techo artesonado y lámparas de latón |

Además, cada tema añade su mobiliario decorativo. Todo es decoración sin capacidades. La persona usa la animación de
reposo; no hay animaciones de hablar o trabajar para no simular actividad.

## Código
- `src/world/profile-interior.tsx`: sala, estaciones y obstáculos.
- `src/world/profile-shell.tsx`: arquitectura de la sala según el tipo de edificio.
- `src/world/profile-decor.tsx`: mobiliario temático.
- `src/world/standing-person.tsx`: persona en reposo (también Luma en la biblioteca).
- `src/ui/scene-copy.tsx`: textos de cada escena.
- Verificación: `node scripts/verify-profile-room.mjs` (escritorio y móvil, sin inferencia).
