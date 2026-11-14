# App de escritorio (1.0.0-alpha.12)

AgoraOne se usa como app de macOS autocontenida hecha con Tauri. Decisiones del usuario (13 y 14/11/2026): todo el servidor en Rust y en una sola fase; datos en Application Support; el núcleo usa el Claude Code instalado; solo Apple Silicon.

## Qué hay dentro
- **Servidor** (`desktop/server`, Rust con axum): el mismo contrato HTTP que tenía el servidor de Node. Escucha solo en 127.0.0.1:4317, exige la cookie de acceso, CSRF, Host y Origin, y nadie puede incrustarlo en un marco. Los puentes de Hermes y los escritores de identidad, skills, tareas y MCP (`desktop/server/python`) van incrustados en el binario.
- **App** (`desktop/app`, Tauri 2): arranca el servidor y el núcleo en su propio proceso (`launch.rs`) y abre una ventana que entra sin enlace ni token visibles: la ventana no tiene barra de direcciones y la página canjea el token por su cookie y lo quita de la dirección al momento. La página no tiene acceso a las órdenes nativas de la app. Solo AgoraOne se carga en la ventana; los enlaces a otras webs se abren en el navegador. Si no puede arrancar (por ejemplo, el puerto 4317 ocupado) lo dice con una alerta de macOS.
- **Núcleo** (`core/`): en la app va con su propio Python 3.13 (python-build-standalone) y sus dependencias, ya compilado; se ejecuta sin escribir bytecode, porque la app firmada no se modifica.
- **Interfaz** compilada y **ejemplos** de la biblioteca.

## Datos
- La app guarda todo en `~/Library/Application Support/AgoraOne` (0700): token de acceso (0600), conversaciones, copias de la biblioteca, base y copias del núcleo, copias previas de perfiles y del vault. Sus ajustes de proveedor para Luma van en `.env` dentro de esa carpeta (0600).
- Para traer los datos de un proyecto (`.agora` y su `.env`), se abre la app la primera vez con `AGORA_MIGRAR_DESDE` apuntando a la carpeta del proyecto, por ejemplo `AGORA_MIGRAR_DESDE=~/ruta/al/proyecto open -a AgoraOne`. Solo se acepta una carpeta real del propio usuario; la app no lleva ninguna ruta fija dentro (las compilaciones de la versión final no conservan la ruta del Mac donde se compilaron). La copia nunca mueve ni borra el original, se hace en una carpeta temporal y solo se coloca al terminar (una copia interrumpida se rehace entera) y no sigue enlaces simbólicos. Si Application Support/AgoraOne ya existe, no se copia nada.
- En desarrollo (`pnpm dev`, o la app con `AGORA_ROOT` apuntando al proyecto) se sigue usando `.agora`.

## Procesos
- Al cerrar la app (también con SIGTERM o SIGINT) se detienen el servidor, el núcleo y los puentes de las conversaciones, con 15 s como máximo; no quedan procesos ni puertos abiertos.
- Una app abierta desde el Finder recibe un PATH mínimo. La app añade `~/.local/bin`, `/opt/homebrew/bin` y `/usr/local/bin` si existen, para que el núcleo encuentre Claude Code y los perfiles sus lanzadores de MCP.
- El asistente usa el Claude Code instalado (no la copia de unos 340 MB que trae el SDK). Si no está instalado, el asistente lo indica en lugar de responder.
- El núcleo nunca carga los conectores de claude.ai de la cuenta (`ENABLE_CLAUDEAI_MCP_SERVERS=false`): solo cuenta la información de este Mac, porque una cuenta de Claude puede estar compartida.

## Empaquetar
`desktop/scripts/empaquetar.sh`, en un Mac con Apple Silicon:

1. Compila la interfaz.
2. Descarga Python 3.13.18 de python-build-standalone (publicación 20261026, con al menos dos semanas de recorrido) y comprueba su SHA-256 contra la suma oficial; si no coincide, se detiene.
3. Instala las dependencias del núcleo con `uv` desde `core/uv.lock`, quita la copia de Claude Code del SDK y las partes de la biblioteca estándar que el núcleo no usa (pruebas y Tk).
4. Copia el núcleo, la interfaz y los ejemplos, compila el bytecode y comprueba que el núcleo importa sus dependencias.
5. Firma cada binario con la firma endurecida (Python con `desktop/app/python.entitlements`: memoria ejecutable para cffi, lxml y numpy).
6. Construye la app con `cargo tauri build --config tauri.bundle.json` (los recursos solo se declaran ahí, para no romper las compilaciones de desarrollo), la verifica y la deja en `desktop/paquete/AgoraOne.app` (carpeta ignorada por git).
7. Si se le indica cómo, la notariza, grapa el ticket, la valida con Gatekeeper y deja `desktop/paquete/AgoraOne-<versión>.zip` para distribuir.

Variables, definidas en la terminal del usuario (nunca en el repositorio ni en el chat):

- `APPLE_SIGNING_IDENTITY`: la identidad «Developer ID Application: …» del llavero.
- `AGORA_NOTARY_PROFILE`, para notarizar: un perfil del llavero que se crea una vez con `xcrun notarytool store-credentials agoraone-notario --apple-id <Apple ID> --team-id <equipo>`. La orden pide la contraseña de aplicación por su cuenta, así que nunca aparece en la línea de órdenes ni en la lista de procesos. (`AGORA_NOTARY_ITEM` ya no se admite por eso mismo.)

Sin perfil, la app queda firmada pero sin notarizar: abre en este Mac, pero no en otro.

Si Apple responde «403: A required agreement is missing or has expired», el titular de la cuenta de desarrollador tiene que aceptar el acuerdo pendiente en developer.apple.com (o en App Store Connect, en Negocio). Puede tardar unos minutos en hacer efecto.

## Comprobado
- `codesign --verify --deep --strict` correcto, y Python conserva sus permisos de firma dentro de la app.
- Notarizada y grapada; Gatekeeper la acepta como «Notarized Developer ID».
- Primer arranque real: copia a Application Support, núcleo con el Python de la app, cerebro y Watson con el Claude Code instalado; cierre sin procesos ni puertos.

## Límites
- Solo Apple Silicon (arm64). Unos 317 MB, sobre todo por el Python y las dependencias del núcleo (numpy, lxml, cryptography).
- El icono (`desktop/app/icons/source.svg`) es provisional.
- La app no se actualiza sola: cada versión se construye y notariza con el script.
- Los perfiles de Hermes siguen usando el Hermes instalado del usuario; la app no lo incluye ni lo modifica.
