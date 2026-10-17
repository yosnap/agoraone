# Hito 2 · Biblioteca de prueba

Autorizado por el usuario tras confirmar el funcionamiento de Luma y aceptar el siguiente paso.

Estado: implementado. Ocho pruebas backend y build correctos; datos y cita verificados con inferencia real. Interfaz comprobada mediante Playwright después de corregir el desmontaje de etiquetas 3D.

1. Interior 3D propio con estanterías, mesa, personaje, colisiones y salida.
2. Catálogo cerrado por IDs y carpeta de ejemplos del proyecto.
3. Servicio backend de solo lectura, límites y denegación de enlaces/rutas ajenas.
4. Lector, búsqueda por título y selección explícita de documento para Luma.
5. Adjuntar instantánea validada a cada petición Hermes, con referencias visibles; mantener cero herramientas.
6. Pruebas backend, build, navegador e inferencia real sobre un dato de prueba.
7. Actualizar continuidad y documentación de uso y límites.

Decisión: para esta versión, la lectura la realiza el backend tras selección del usuario. No se añaden herramientas genéricas ni búsqueda autónoma al agente.
