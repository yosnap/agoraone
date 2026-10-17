import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { parseDocument } from 'yaml';

export function within(root: string, file: string) {
  const rel = relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
export function readHermesFile(root: string, file: string, limit = 65536): Buffer {
  const target = resolve(file);
  // Do not follow symlinks into a credential file or another collection.
  if (!within(root, target) || realpathSync(target) !== target) throw new Error('Unavailable');
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('Unavailable');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > limit) throw new Error('Unavailable');
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}
export function readMetadata(root: string, file: string) {
  const doc = parseDocument(new TextDecoder('utf-8', { fatal: true }).decode(readHermesFile(root, file, 512 * 1024)));
  if (doc.errors.length) throw new Error('Invalid metadata');
  const value = doc.toJS({ maxAliasCount: 50 });
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
// Defence in depth for user-authored Markdown; never reads .env/auth/secret stores.
export function redact(value: unknown, max = 2000): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, '[contenido reservado]')
    .replace(/^.*(?:api[_ -]?key|token|authorization|password|contraseña|clave(?: de api)?|secret(?:[_ -]?key)?|private[_ -]?key|credential)\s*[:=].*$/gim, '[credencial omitida]')
    .replace(/\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_\-]+/g, '[credencial omitida]')
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, '[cadena reservada]')
    .replace(/https?:\/\/[^\s)]+/g, '[enlace omitido]')
    .slice(0, max);
}
