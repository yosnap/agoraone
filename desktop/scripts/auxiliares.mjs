// Builds the small native helpers the core uses in development (the packaged app builds its own): on macOS,
// the meetings' system-audio recorder (ScreenCaptureKit). On Linux and Windows there is nothing to build.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = join(root, 'core/helpers/system-audio-macos.swift');
const out = join(root, 'core/helpers/bin/agora-system-audio');
if (platform() === 'darwin' && !(existsSync(out) && statSync(out).mtimeMs >= statSync(source).mtimeMs)) {
  mkdirSync(dirname(out), { recursive: true });
  try {
    execFileSync('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${arch() === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13`, source, '-o', out], { stdio: 'inherit' });
    console.log('Programa de audio del sistema listo.');
  } catch {
    console.warn('No se pudo compilar el programa de audio del sistema (¿faltan las herramientas de Xcode?): las reuniones grabarán solo el micrófono.');
  }
}
