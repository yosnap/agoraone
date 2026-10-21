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
| Estantería de skills (0.20.0) | Las `SKILL.md` reales de la carpeta `skills/` del perfil, hasta 32 libros con el color de su categoría | Abre la pestaña de skills de la ficha |

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
- `src/world/skills-shelf.tsx`: estantería con las skills reales (lectura local del listado; ver docs/skills-perfil.md).
- `src/world/profile-shell.tsx`: arquitectura de la sala según el tipo de edificio.
- `src/world/profile-decor.tsx`: mobiliario temático.
- `src/world/standing-person.tsx`: persona en reposo (también Luma en la biblioteca).
- `src/ui/scene-copy.tsx`: textos de cada escena.
- Verificación: `node scripts/verify-profile-room.mjs` (escritorio y móvil, sin inferencia).

## Interiores vivos (0.12.0)
A petición del usuario («las vistas internas son pobres, tristes»), los interiores se amueblan con modelos CC0 de Poly Haven (ver docs/recursos-visuales.md), cargados aparte para que la sala aparezca al momento (`src/world/room-furniture.tsx`: `Furniture`, `Rug`, `Glow`).
- **Espacios de perfil**: plantas en las esquinas, alfombra bajo el escritorio teñida con el color del perfil, portátil, flexo, libros y jarrón en la mesa, cuadros en la pared izquierda y un retrato estilizado (silueta) en el marco de la personalidad. Cada estilo suma lo suyo: taburetes en el taller, butaca e instrumento en el observatorio, sillas verdes y jardineras en el invernadero, mesas de terraza en el pabellón, sofás y mesas bajas en la torre, mecedora y busto en el archivo.
- **Biblioteca de Luma**: rincón de ajedrez con butacas, sillas verdes con mesita, aparador, cuadro, busto, plantas, lámpara de araña y libros y flexo en la mesa.
- **Centro de integraciones**: estanterías metálicas en las esquinas, una zona de estar con mesa baja y sillones en el pasillo central y plantas.
- La cámara interior empieza algo más atrás (z 6,4) y con un campo de visión más amplio (56° dentro, 43° fuera), para que la primera vista incluya los laterales.
Es solo decoración: ningún mueble refleja ni simula actividad, y los obstáculos de cada sala incluyen los muebles nuevos.
