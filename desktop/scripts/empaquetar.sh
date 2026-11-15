#!/usr/bin/env bash
# Builds the self-contained AgoraOne.app for Apple Silicon: the web interface, the core with its own Python
# (python-build-standalone, pinned and checked by SHA-256) and its dependencies, the examples; every native
# file signed with the hardened runtime, then the app signed and, when a notary profile is given, notarized
# and stapled. The Claude Code copy bundled in the SDK is left out: the core uses the one installed on the
# Mac. The user's data stays outside the app (~/Library/Application Support/AgoraOne).
#
# Set in your own terminal (never in the repository or the chat):
#   APPLE_SIGNING_IDENTITY  the "Developer ID Application: …" identity in your keychain
#   AGORA_NOTARY_PROFILE    optional: a profile saved once with «xcrun notarytool store-credentials NAME
#                           --apple-id … --team-id …», which asks for the app-specific password itself, so
#                           the password never appears in a command line or in the process list.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$ROOT/desktop/paquete"
CONTENT="$WORK/contenido"
PY_VERSION="3.13.18"
PY_RELEASE="20261026"
PY_SHA256="e5af2fde6a937a0e0c795a0c595c4efb70578d57463a2657c819992b9b9acbac"
PY_ARCHIVE="cpython-${PY_VERSION}+${PY_RELEASE}-aarch64-apple-darwin-install_only.tar.gz"
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/cpython-${PY_VERSION}%2B${PY_RELEASE}-aarch64-apple-darwin-install_only.tar.gz"
ENTITLEMENTS="$ROOT/desktop/app/python.entitlements"
APP="$ROOT/desktop/target/release/bundle/macos/AgoraOne.app"

: "${APPLE_SIGNING_IDENTITY:?Define APPLE_SIGNING_IDENTITY en tu terminal con tu identidad «Developer ID Application».}"
[ "$(uname -m)" = "arm64" ] || { echo "Solo se empaqueta en un Mac con Apple Silicon." >&2; exit 1; }
if [ -n "${AGORA_NOTARY_ITEM:-}" ] && [ -z "${AGORA_NOTARY_PROFILE:-}" ]; then
  echo "AGORA_NOTARY_ITEM ya no se usa: pasaba la contraseña en la línea de órdenes. Crea un perfil con" >&2
  echo "«xcrun notarytool store-credentials agoraone-notario --apple-id … --team-id …» y usa AGORA_NOTARY_PROFILE." >&2
  exit 1
fi
step() { printf '\n== %s\n' "$1"; }

step "Interfaz web"
(cd "$ROOT" && pnpm build >/dev/null)

step "Python independiente $PY_VERSION ($PY_RELEASE)"
mkdir -p "$WORK/descargas"
if [ ! -f "$WORK/descargas/$PY_ARCHIVE" ]; then
  curl -fsSL "$PY_URL" -o "$WORK/descargas/$PY_ARCHIVE.parcial"
  mv "$WORK/descargas/$PY_ARCHIVE.parcial" "$WORK/descargas/$PY_ARCHIVE"
fi
echo "$PY_SHA256  $WORK/descargas/$PY_ARCHIVE" | shasum -a 256 -c - >/dev/null || { echo "La suma SHA-256 de Python no coincide: no se usa." >&2; exit 1; }
rm -rf "$CONTENT"
mkdir -p "$CONTENT"
tar -xzf "$WORK/descargas/$PY_ARCHIVE" -C "$CONTENT"
PY="$CONTENT/python/bin/python3"
STDLIB="$CONTENT/python/lib/python3.13"
# Not needed by the core: the standard library's own tests and the Tk tools.
rm -rf "$STDLIB/test" "$STDLIB/idlelib" "$STDLIB/turtledemo" "$STDLIB/tkinter"

step "Dependencias del núcleo"
uv export --project "$ROOT/core" --frozen --no-dev --no-hashes --format requirements-txt -o "$WORK/requisitos.txt" >/dev/null
uv pip install --python "$PY" --break-system-packages --link-mode copy --no-cache --quiet -r "$WORK/requisitos.txt"
# The core uses the Claude Code installed on the Mac (user's decision, 14/11/2026), not the SDK's copy.
rm -f "$STDLIB/site-packages/claude_agent_sdk/_bundled/claude"

