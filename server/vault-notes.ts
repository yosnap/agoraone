import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { readHermesFile, redact } from './hermes-safe-read';
import { maskSecrets, restoreSecrets, revealSecrets } from './secret-lines';
import { obsidianRegistryPath } from './resource-discovery';
import type { LibraryDocument } from './library';

// Access to Obsidian vaults listed in Obsidian's own registry: reading, and editing or creating notes. Clients only ever send
// opaque IDs: vault and note paths are resolved here from a fresh walk, never from the request.
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const maxNotes = 5000, maxDepth = 12, maxEntries = 50_000, maxNoteBytes = 256 * 1024, maxSearchBytes = 16 * 1024 * 1024;
const cutNotice = '\n\n[Nota recortada a 24 KiB para la consulta]';
/** Same limit as library documents: a note sent to the model is cut to this size, and says so. */
export const consultBytes = 24 * 1024;

export type VaultNote = { id: string; title: string; folder: string; bytes: number; modifiedAt: string; readable: boolean };
type Vault = { id: string; name: string; root: string };
type Index = { vault: Vault; notes: (VaultNote & { file: string })[]; truncated: boolean; at: number };

export class VaultError extends Error {
  constructor() { super('Nota no disponible: puede ser demasiado grande, no ser texto UTF-8 o haber cambiado.'); }
}
/** A rejected edit or creation, with the HTTP status and a message for the user. */
export class VaultWriteError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const conflict = () => new VaultWriteError('La nota cambió (en Obsidian o en otro sitio) mientras la editabas. Vuelve a cargarla para ver la versión actual.', 409);
const keepBackups = 20;
// Characters Obsidian does not accept in a note name, plus path separators.
const badTitle = /[\\/:*?"<>|#^[\]\x00-\x1f]/;

export class VaultNotes {
  private indexes = new Map<string, Index>();
  private noteVaults = new Map<string, string>();
  constructor(private registry = obsidianRegistryPath()) {}

  private vaults(): Vault[] {
    if (!this.registry) return [];
    try {
      const root = realpathSync(dirname(this.registry));
      const data = JSON.parse(readHermesFile(root, join(root, basename(this.registry)), 128 * 1024).toString());
      // Same validation as the catalog (resource-discovery): absolute, unique paths only.
      const seen = new Set<string>();
      return Object.values(data.vaults ?? {}).slice(0, 100).flatMap(value => {
        const path = (value as { path?: unknown } | null)?.path;
        if (typeof path !== 'string' || !isAbsolute(path) || seen.has(path)) return [];
        seen.add(path);
        try {
          const real = realpathSync(path);
          return lstatSync(real).isDirectory() ? [{ id: `vault-${hash(path)}`, name: redact(basename(path), 100), root: real }] : [];
        } catch { return []; }
      });
    } catch { return []; }
  }

  /** Walks Markdown notes only: no hidden folders (.obsidian, .trash), no symlinks, no attachments. */
  private index(vaultId: string, fresh = false): Index {
    const cached = this.indexes.get(vaultId);
    if (!fresh && cached && Date.now() - cached.at < 15_000) return cached;
    const vault = this.vaults().find(item => item.id === vaultId);
    if (!vault) throw new VaultError();
    const notes: Index['notes'] = [];
    let truncated = false, visited = 0;
    const walk = (folder: string, depth: number) => {
      if (depth > maxDepth) { truncated = true; return; }
      let entries;
      // An unreadable or vanished folder is skipped, not fatal for the whole vault.
      try { entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { truncated = true; return; }
      for (const entry of entries) {
        if (++visited > maxEntries) { truncated = true; return; }
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const file = join(folder, entry.name);
        if (entry.isDirectory()) walk(file, depth + 1);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          if (notes.length >= maxNotes) { truncated = true; return; }
          let stat;
          try { stat = lstatSync(file); } catch { continue; }
          const path = relative(vault.root, file), id = `note-${hash(`${vault.id}:${path}`)}`;
          notes.push({ id, title: entry.name.slice(0, -3), folder: dirname(path) === '.' ? '' : dirname(path).split(sep).join('/'),
            bytes: stat.size, modifiedAt: stat.mtime.toISOString(), readable: stat.size <= maxNoteBytes && stat.nlink === 1, file });
          this.noteVaults.set(id, vault.id);
        }
      }
    };
    walk(vault.root, 0);
    const index = { vault, notes, truncated, at: Date.now() };
    this.indexes.set(vaultId, index);
    return index;
  }

  list(vaultId: string) {
    const { vault, notes, truncated } = this.index(vaultId);
    return { vault: { id: vault.id, name: vault.name }, truncated, notes: notes.map(({ file: _file, ...note }) => note) };
  }

  private text(index: Index, note: Index['notes'][number]) {
    const bytes = readHermesFile(index.vault.root, note.file, maxNoteBytes);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (content.includes('\0')) throw new VaultError();
    return { bytes, content };
  }

  read(vaultId: string, noteId: string, reveal = false) {
    const index = this.index(vaultId);
    const note = index.notes.find(item => item.id === noteId);
    if (!note) throw new VaultError();
    try {
      const { bytes, content } = this.text(index, note);
      const { file: _file, ...meta } = note;
      const masked = maskSecrets(content);
      return { ...meta, content: reveal ? revealSecrets(content) : masked.text, hidden: masked.hidden.length, revision: createHash('sha256').update(bytes).digest('hex') };
    } catch { throw new VaultError(); }
  }

  /** Case- and accent-insensitive search in titles and content; snippets come from the matching line. */
  search(vaultId: string, query: string) {
    const index = this.index(vaultId);
    const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es');
    const needle = fold(query);
    const results: { id: string; title: string; folder: string; snippet: string }[] = [];
    let read = 0, truncated = false;
    for (const note of index.notes) {
      if (results.length >= 50) { truncated = true; break; }
      const titleHit = fold(note.title).includes(needle);
      // Content is read only within a total byte budget, so one search cannot stall the server.
      let line: string | undefined;
      if (note.readable && read + note.bytes <= maxSearchBytes) {
        read += note.bytes;
        // The snippet is taken from the masked note, so a PEM body or other hidden line never shows.
        try { const { content } = this.text(index, note); const at = content.split('\n').findIndex(text => fold(text).includes(needle)); if (at >= 0) line = maskSecrets(content).text.split('\n')[at]; } catch { /* unreadable: title only */ }
      } else if (note.readable) truncated = true;
      if (!titleHit && line === undefined) continue;
      results.push({ id: note.id, title: note.title, folder: note.folder, snippet: (line ?? '').trim().slice(0, 200) });
    }
    return { results, truncated };
  }

  /**
   * Saves an edited note (user's decision, 18/10/2026). The text the user edited is the masked one: hidden
   * credential-like lines are put back from disk unless they were shown while editing. The note is written
   * in place, through one handle opened without following links, so it keeps its creation date, mode and
   * attributes in Obsidian: just before writing, that handle must still be the vault's note (same inode,
   * folder no link) and its bytes must still be the revision the user opened. The previous version is
   * copied to the backups folder first. Line endings and a leading BOM are kept as they were.
   */
  save(vaultId: string, noteId: string, edit: { content: string; revision: string; revealed?: boolean }, backups: string) {
    const index = this.index(vaultId, true);
    const note = index.notes.find(item => item.id === noteId);
    if (!note || !note.readable) throw new VaultWriteError('Esta nota no se puede editar: no existe, es demasiado grande o es un enlace.', 404);
    const listed = this.safeTarget(index, note.file);
    let handle: number;
    try { handle = openSync(note.file, constants.O_RDWR | constants.O_NOFOLLOW); } catch { throw conflict(); }
    try {
      const opened = fstatSync(handle);
      if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== listed.ino || opened.size > maxNoteBytes) throw new VaultWriteError('Esta nota no se puede editar: es un enlace o cambió de archivo.');
      if (realpathSync(dirname(note.file)) !== dirname(note.file) || lstatSync(note.file).ino !== opened.ino) throw new VaultWriteError('La carpeta de la nota es un enlace y no se escribe en ella.');
      const bytes = Buffer.alloc(opened.size);
      let read = 0;
      while (read < bytes.length) { const count = readSync(handle, bytes, read, bytes.length - read, read); if (!count) break; read += count; }
      if (createHash('sha256').update(bytes.subarray(0, read)).digest('hex') !== edit.revision) throw conflict();
      let current: string;
      try { current = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read)); } catch { throw new VaultWriteError('La nota actual no es texto UTF-8.'); }
      // Hidden-line masking drops control characters, so such a note would lose them: edit it in Obsidian instead.
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(current)) throw new VaultWriteError('Esta nota contiene caracteres de control y se edita mejor en Obsidian, para no alterarlos.');
      let content: string;
      try { content = edit.revealed ? edit.content : restoreSecrets(edit.content, maskSecrets(current).hidden); }
      catch (error) { throw new VaultWriteError(error instanceof Error ? error.message : 'Contenido no válido.'); }
      content = content.replace(/\r\n/g, '\n');
      if ((current.match(/\r\n/g)?.length ?? 0) * 2 > (current.match(/\n/g)?.length ?? 0)) content = content.replace(/\n/g, '\r\n');
      this.check(content);
      const output = Buffer.concat([bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(0, 3) : Buffer.alloc(0), Buffer.from(content)]);
      this.backup(backups, vaultId, noteId, bytes.subarray(0, read));
      writeSync(handle, output, 0, output.length, 0);
      ftruncateSync(handle, output.length);
      fsyncSync(handle);
      this.indexes.delete(vaultId);
      return { id: noteId, revision: createHash('sha256').update(output).digest('hex') };
    } finally { closeSync(handle); }
  }

  /** Creates a new note in a folder that already holds notes (or the vault's top level); never overwrites. */
  create(vaultId: string, folder: string, title: string, content: string) {
    const index = this.index(vaultId, true);
    const name = title.trim().normalize('NFC');
    if (!name || name.startsWith('.') || badTitle.test(name) || /[\p{Cf}\u2028\u2029]/u.test(name) || Buffer.byteLength(`${name}.md`) > 255)
      throw new VaultWriteError('Usa un título corto (hasta 250 bytes) sin / \\ : * ? " < > | # ^ [ ], caracteres invisibles ni punto inicial.');
    if (folder !== '' && !index.notes.some(note => note.folder === folder || note.folder.startsWith(`${folder}/`))) throw new VaultWriteError('Esa carpeta no existe en el vault.', 404);
    this.check(content);
    const directory = join(index.vault.root, ...folder.split('/').filter(Boolean));
    if (realpathSync(directory) !== directory) throw new VaultWriteError('La carpeta es un enlace y no se escribe en ella.');
    const file = join(directory, `${name}.md`);
    let handle: number;
    try { handle = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new VaultWriteError('Ya existe una nota con ese título en esta carpeta.', 409);
      throw new VaultWriteError('No se pudo crear la nota en esa carpeta.');
    }
    try {
      // The folder was swapped for a link between the check and the creation: undo and stop.
      if (realpathSync(directory) !== directory) { unlinkSync(file); throw new VaultWriteError('La carpeta es un enlace y no se escribe en ella.'); }
      writeSync(handle, content); fsyncSync(handle);
    } finally { closeSync(handle); }
    this.indexes.delete(vaultId);
    return { id: `note-${hash(`${vaultId}:${relative(index.vault.root, file)}`)}`, folder, title: name };
  }

  private check(content: string) {
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw new VaultWriteError('El texto contiene caracteres de control.');
    if (Buffer.byteLength(content) > maxNoteBytes) throw new VaultWriteError('La nota supera 256 KiB.');
  }

  /** The note must still be a plain file (no link, one name) inside the vault, in a folder that is no link either. */
  private safeTarget(index: Index, file: string) {
    let stat;
    try { stat = lstatSync(file); } catch { throw conflict(); }
    if (!stat.isFile() || stat.nlink !== 1) throw new VaultWriteError('Esta nota no se puede editar: es un enlace.');
    const folder = dirname(file);
    if (realpathSync(folder) !== folder || !(folder === index.vault.root || folder.startsWith(index.vault.root + sep))) throw new VaultWriteError('La carpeta de la nota es un enlace y no se escribe en ella.');
    return stat;
  }

  private backup(backups: string, vaultId: string, noteId: string, bytes: Buffer) {
    const folder = join(backups, vaultId);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const name = `${noteId}.${new Date().toISOString().replace(/[-:]/g, '')}.bak`;
    const handle = openSync(join(folder, name), 'wx', 0o600);
    try { writeSync(handle, bytes); fsyncSync(handle); } finally { closeSync(handle); }
    for (const old of readdirSync(folder).filter(file => file.startsWith(`${noteId}.`) && file.endsWith('.bak')).sort().slice(0, -keepBackups)) unlinkSync(join(folder, old));
  }

  /** A note as a chat document. Only called for an explicit user send; long notes are cut and marked. */
  document(noteId: string): LibraryDocument {
    // Notes seen in a listing map straight to their vault; otherwise each vault is tried in turn.
    const known = this.noteVaults.get(noteId);
    const vaults = known ? [known, ...this.vaults().map(vault => vault.id).filter(id => id !== known)] : this.vaults().map(vault => vault.id);
    for (const vaultId of vaults) {
      let index: Index;
      try { index = this.index(vaultId); } catch { continue; }
      const note = index.notes.find(item => item.id === noteId);
      if (!note) continue;
      const read = this.read(vaultId, noteId);
      // The whole document, notice included, stays within the 24 KiB the bridge accepts.
      const cut = Buffer.byteLength(read.content) > consultBytes;
      const content = cut ? `${Buffer.from(read.content).subarray(0, consultBytes - Buffer.byteLength(cutNotice)).toString('utf8').replace(/\uFFFD$/, '')}${cutNotice}` : read.content;
      return { id: note.id, title: `${index.vault.name} · ${note.folder ? `${note.folder}/` : ''}${note.title}`, content, revision: read.revision };
    }
    throw new VaultError();
  }
}
