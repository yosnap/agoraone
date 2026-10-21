import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { fileRevision, type HermesDiscovery } from './hermes-catalog';
import { readHermesFile, redact } from './hermes-safe-read';
import { maskSecrets, restoreSecrets } from './secret-lines';

// The real skills of a Hermes profile (its home's skills/ folder), browsed, edited and created from
// the profile's sheet (user's decision, 20/10/2026). Listing and reading are local and never reach
// the model; edits and creates are revision-checked, backed up first and written atomically by the
// same isolated Python writer as the identity files.
export class SkillError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const conflict = () => new SkillError('La skill cambió en Hermes mientras la editabas. Vuelve a cargarla para ver la versión actual.', 409);
const namePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const excluded = new Set(['node_modules', '.venv', 'venv', 'site-packages', '__pycache__', '.git', '.hub', '.archive', '.curator_backups', '.locks', '.tox', '.nox', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
const listBytes = 32 * 1024; // frontmatter is read from the start of the file
const maxBytes = 64 * 1024; // full size AgoraOne reads back, same as the identity files
const maxSkills = 300;
const writer = fileURLToPath(new URL('./hermes_profile_write.py', import.meta.url));

type Resolved = { root: string; home: string; path: string; name: string; category: string };

const utf8 = (data: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(data);

/** The SKILL.md files under the profile's skills/ folder, two levels deep: category/skill or skill. */
function scanSkills(home: string): { path: string; category: string; name: string; bytes: number }[] {
  const root = join(home, 'skills');
  if (!existsSync(root) || realpathSync(root) !== root || !lstatSync(root).isDirectory()) return [];
  const found: { path: string; category: string; name: string; bytes: number }[] = [];
  const take = (directory: string, category: string, name: string) => {
    const file = join(directory, 'SKILL.md');
    let info;
    try { info = lstatSync(file); } catch { return; }
    if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) return;
    found.push({ path: file, category, name, bytes: info.size });
  };
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'es'))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || excluded.has(entry.name)) continue;
    const directory = join(root, entry.name);
    if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) continue;
    take(directory, '', entry.name);
    for (const inner of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'es'))) {
      if (!inner.isDirectory() || inner.name.startsWith('.') || excluded.has(inner.name)) continue;
      const nested = join(directory, inner.name);
      if (realpathSync(nested) !== nested || !lstatSync(nested).isDirectory()) continue;
      take(nested, entry.name, inner.name);
    }
  }
  return found;
}