step "Núcleo, web y ejemplos"
mkdir -p "$CONTENT/core"
rsync -a --exclude '__pycache__' --exclude '*.pyc' "$ROOT/core/agora_core" "$CONTENT/core/"
# The meetings' system audio (ScreenCaptureKit, audio only); signed below with the other binaries.
mkdir -p "$CONTENT/core/helpers/bin"
xcrun swiftc -O -swift-version 5 -target arm64-apple-macos13 "$ROOT/core/helpers/system-audio-macos.swift" -o "$CONTENT/core/helpers/bin/agora-system-audio"
rsync -a "$ROOT/dist/" "$CONTENT/web/"
rsync -a "$ROOT/resources/library-test/" "$CONTENT/library-test/"
# Compiled now: the signed app is never written to (the core runs without writing bytecode).
"$PY" -m compileall -q -j 0 "$CONTENT/core" "$STDLIB" >/dev/null 2>&1 || true
"$PY" -c "import sys; sys.path.insert(0, '$CONTENT/core'); import agora_core.app, agora_core.extract, docx, pypdf" \
  || { echo "El núcleo empaquetado no importa sus dependencias." >&2; exit 1; }

step "Firma de los binarios de Python"
signed=0
while IFS= read -r -d '' file; do
  file -b "$file" | grep -q "Mach-O" || continue
  case "$file" in
    "$CONTENT/python/bin/"*) codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$APPLE_SIGNING_IDENTITY" "$file" ;;
    *) codesign --force --timestamp --options runtime --sign "$APPLE_SIGNING_IDENTITY" "$file" ;;
  esac
  signed=$((signed + 1))
done < <(find "$CONTENT" -type f \( -perm -u+x -o -name '*.so' -o -name '*.dylib' \) -print0)
echo "$signed binarios firmados"
codesign --verify --strict "$CONTENT/core/helpers/bin/agora-system-audio" \
  || { echo "El programa de audio del sistema no está firmado." >&2; exit 1; }

step "App de Tauri"
(cd "$ROOT/desktop/app" && cargo tauri build --bundles app --config tauri.bundle.json)
codesign --verify --deep --strict "$APP"
codesign -d --entitlements - "$APP/Contents/Resources/python/bin/python3.13" 2>/dev/null | grep -q allow-unsigned-executable-memory \
  || { echo "Python perdió sus permisos de firma dentro de la app." >&2; exit 1; }
# The calendar: the core's Python reads EventKit, which macOS allows only with this entitlement and the
# app's own permission texts.
codesign -d --entitlements - "$APP/Contents/Resources/python/bin/python3.13" 2>/dev/null | grep -q personal-information.calendars \
  || { echo "Python no tiene el permiso de calendarios en su firma." >&2; exit 1; }
for key in NSCalendarsFullAccessUsageDescription NSCalendarsUsageDescription NSRemindersFullAccessUsageDescription NSRemindersUsageDescription NSContactsUsageDescription NSMicrophoneUsageDescription; do
  /usr/libexec/PlistBuddy -c "Print :$key" "$APP/Contents/Info.plist" >/dev/null \
    || { echo "El Info.plist de la app no lleva $key (el texto de un permiso)." >&2; exit 1; }
done
"$APP/Contents/Resources/python/bin/python3.13" -I -c "import EventKit, Contacts" \
  || { echo "El Python de la app no carga EventKit o Contacts." >&2; exit 1; }
codesign -d --entitlements - "$APP/Contents/Resources/python/bin/python3.13" 2>/dev/null | grep -q personal-information.addressbook \
  || { echo "Python no tiene el permiso de Contactos en su firma." >&2; exit 1; }
# The finished app next to the other packaging files, where it is notarized and picked up.
rm -rf "$WORK/AgoraOne.app"
ditto "$APP" "$WORK/AgoraOne.app"
APP="$WORK/AgoraOne.app"
codesign -d --entitlements - "$APP" 2>/dev/null | grep -q automation.apple-events \
  || { echo "La app no tiene el permiso de Automatización (Música y Spotify) en su firma." >&2; exit 1; }
codesign -d --entitlements - "$APP" 2>/dev/null | grep -q device.audio-input \
  || { echo "La app no tiene el permiso de micrófono en su firma." >&2; exit 1; }
codesign --verify --deep --strict "$APP"
echo "Firma correcta: $APP"

if [ -n "${AGORA_NOTARY_PROFILE:-}" ]; then
  step "Notarización"
  ZIP="$WORK/AgoraOne-notarizar.zip"
  ditto -c -k --keepParent "$APP" "$ZIP"
  xcrun notarytool submit "$ZIP" --keychain-profile "$AGORA_NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  spctl --assess --type execute -vv "$APP"
  VERSION="$(grep -m1 '"version"' "$ROOT/desktop/app/tauri.conf.json" | sed -E 's/.*"([^"]+)",?$/\1/')"
  ditto -c -k --keepParent "$APP" "$WORK/AgoraOne-$VERSION.zip"
  rm -f "$ZIP"
  echo "Notarizada y lista para distribuir: $WORK/AgoraOne-$VERSION.zip"
else
  echo "Sin AGORA_NOTARY_PROFILE: firmada pero sin notarizar (solo para este Mac)."
fi
