# Fiscal (1.1)

La sección Fiscal reúne las facturas de tus carpetas fiscales por trimestre, avisa de lo que conviene revisar y genera el Excel para el gestor con el formato de tu registro. Todo lo que escribe en tus carpetas ocurre tras pulsar un botón, sin sobrescribir nada.

## Carpetas fiscales (Ajustes › Carpetas fiscales)
- Se eligen con el selector de macOS. Cada una tiene nombre, tipo (**autónomo**, **empresa** o **personal**), ámbito y, en las profesionales, el titular que sale en el Excel.
- Nunca puede ser la carpeta personal, la raíz de iCloud Drive ni una carpeta que las contenga, y toda ruta se comprueba dentro de ella.
- Las facturas de un correo se proponen en la carpeta del ámbito de su regla o de su cuenta. En las personales van a Gastos o Compras por año.

## Archivar desde la Bandeja
1. «Descargar y archivar la factura» vuelve a leer el correo en solo lectura y lee el PDF adjunto con el extractor aislado (sin red ni escrituras). Si la factura solo viene enlazada, se descarga al archivar, únicamente desde https público, sin redirecciones y si es PDF.
2. Ves proveedor, NIF, fecha y total, editables, y las dudas (falta el NIF, el total no cuadra, fecha ambigua, otra moneda).
3. «Archivar» la guarda en `Facturas Entrantes/año/NT/fecha proveedor total.pdf`. La misma factura no se archiva dos veces.

**Recibos desde el móvil:** «Subir desde el móvil» enseña un QR con un enlace de un solo uso. Abre durante 10 minutos un puerto en la red de casa que solo acepta un recibo (imagen o PDF de tamaño acotado) y se cierra al recibirlo o al caducar. Es la única excepción a escuchar solo en este Mac. El recibo espera en la Bandeja hasta archivarlo.

**Reordenar una carpeta:** «Proponer cómo ordenarla» deduce año y trimestre de los nombres de carpeta, deja lo dudoso donde está y mueve solo la lista exacta que confirmas, con copia previa.

## El trimestre
- Por cada carpeta de autónomo o empresa, y por año y trimestre: **Facturas Salientes** son los ingresos y **Facturas Entrantes** los gastos, estén ordenadas o no.
- Cada archivo se lee una vez en segundo plano y queda en caché. Una barra enseña el avance y la página se actualiza sola.
- **Lectura con Claude:** Claude Haiku lee el texto de cada factura (y las fotos y los PDF escaneados como imagen), como dato y con JSON validado, con las reglas locales de respaldo y una comprobación de coherencia (base + IVA − IRPF = total). Se puede desactivar en Ajustes › Carpetas fiscales, y entonces nada sale del Mac. Tras tres fallos del modelo, ese archivo se queda con las reglas locales.
- Las facturas en otra moneda pasan a euros con el cambio del BCE de su fecha (la cifra original queda en el concepto, con aviso).
- **Avisos**, cada uno con su detalle: sin NIF, otra moneda, sin IVA desglosado, ilegibles, copias idénticas (dice de qué archivo es copia), fuera de una carpeta de trimestre, y facturas emitidas que Qonto tiene y la carpeta no. Estas últimas se pueden descargar desde el detalle, una a una y con progreso.
- Cada factura se abre, o se muestra en su carpeta, con sus iconos.

**Datos a mano:** solo las facturas que no hay manera de leer (ilegibles, o fotos y escaneados que Claude no ha podido leer) admiten escribir sus datos desde el detalle del aviso. Base, IVA, IRPF y total deben cuadrar. Lo escrito no toca el archivo, deja de valer si el archivo cambia y sale marcado como «Datos escritos a mano». Todo lo que se lee entra tal cual: si algo no coincide, se corrige en la lectura, nunca a mano.

## Qonto (Ajustes › Qonto)
Identificador y clave de la API, que va al Llavero, con «Probar». Las facturas emitidas se leen en solo lectura para comprobar que no falte ninguna en la carpeta. Una factura que ya está (mismo número, o misma fecha y base cuando no se leyó el número) no se vuelve a descargar.

## Excel del gestor
«Generar el Excel» escribe `Registro-NT-AAAA-<carpeta>.xlsx` en la carpeta, con el formato del registro real del usuario: Resumen, Ingresos y Gastos con fórmulas, cifras del 303 e IRPF y los gastos en USD aparte. Nunca sobrescribe, y el texto de terceros nunca se convierte en fórmula. Se abre o se muestra en el Finder desde la app.

## Privacidad
- Con la lectura de Claude desactivada, Fiscal solo consulta el cambio del BCE y Qonto (si está configurado).
- El modo discreto oculta los importes, también en el detalle de los avisos.
- La precisión de la lectura se mide contra los registros trimestrales del usuario antes de cambiarla. Esa evaluación es privada y vive fuera del repositorio.

Pruebas: `core/tests/test_fiscal.py`, `core/tests/test_fiscal_excel.py`, `core/tests/test_fiscal_manual.py`, `scripts/verify-inbox.mjs` y `scripts/verify-fiscal.mjs`.