function frontmatter(text: string): Record<string, unknown> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!block) return {};
  try {
    const doc = parseDocument(block[1]);
    if (doc.errors.length) return {};
    const value = doc.toJS({ maxAliasCount: 50 });
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function resolveSkill(discovery: HermesDiscovery, profileId: string, skillId: string): Resolved {
  for (const item of listing(discovery, profileId).skills) if (item.id === skillId) {
    const { root, home } = discovery.skillHome(profileId);
    return { root, home, path: join(home, item.relative), name: item.name, category: item.category };
  }
  throw new SkillError('Skill no disponible.', 404);
}
function listing(discovery: HermesDiscovery, profileId: string) {
  const { root, home } = discovery.skillHome(profileId);
  const found = scanSkills(home).slice(0, maxSkills);
  const skills = found.map(item => {
    const meta = frontmatter(safeRead(root, item.path));
    const name = typeof meta.name === 'string' && meta.name.trim() ? redact(meta.name, 100) : item.name;
    const relative = join('skills', item.category ? `${item.category}/` : '', item.name, 'SKILL.md');
    return {
      id: `skill-${fileRevision(`${root}:${relative}`)}`,
      relative, name, category: item.category, bytes: item.bytes, readable: item.bytes <= maxBytes,
      description: redact(typeof meta.description === 'string' ? meta.description : '', 300),
    };
  });
  return { skills, truncated: scanSkills(home).length > maxSkills };
}
function safeRead(root: string, path: string) {
  try { return utf8(readHermesFile(root, path, listBytes)); } catch { return ''; }
}

/** Names of the profile's skills with their frontmatter description; opaque ids, no paths to the client. */
export const listProfileSkills = (discovery: HermesDiscovery, profileId: string) => listing(discovery, profileId);

export function readProfileSkill(discovery: HermesDiscovery, profileId: string, skillId: string, reveal = false) {
  const target = resolveSkill(discovery, profileId, skillId);
  let data: Buffer;
  try { data = readHermesFile(target.root, target.path, maxBytes); }
  catch { throw new SkillError('Skill no disponible: puede ser demasiado grande o haber cambiado.', 404); }
  const content = utf8(data);
  const masked = maskSecrets(content);
  return {
    id: skillId, name: target.name, category: target.category, bytes: data.length, readable: true, revision: fileRevision(content),
    content: reveal ? content : masked.text, hidden: masked.hidden.length,
    hiddenChars: reveal ? 0 : [...content].length - [...masked.text].length,
  };
}

export async function saveProfileSkill(discovery: HermesDiscovery, backups: string, profileId: string, skillId: string,
  edit: { content: string; revision: string; revealed?: boolean }) {
  const target = resolveSkill(discovery, profileId, skillId);
  const current = utf8(readHermesFile(target.root, target.path));
  if (fileRevision(current) !== edit.revision) throw conflict();
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(edit.content)) throw new SkillError('El texto contiene caracteres de control.');
  let restored: string;
  try { restored = edit.revealed ? edit.content : restoreSecrets(edit.content, maskSecrets(current).hidden); }
  catch (error) { throw new SkillError(error instanceof Error ? error.message : 'Contenido no válido.'); }
  if (Buffer.byteLength(restored) > maxBytes) throw new SkillError('La skill supera 64 KiB.');
  const result = await runWriter({ root: target.root, path: target.path, content: restored, expected: edit.revision, backupDir: join(backups, profileId, 'skills', target.name), lock: false, createParent: false });
  if (result.error === 'conflict') throw conflict();
  if (result.error === 'unsafe') throw new SkillError('No se puede guardar: la skill o su carpeta no son archivos normales del perfil (enlace simbólico o enlace duro).');
  if (!result.ok || typeof result.revision !== 'string') throw new SkillError('No se pudo guardar la skill en Hermes.', 500);
  return { revision: result.revision, backup: result.backup ?? null };
}

export async function createProfileSkill(discovery: HermesDiscovery, backups: string, profileId: string,
  skill: { category: string; name: string; description: string; body: string }) {
  if (!namePattern.test(skill.category) || !namePattern.test(skill.name)) throw new SkillError('Categoría y nombre: 1 a 64 caracteres, empezando por letra o número, sin espacios.');
  const { root, home } = discovery.skillHome(profileId);
  const skillsRoot = join(home, 'skills');
  for (const directory of [join(skillsRoot, skill.category), join(skillsRoot, skill.category, skill.name)]) {
    if (existsSync(directory)) {
      if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) throw new SkillError('No se puede crear: el camino lleva una carpeta no normal (enlace simbólico o enlace duro).');
    } else mkdirSync(directory, 0o700);
  }
  const path = join(skillsRoot, skill.category, skill.name, 'SKILL.md');
  if (existsSync(path)) throw new SkillError('Ya existe una skill con ese nombre en esa categoría.', 409);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(skill.body)) throw new SkillError('El texto contiene caracteres de control.');
  const description = skill.description.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r|\n/g, ' ');
  const content = `---\nname: ${skill.name}\ndescription: "${description}"\n---\n\n${skill.body}`;
  if (Buffer.byteLength(content) > maxBytes) throw new SkillError('La skill supera 64 KiB.');
  const result = await runWriter({ root, path, content, expected: null, backupDir: join(backups, profileId, 'skills', skill.name), lock: false, createParent: false });
  if (result.error === 'unsafe') throw new SkillError('No se puede crear: el camino no es una carpeta normal del perfil.');
  if (!result.ok || typeof result.revision !== 'string') throw new SkillError('No se pudo crear la skill en Hermes.', 500);
  return { id: `skill-${fileRevision(`${root}:skills/${skill.category}/${skill.name}/SKILL.md`)}`, name: skill.name, category: skill.category };
}

function findPython() {
  return ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].find(existsSync);
}
function runWriter(request: object): Promise<{ ok: boolean; error?: string; revision?: string; backup?: string | null }> {
  const python = findPython();
  if (!python) return Promise.resolve({ ok: false, error: 'write_failed' });
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
