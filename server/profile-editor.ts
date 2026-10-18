import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HermesFile } from '../shared/hermes-catalog';
import { fileRevision, type HermesDiscovery } from './hermes-catalog';
import { readHermesFile } from './hermes-safe-read';
import { maskSecrets, restoreSecrets } from './secret-lines';

// Edits the real identity files of a Hermes profile, so AgoraOne, Telegram and Desktop share them.
// The user edits the masked text; hidden credential-like lines are put back from disk, the edit is
// rejected if the file changed meanwhile, and the previous version is backed up before replacing it.
export const entryDelimiter = '\n§\n'; // Hermes' separator between MEMORY.md / USER.md entries
const maxBytes = 64 * 1024; // the most AgoraOne reads back from one identity file
const writer = fileURLToPath(new URL('./hermes_profile_write.py', import.meta.url));

export class ProfileEditError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const conflict = () => new ProfileEditError('El archivo cambió en Hermes mientras lo editabas. Vuelve a cargarlo para ver la versión actual.', 409);

/** Same rule as Hermes' memory tool: trimmed, non-empty, first occurrence wins. */
export const memoryEntries = (text: string) => [...new Set(text.split(entryDelimiter).map(entry => entry.trim()).filter(Boolean))];

export async function saveProfileFile(discovery: HermesDiscovery, backups: string, id: string, name: HermesFile['name'],
  edit: { content?: string; entries?: string[]; revision: string | null; revealed?: boolean }) {
  let target: ReturnType<HermesDiscovery['editTarget']>;
  try { target = discovery.editTarget(id, name); } catch { throw new ProfileEditError('Perfil no disponible.', 404); }
  let current: string | null = null;
  if (existsSync(target.path)) {
    try { current = new TextDecoder('utf-8', { fatal: true }).decode(readHermesFile(target.root, target.path)); }
    catch { throw new ProfileEditError('No se puede editar: el archivo actual no es legible o supera 64 KiB.'); }
  }
  if ((current === null ? null : fileRevision(current)) !== edit.revision) throw conflict();
  const memory = target.limit !== null;
  const text = memory ? edit.entries?.join(entryDelimiter) : edit.content;
  if (typeof text !== 'string') throw new ProfileEditError('Contenido no válido.');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new ProfileEditError('El texto contiene caracteres de control.');
  let restored: string;
  // Text edited with hidden lines shown is already complete: nothing to restore, and a literal marker stays literal.
  try { restored = edit.revealed ? text : restoreSecrets(text, current === null ? [] : maskSecrets(current).hidden); }
  catch (error) { throw new ProfileEditError(error instanceof Error ? error.message : 'Contenido no válido.'); }
  const content = memory ? memoryEntries(restored).join(entryDelimiter) : restored;
  if (memory && [...content].length > target.limit!) throw new ProfileEditError(`Supera el límite de Hermes para este archivo (${target.limit} caracteres).`);
  if (Buffer.byteLength(content) > maxBytes) throw new ProfileEditError('El archivo supera 64 KiB.');
  const python = existsSync(target.python) ? target.python : ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].find(existsSync);
  if (!python) throw new ProfileEditError('No se encontró Python para guardar en Hermes. Instala Python 3 o revisa la instalación de Hermes.', 500);
  const result = await runWriter(python, {
    root: target.root, path: target.path, content, expected: edit.revision, backupDir: join(backups, id), lock: memory, createParent: memory,
  });
  if (result.error === 'conflict') throw conflict();
  if (result.error === 'unsafe') throw new ProfileEditError('No se puede editar: el archivo o su carpeta no son archivos normales del perfil (enlace simbólico o enlace duro).');
  if (!result.ok || typeof result.revision !== 'string') throw new ProfileEditError('No se pudo guardar el archivo en Hermes.', 500);
  return { revision: result.revision, backup: result.backup ?? null };
}

function runWriter(python: string, request: object): Promise<{ ok: boolean; error?: string; revision?: string; backup?: string | null }> {
  return new Promise(resolve => {
    const child = spawn(python, ['-I', writer], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '' } });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false }); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(output)); } catch { resolve({ ok: false }); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
