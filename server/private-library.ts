import { constants, mkdirSync, realpathSync, readdirSync, existsSync, openSync, fstatSync, readSync, closeSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { LibraryError, type LibraryDocument } from './library';

export const importSchema = z.object({
  name: z.string().min(1).max(160).refine(name => !name.startsWith('.') && !/[\/\\\x00-\x1f\x7f]/.test(name) && /\.(txt|md|markdown|pdf|docx)$/i.test(name)),
  base64: z.string().min(4).max(32768).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
const ID = /^import-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const renameSchema = z.object({ title: z.string().trim().min(1).max(160).refine(title => !/[\/\\\x00-\x1f\x7f]/.test(title) && title !== '.' && title !== '..') }).strict();
const envelopeSchema = importSchema.extend({ id: z.string().regex(ID), owner: z.string().regex(/^[a-f0-9]{64}$/), title: renameSchema.shape.title.optional() }).strict();

export function decodeDocument(base64: string) {
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > 24576 || bytes.toString('base64') !== base64) throw new LibraryError();
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!content.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw new LibraryError();
  return { content, revision: createHash('sha256').update(bytes).digest('hex') };
}

export class PrivateLibrary {
  private root: string;
  constructor(root = resolve('.agora/library')) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  private directory(owner: string, create = false) {
    if (!/^[a-f0-9]{64}$/.test(owner) || realpathSync(this.root) !== this.root) throw new LibraryError();
    const directory = join(this.root, owner);
    if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (existsSync(directory) && realpathSync(directory) !== directory) throw new LibraryError();
    return directory;
  }
  list(owner: string) {
    const directory = this.directory(owner);
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(file => file.endsWith('.json')).flatMap(file => {
      try { const { id, title } = this.read(file.slice(0, -5), owner); return [{ id, title, kind: 'private' as const }]; }
      catch { return []; }
    });
  }
  import(input: unknown, owner: string): LibraryDocument {
    const parsed = importSchema.parse(input);
    const document = decodeDocument(parsed.base64);
    const directory = this.directory(owner, true);
    if (readdirSync(directory).length >= 100) throw new Error('Límite de 100 documentos importados alcanzado.');
    const id = `import-${randomUUID()}`;
    const file = join(directory, `${id}.json`);
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify({ ...parsed, id, owner })); }
    catch (error) { unlinkSync(file); throw error; }
    finally { closeSync(fd); }
    return { id, title: parsed.name, ...document };
  }
  read(id: string, owner: string): LibraryDocument {
    const stored = this.readStored(id, owner);
    return { id, title: stored.title || stored.name, ...decodeDocument(stored.base64) };
  }
  rename(id: string, owner: string, input: unknown): LibraryDocument {
    const { title } = renameSchema.parse(input);
    const stored = this.readStored(id, owner);
    const file = join(this.directory(owner), `${id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify({ ...stored, title })); }
    catch (error) { unlinkSync(temporary); throw error; }
    finally { closeSync(fd); }
    try { renameSync(temporary, file); }
    catch (error) { unlinkSync(temporary); throw error; }
    return { id, title, ...decodeDocument(stored.base64) };
  }
  delete(id: string, owner: string) {
    this.readStored(id, owner);
    unlinkSync(join(this.directory(owner), `${id}.json`));
  }
  private readStored(id: string, owner: string) {
    let fd: number | undefined;
    try {
      if (!ID.test(id)) throw new LibraryError();
      const file = join(this.directory(owner), `${id}.json`);
      if (realpathSync(file) !== file) throw new LibraryError();
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 40000) throw new LibraryError();
      const buffer = Buffer.alloc(40001);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > 40000) throw new LibraryError();
      const stored = envelopeSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))));
      if (stored.id !== id || stored.owner !== owner) throw new LibraryError();
      decodeDocument(stored.base64);
      return stored;
    } catch { throw new LibraryError(); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}
