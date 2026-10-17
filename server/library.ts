import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const libraryCatalog = [
  { id: 'welcome', title: 'Bienvenida a la biblioteca', filename: 'bienvenida.txt' },
  { id: 'orbital-garden', title: 'Huerto orbital · ejemplo', filename: 'huerto-orbital.txt' },
] as const;
export type DocumentSource = { id: string; title: string; revision: string };
export type LibraryDocument = DocumentSource & { content: string };
const MAX_BYTES = 24 * 1024;

export class LibraryError extends Error {
  constructor() { super('Documento no disponible o fuera de los permisos de lectura.'); }
}

export class Library {
  private root: string;
  constructor(root = resolve('resources/library-test')) { this.root = resolve(root); }

  list() { return libraryCatalog.map(({ id, title }) => ({ id, title })); }

  read(id: string): LibraryDocument {
    const entry = libraryCatalog.find(item => item.id === id);
    if (!entry) throw new LibraryError();
    let descriptor: number | undefined;
    try {
      // IDs map to a fixed registry. Neither client nor model supplies a path.
      if (realpathSync(this.root) !== this.root) throw new LibraryError();
      const file = resolve(this.root, entry.filename);
      if (realpathSync(file) !== file) throw new LibraryError();
      descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_BYTES) throw new LibraryError();
      // Bounded descriptor read, even if another local process grows the file after stat.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(descriptor, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > MAX_BYTES) throw new LibraryError();
      const bytes = buffer.subarray(0, length);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (content.includes('\0')) throw new LibraryError();
      return { id: entry.id, title: entry.title, content,
        revision: createHash('sha256').update(bytes).digest('hex') };
    } catch { throw new LibraryError(); }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
}
