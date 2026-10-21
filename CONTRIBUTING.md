# Cómo colaborar con AgoraOne

Gracias por tu interés. Esta guía explica cómo proponer cambios sin romper las garantías de privacidad y seguridad del proyecto.

## Antes de empezar

- Lee el [README](README.md), [docs/arquitectura.md](docs/arquitectura.md) y [docs/estado.md](docs/estado.md).
- Para cambios grandes, abre antes un issue y explica la idea. Así evitamos trabajo duplicado o que choque con decisiones ya tomadas.
- Toda participación se rige por el [código de conducta](CODE_OF_CONDUCT.md).

## Entorno de desarrollo

```sh
npm ci
cp .env.example .env
npm run dev
```

Necesitas Node.js 22.12 o superior y una instalación de Hermes. Si no quieres usar la tuya, apunta `AGORA_HERMES_HOME` y `AGORA_HERMES_PATH` a una instalación de prueba.

## Normas del proyecto

Estas normas no se negocian en una pull request:

1. **Privacidad.** El servidor escucha solo en `127.0.0.1` y toda la API exige el token de acceso. Las credenciales no salen nunca del servidor ni llegan al modelo.
2. **Hermes no se toca.** No se modifica `hermes-agent`. Solo se escribe en los archivos que el usuario edita a propósito, siempre con confirmación, copia previa y comprobación de revisión.
3. **Nada simulado.** No se presenta como real lo que no lo es. Lo conectado, lo pendiente y lo ilustrativo se marcan de forma explícita.
4. **Permisos explícitos.** Toda herramienta que no sea de lectura local requiere «Permitir» en cada uso. No se guardan permisos permanentes.
5. **Capas separadas.** El mundo 3D, la interfaz, los datos, el servidor y el adaptador de Hermes van por separado. Ningún movimiento 3D invoca modelos.

## Estilo de código

- TypeScript estricto en la interfaz (`src/`) y en el servidor (`server/`).
- Archivos de menos de 1000 líneas. Si crecen, se dividen por responsabilidad.
- La interfaz no usa `<select>` nativos: los desplegables van por `src/ui/modern-select.tsx`.
- Los avisos y las tarjetas no llevan una franja de color en el borde izquierdo. El nivel se indica con el fondo, el color del texto, un icono o un borde completo.
- Los textos de la interfaz y la documentación, en español.
- Sigue el estilo del código que rodea tu cambio: nombres, comentarios e idioms.

## Pruebas

Antes de abrir una pull request:

```sh
npm test
npm run build
```

- Añade pruebas en `server/*.test.ts` para cualquier cambio de comportamiento del servidor.
- Si tocas permisos, escritura de archivos o acceso a la API, añade pruebas de aislamiento: rutas fuera de la carpeta permitida, falta de token, revisiones desactualizadas.
- Las pruebas usan instalaciones temporales de Hermes, nunca la tuya.

## Commits y pull requests

- Commits en castellano con formato convencional: `feat: …`, `fix: …`, `docs: …`, `refactor: …`, `test: …`.
- Una pull request por tema. Explica qué cambia, por qué y cómo lo has probado. Si cambia la interfaz, añade capturas.
- **Nunca subas** `.env`, tokens, el contenido de `.agora/` ni capturas o datos de tu instalación real (nombres de perfiles, memorias, notas). Para capturas, usa una instalación de ejemplo.

## Informar de errores y proponer ideas

Usa las plantillas de issues. Incluye el sistema operativo, la versión de Node, la de Hermes y los pasos para reproducir el error. No pegues registros sin revisarlos antes: pueden contener rutas o nombres personales.

Las vulnerabilidades no se publican en un issue: sigue [SECURITY.md](SECURITY.md).

## Licencia

Al contribuir aceptas que tu aportación se publique bajo la [licencia MIT](LICENSE) del proyecto.
