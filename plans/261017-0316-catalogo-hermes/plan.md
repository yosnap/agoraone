# Catálogo automático de Hermes

## Objetivo solicitado
Mostrar agentes, bots y espacios existentes según SOUL, memoria y metadatos; adaptar la ciudad a la instalación, sustituyendo el catálogo ficticio fijo.

## Completado
- Inspección de fuentes instaladas, sin modificar Hermes ni leer secretos.
- Detección configurable y portable de raíz, instalación y versión.
- Catálogo normalizado: perfiles, identidades representadas, bots locales y espacios registrados.
- Lectura de SOUL/MEMORY/USER y metadatos de plataformas; SQLite de solo lectura para proyectos/cwd.
- API local protegida y DTO sin credenciales ni rutas completas.
- Ciudad y navegación dimensionadas al catálogo, fichas y refresco de 30 s.
- Luma/Biblioteca identificada como función de AgoraOne, separada del inventario Hermes.
- Pruebas de perfiles borrados, enlaces, secretos canario, esquema desconocido, ubicación alternativa, relaciones y autorización HTTP.

## Verificación
- 20 pruebas y build final correctos después de los ajustes de robustez.
- Navegador: catálogo real, ficha de memoria, cambio automático, móvil, cero inferencia.
- Regresiones: navegación, interior de biblioteca y gestión de documentos correctas.

## Límites explícitos
Lectura comprobada en Hermes v0.21.4. Otras instalaciones se detectan por capacidades, con avisos para estructuras desconocidas. Remotos y ejecución de perfiles pendientes. El adaptador AIAgent conserva su commit verificado.

## Siguiente paso
Validación visual del usuario; acordar ejecución conversacional de perfiles reales sin ampliar herramientas automáticamente.
