import { readdirSync, realpathSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { readHermesFile, redact } from './hermes-safe-read';
import { maskSecrets, revealSecrets } from './secret-lines';
import { obsidianRegistryPath } from './resource-discovery';
import type { LibraryDocument } from './library';

// Read-only access to Obsidian vaults listed in Obsidian's own registry. Clients only ever send
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
  private index(vaultId: string): Index {
    const cached = this.indexes.get(vaultId);
    if (cached && Date.now() - cached.at < 15_000) return cached;
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
