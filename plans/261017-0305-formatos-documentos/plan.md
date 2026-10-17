# PDF y DOCX

## Alcance autorizado
Importar PDF/DOCX desde el selector existente y consultarlos con Luma. Mantener propiedad por identidad, renombrado, borrado y Hermes sin herramientas. No modificar Hermes.

## Decisiones
- Persistir texto extraído y título original, compatible con registros anteriores.
- Binario máximo 5 MiB; texto 24 KiB; PDF máximo 100 páginas; sin OCR.
- Parser separado: PDF.js y Mammoth, stdin sin rutas, entorno sin credenciales.
- Tiempo 15 s, heap V8 128 MiB, dos procesos simultáneos, ZIP acotado.
- Mostrar errores sin guardar texto truncado; revisión manual del texto antes de enviar.

## Implementado
- Validación y extracción backend, límites de transporte y formatos.
- Selector, mensajes de límites y explicación de copia de texto.
- Fixtures ficticias, pruebas de extracción y API con aislamiento.
- Documentación de uso, arquitectura del parser y advertencia audit de CLI no utilizada.

## Validación
- npm test: 16 pruebas correctas.
- npm run build: correcto; persiste aviso de tamaño del bundle 3D.
- Navegador: PDF/DOCX importados, leídos y adjuntados; dos respuestas reales de Hermes con claves exactas. Móvil sin desbordamiento ni errores JavaScript.
- Regresiones verify-import y verify-document-management correctas, sin inferencia adicional.
- Fixture PDF ampliada a 800 puntos: la clave larga se salía del ancho inicial. Repetición posterior correcta.

## Pendiente
Usuario confirmó «funciona» el 17/10/2026. Hito completado. OCR, documentos grandes y fidelidad visual quedan fuera de este hito.
