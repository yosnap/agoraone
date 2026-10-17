# Gestión de copias importadas

Autorizado por el usuario tras confirmar el funcionamiento de la importación y aceptar renombrar/eliminar copias sin alterar originales.

Estado: completado. Trece pruebas backend correctas, build correcto y verificaciones Playwright de gestión/importación correctas, sin inferencia. Se verificaron cancelación, persistencia, retirada/actualización del adjunto y móvil.

1. Renombrado de título atómico, ID y bytes conservados, compatible con registros previos.
2. Borrado de copia con validación de propietario, ID y archivo; ejemplos inmutables.
3. API PATCH/DELETE con CSRF y sin rutas del cliente.
4. Interfaz de edición, cancelación y confirmación de borrado. Actualizar/quitar adjunto seleccionado.
5. Pruebas backend y navegador, sin nuevas llamadas de inferencia.
6. Registrar límites: originales e historial intactos; consulta en curso puede terminar; no papelera ni sincronización automática entre pestañas.
