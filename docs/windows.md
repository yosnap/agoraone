# AgoraOne en Windows

Esta guía pone en marcha AgoraOne desde el código en un PC con **Windows 11** (x64). Todas las órdenes son de **PowerShell** y se escriben desde la carpeta del proyecto, salvo que se diga otra cosa.

En Windows, AgoraOne se usa en el navegador con `pnpm dev`. La app de escritorio empaquetada solo existe, por ahora, para macOS (ver [Instalador de Windows](#instalador-de-windows)).

## 1. Instalar las herramientas

Instala lo que falte con `winget`, que viene con Windows 11. Después de instalar, **cierra la terminal y abre una nueva** para que reconozca los programas.

| Herramienta | Para qué | Orden |
|---|---|---|
| Git | descargar el código | `winget install --id Git.Git -e` |
| Herramientas de compilación de C++ (MSVC) | Rust las necesita para compilar en Windows | `winget install --id Microsoft.VisualStudio.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
| Rust | el servidor de AgoraOne | `winget install --id Rustlang.Rustup -e` |
| Node.js 22.12 o superior | la interfaz | `winget install --id OpenJS.NodeJS.LTS -e` |
| pnpm | las dependencias de la interfaz | `npm install -g pnpm@11.5.1` (la versión que fija `package.json`) |
| uv | el núcleo Python (instala él mismo Python 3.13) | `winget install --id astral-sh.uv -e` |

Las herramientas de C++ ocupan varios GB y tardan un rato. Rust usa por defecto la cadena `stable-x86_64-pc-windows-msvc`, que es la correcta. Si tienes otra, cámbiala con `rustup default stable-x86_64-pc-windows-msvc`.

Opcional: [ollama](https://ollama.com) con el modelo de embeddings (`ollama pull qwen3-embedding:0.6b`) para buscar por significado en el cerebro; sin él, busca solo por palabras. Para dictar y transcribir reuniones hace falta whisper.cpp ([docs/reuniones-voz.md](reuniones-voz.md)).

## 2. Comprobar el equipo

El proyecto trae un script que revisa todo lo anterior sin instalar ni cambiar nada:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-windows.ps1
```

Marca con `[falta]` lo que hay que instalar (y da la orden), con `[aviso]` lo que conviene revisar y con `[info]` lo opcional. Termina con error si falta algún requisito. Puedes ejecutarlo antes y después de cada paso.

## 3. Descargar y preparar el proyecto

```powershell
git clone https://github.com/yosnap/agoraone.git
cd agoraone
Copy-Item .env.example .env
pnpm install --frozen-lockfile
cd core; uv sync --frozen; cd ..
```

Abre `.env` con un editor (por ejemplo `notepad .env`) y completa `AGORA_MODEL`, `AGORA_BASE_URL` y `AGORA_API_KEY` con tu proveedor compatible con OpenAI. Luma lo necesita para conversar; el resto de AgoraOne abre sin él. Nunca pegues claves en un chat ni las subas al repositorio.

El repositorio fija los saltos de línea en LF con `.gitattributes`, así que da igual cómo tengas configurado `core.autocrlf`.

## 4. Arrancar y abrir

```powershell
pnpm dev
```

La primera vez compila el servidor en Rust y tarda unos minutos. Cuando termina, arranca el servidor en `127.0.0.1:4317`, el núcleo Python en `127.0.0.1:4318` y la interfaz en `127.0.0.1:5173`.

En **otra terminal**, abre AgoraOne:

```powershell
pnpm open
```

Abre el navegador con un enlace de acceso de un solo uso. Solo hace falta la primera vez en cada navegador; después basta con http://127.0.0.1:5173. Si la página dice «Falta el enlace de acceso», vuelve a ejecutar `pnpm open`. Para pararlo todo, pulsa Ctrl+C en la terminal de `pnpm dev`.

## 5. Hermes

AgoraOne funciona sin Hermes, pero entonces la Oficina 3D no muestra perfiles y no hay chats con ellos. Lo busca en `%USERPROFILE%\.hermes\hermes-agent` (el archivo `run_agent.py`) y usa el Python de su entorno, `venv\Scripts\python.exe`. Si lo tienes en otra ruta, indícala en `.env`:

```
AGORA_HERMES_HOME=D:\ruta\a\.hermes
AGORA_HERMES_PATH=D:\ruta\a\hermes-agent
AGORA_HERMES_PYTHON=D:\ruta\a\hermes-agent\venv\Scripts\python.exe
```

Con Hermes instalado, `pnpm check:hermes` comprueba que AgoraOne puede cargarlo (sin llamar al modelo). Más detalle en [docs/catalogo-hermes.md](catalogo-hermes.md).

**Pendiente:** la integración con Hermes todavía no se ha probado en Windows con una instalación real.

## Qué cambia respecto a macOS

| Función | En Windows |
|---|---|
| Selector de carpetas, abrir en el Explorador, apps del Menú Inicio | funciona |
| Claves y contraseñas | se guardan en el **Administrador de credenciales de Windows** (en macOS, en el Llavero) |
| Dictado y transcripción con whisper.cpp | funciona, con `whisper-cli.exe` |
| Reuniones | solo se graba **tu micrófono**; el sonido del ordenador (los demás) todavía no |
| Calendarios y recordatorios, historial de llamadas, Contactos | no disponibles: son servicios de macOS |
| «Oye Watson» (escucha continua) | no disponible |
| Control de la música | todavía no |
| Vaults de Obsidian | se leen de `%APPDATA%\obsidian\obsidian.json` |

La interfaz lo indica: donde en macOS dice «este Mac», en Windows dice «este equipo», y las funciones que no existen aparecen como no disponibles.

## Problemas frecuentes

**La página sale vacía y la consola del navegador muestra errores 504 («Outdated Optimize Dep»).** La caché de Vite se ha quedado a medias. Para `pnpm dev` y bórrala:

```powershell
Remove-Item -Recurse -Force node_modules\.vite
pnpm dev
```

**Antivirus Avast o AVG.** Estos antivirus interceptan las conexiones seguras de todo el sistema (definen la variable `SSLKEYLOGFILE`), y el script de comprobación avisa de ello.
- AgoraOne arranca su núcleo sin esa variable, así que la app no se ve afectada. Las pruebas del núcleo también se protegen solas.
- Si `uv` falla al descargar con el error `UnknownIssuer`, usa los certificados de Windows: `uv sync --frozen --system-certs`.
- Si el escudo de archivos bloquea o ralentiza mucho la compilación, añade como excepciones la carpeta del proyecto y `%USERPROFILE%\.cargo`, en lugar de desactivar el antivirus.

**`cargo test` falla con «Acceso denegado» sobre `agoraone.exe`.** `pnpm dev` tiene el programa abierto. Páralo antes de pasar las pruebas del servidor.

**El puerto 4317 o 4318 está ocupado.** Mira qué programa lo usa y ciérralo si no es AgoraOne:

```powershell
netstat -ano | findstr :4318
Get-Process -Id <PID>
```

**Poco espacio en `C:`.** Las cachés de Rust y uv pueden ocupar varios GB. Para llevarlas a otra unidad, define estas variables de usuario antes de instalar Rust o de ejecutar `uv sync`: `CARGO_HOME`, `RUSTUP_HOME`, `UV_CACHE_DIR` y `UV_PYTHON_INSTALL_DIR`.

## Pruebas

Con `pnpm dev` parado:

```powershell
cargo test --manifest-path desktop/Cargo.toml
pnpm test:core
pnpm test
pnpm build
```

En Windows, `pnpm test:core` salta algunas pruebas y explica el motivo de cada una. Son las de voz y reuniones, que usan programas falsos escritos como guiones de shell; la del cambio de hora del calendario, porque Windows no deja cambiar la zona horaria del proceso; y una de las copias de seguridad, porque Windows no deja renombrar una base de datos abierta.

## Instalador de Windows

`desktop/app/tauri.windows.conf.json` prepara un instalador NSIS para Windows. Todavía no se ha construido ni probado, y los datos de esa app irían a `%LOCALAPPDATA%\AgoraOne`. Hasta entonces, usa `pnpm dev`.
