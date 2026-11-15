// Builds the small native helpers the core uses in development (the packaged app builds its own): on macOS,
// the meetings' system-audio recorder (ScreenCaptureKit). On Linux and Windows there is nothing to build.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The meetings' system audio, and «Oye Watson» (which carries its own Info.plist with the permission's reason).
const helpers = [
  { source: 'core/helpers/system-audio-macos.swift', out: 'core/helpers/bin/agora-system-audio', extra: [], what: 'el audio del sistema (las reuniones grabarán solo el micrófono)' },
  { source: 'core/helpers/wake-macos.swift', out: 'core/helpers/bin/agora-wake', what: '«Oye Watson»',
    extra: ['-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', join(root, 'core/helpers/wake-info.plist')] },
];
for (const helper of platform() === 'darwin' ? helpers : []) {
  const source = join(root, helper.source), out = join(root, helper.out);
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(source).mtimeMs) continue;
  mkdirSync(dirname(out), { recursive: true });
  try {
    execFileSync('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${arch() === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13`, source, '-o', out, ...helper.extra], { stdio: 'inherit' });
    console.log(`Listo: ${helper.out}`);
  } catch {
    console.warn(`No se pudo compilar ${helper.what} (¿faltan las herramientas de Xcode?).`);
  }
}
