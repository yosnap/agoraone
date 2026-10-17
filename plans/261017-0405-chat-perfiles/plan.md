# Conversación con perfiles detectados

## Autorización
Usuario confirma que ve el catálogo y acepta el siguiente paso: conversar respetando SOUL, memoria y permisos. Diferenciación visual de edificios aplazada.

## Implementación
- Snapshot de identidad revalidado en backend por turno, 96 KiB total, sin aceptar contexto del navegador.
- Conversaciones ligadas a propietario/agente/perfil/contexto y entornos aislados por sesión.
- AIAgent real con proveedor existente de AgoraOne; sin heredar herramientas ni modificar perfiles.
- Pestaña de conversación, historial por perfil, revisiones de identidad visibles, aviso de transmisión antes de enviar.
- Mantener Luma y biblioteca sin cambios de identidad/capacidades.

## Verificación
21 pruebas unitarias/HTTP y build correctos. Dos respuestas reales de Hermes con perfiles ficticios: SOUL/MEMORY/USER, aislamiento, recarga, historial cruzado rechazado, móvil y fuentes intactas. Sin enviar memorias personales durante la verificación. Catálogo real restaurado.

Regresiones finales correctas: navegación y Luma, interior/biblioteca y catálogo real con refresco automático. Cero llamadas de inferencia adicionales. Pendiente únicamente la prueba del usuario con sus perfiles.

## Límites
Sin herramientas, edición de memoria, sesiones de Desktop ni proveedor nativo por perfil. Estas capacidades requieren otro alcance explícito.
