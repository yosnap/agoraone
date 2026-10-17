# Recursos visuales externos

Todos proceden de [Poly Haven](https://polyhaven.com) con licencia **CC0** (dominio
público, sin atribución obligatoria). Se descargaron una vez el 17/10/2026 y se sirven
localmente desde `public/world/`; la aplicación nunca los pide a un CDN.

| Uso | Recurso Poly Haven | Fichero local | Procesado |
| --- | --- | --- | --- |
| Cielo de día | kloofendal_48d_partly_cloudy_puresky (2k) | hdri/day.hdr | ninguno |
| Cielo de atardecer | qwantani_sunset_puresky (2k) | hdri/dusk.hdr | ninguno |
| Cielo de noche | qwantani_night_puresky (2k) | hdri/night.hdr | intensidad reducida en código |
| Olivos | island_tree_01, island_tree_02 | models/*.glb | simplificados al 2 %, texturas WebP 1024, meshopt |
| Farola | street_lamp_01 | models/street_lamp_01.glb | WebP 512, meshopt |
| Hidrante | fire_hydrant | models/fire_hydrant.glb | WebP 512, meshopt; variante envejecida descartada en código |
| Asfalto | asphalt_02 (1k) | textures/asphalt_02 | ninguno |
| Césped | leafy_grass (1k) | textures/leafy_grass | difuso re-teñido a verde césped conservando el detalle |
| Acera | concrete_pavement (1k) | textures/concrete_pavement | ninguno |
| Fachadas | white_stucco (1k) | textures/white_stucco | teñido por color del edificio en material |
| Tejados | grey_roof_tiles_02 (1k) | textures/grey_roof_tiles_02 | teñido en material |
| Hormigón/bordillo | concrete_wall_008 (1k) | textures/concrete_wall_008 | ninguno |
| Parqué biblioteca | wood_floor (1k) | textures/wood_floor | ninguno |

Cada textura incluye `diffuse.jpg`, `nor_gl.jpg` y `rough.jpg`. Tamaño total ≈33 MB (personas 2,2 MB)
(modelos 3,6 MB; los originales sumaban 122 MB).

## Personas
CC0 de [Quaternius](https://quaternius.com) (licencia incluida en cada paquete: CC0 1.0).
La descarga oficial de itch.io usa un almacenamiento (Cloudflare R2) inaccesible desde
esta red, así que se tomaron de réplicas públicas en GitHub de los paquetes Standard:
NafisRayan/Animate-Rigged-Humanoid-No-Blender (pelo, barba, UAL1),
kirbycope/godot-3d-player-controller-v2 (trajes Modular Character Outfits) y
dustinc555/mygame (cuerpos Regular de Universal Base Characters).

| Fichero en public/world/humans | Origen | Procesado |
| --- | --- | --- |
| Regular_Male_FullBody / Regular_Female_FullBody | Universal Base Characters | WebP 1024, meshopt; en código solo se conservan cabeza y cuello |
| Male_Peasant / Female_Peasant | Modular Character Outfits – Fantasy | WebP 1024, meshopt; ropa teñida con el color del perfil |
| Hair_SimpleParted, Hair_Long, Hair_Buns, Hair_Beard | Universal Base Characters | WebP 1024, meshopt; teñido de pelo en código |
| humans-animations.glb | Universal Animation Library 1 | solo Idle_Loop, Walk_Loop y Walk_Formal_Loop, sin malla (150 KB) |

Todas las piezas comparten el esqueleto humanoide de Quaternius; `src/world/human-figure.tsx`
vuelve a enlazar ropa y pelo a los huesos del cuerpo. Se excluyeron a propósito
animaciones de conversación o trabajo para no sugerir actividad real de Hermes.

## Cómo se usan
- `src/world/surfaces.tsx`: catálogo de superficies con tamaño real del mosaico y UV en
  metros (`meterUV`) para que la escala no dependa del tamaño del bloque.
- `src/world/city-models.tsx`: modelos instanciados (una llamada de dibujo por pieza).
- `src/world/sky-environment.tsx`: HDRI según la luz; gira el cielo para que su sol
  coincida con el sol calculado y toma el color de niebla del horizonte de la imagen.

## Añadir o cambiar recursos
Optimizar modelos antes de copiarlos, sin añadir dependencias al proyecto:
`npx @gltf-transform/cli@4.5.1 optimize in.gltf out.glb --compress meshopt
--texture-compress webp --texture-size 1024 --simplify-ratio 0.02 --simplify-error 0.02`.
No usar compresión Draco: su decodificador se descargaría de un CDN.
