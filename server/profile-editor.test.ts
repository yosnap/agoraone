import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HermesDiscovery, fileRevision } from './hermes-catalog';
import { ProfileEditError, saveProfileFile } from './profile-editor';
import { maskSecrets } from './secret-lines';

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agora-edit-')));
  const home = join(base, 'hermes/profiles/alpha');
  mkdirSync(join(home, 'memories'), { recursive: true });
  writeFileSync(join(home, 'SOUL.md'), '# Alpha\nVivo en Madrid.\napi_key: CANARY_SOUL');
  writeFileSync(join(home, 'memories/MEMORY.md'), 'Primer recuerdo\n§\nSegundo recuerdo');
  writeFileSync(join(home, 'config.yaml'), 'memory:\n  memory_char_limit: 60\n');
  const discovery = new HermesDiscovery({ root: join(base, 'hermes'), installation: '/not-installed', python: '', source: 'test' });
  const [alpha] = discovery.scan().profiles;
  return { base, home, discovery, alpha, backups: join(base, 'backups'), close: () => rmSync(base, { recursive: true, force: true }) };
}
const revisionOf = (path: string) => fileRevision(readFileSync(path, 'utf8'));
const rejects = async (promise: Promise<unknown>, status: number) => assert.rejects(promise, error => error instanceof ProfileEditError && error.status === status);

test('editar perfil: la personalidad se guarda en Hermes conservando las líneas ocultas y con copia previa', async () => {
  const f = fixture();
  try {
    const soul = join(f.home, 'SOUL.md'), before = readFileSync(soul, 'utf8');
    const masked = maskSecrets(before).text;
    assert.match(masked, /\[línea oculta 1\]/);
    const result = await saveProfileFile(f.discovery, f.backups, f.alpha.id, 'SOUL.md', { content: masked.replace('Madrid', 'Valencia'), revision: fileRevision(before) });
    assert.equal(readFileSync(soul, 'utf8'), '# Alpha\nVivo en Valencia.\napi_key: CANARY_SOUL');
    assert.equal(result.revision, revisionOf(soul));
    const [backup] = readdirSync(join(f.backups, f.alpha.id));
    assert.equal(readFileSync(join(f.backups, f.alpha.id, backup), 'utf8'), before);
    // Removing a marker deletes that line; inventing one is rejected.
    await saveProfileFile(f.discovery, f.backups, f.alpha.id, 'SOUL.md', { content: '# Alpha\nVivo en Valencia.', revision: result.revision });
    assert.doesNotMatch(readFileSync(soul, 'utf8'), /CANARY/);
    await rejects(saveProfileFile(f.discovery, f.backups, f.alpha.id, 'SOUL.md', { content: '[línea oculta 7]', revision: revisionOf(soul) }), 400);
  } finally { f.close(); }
});

test('editar perfil: un cambio hecho por Hermes mientras se editaba no se sobrescribe', async () => {
  const f = fixture();
  try {
    const soul = join(f.home, 'SOUL.md'), stale = revisionOf(soul);
    writeFileSync(soul, 'Cambio de Hermes');
    await rejects(saveProfileFile(f.discovery, f.backups, f.alpha.id, 'SOUL.md', { content: 'Mi versión', revision: stale }), 409);
    assert.equal(readFileSync(soul, 'utf8'), 'Cambio de Hermes');
  } finally { f.close(); }
});

test('editar perfil: recuerdos con el formato y el límite de Hermes, y USER.md nuevo', async () => {
  const f = fixture();
  try {
    const memory = join(f.home, 'memories/MEMORY.md');
    await saveProfileFile(f.discovery, f.backups, f.alpha.id, 'MEMORY.md', { entries: [' Primer recuerdo ', '', 'Vive en Valencia', 'Primer recuerdo'], revision: revisionOf(memory) });
    assert.equal(readFileSync(memory, 'utf8'), 'Primer recuerdo\n§\nVive en Valencia');
    assert.ok(existsSync(`${memory}.lock`), 'usa el mismo bloqueo que Hermes');
    await rejects(saveProfileFile(f.discovery, f.backups, f.alpha.id, 'MEMORY.md', { entries: ['x'.repeat(61)], revision: revisionOf(memory) }), 400);
    const user = join(f.home, 'memories/USER.md');
    await saveProfileFile(f.discovery, f.backups, f.alpha.id, 'USER.md', { entries: ['Se llama Ana'], revision: null });
    assert.equal(readFileSync(user, 'utf8'), 'Se llama Ana');
    await rejects(saveProfileFile(f.discovery, f.backups, f.alpha.id, 'USER.md', { entries: ['Otra'], revision: null }), 409);
  } finally { f.close(); }
});

test('editar perfil: no escribe a través de enlaces simbólicos ni en perfiles desconocidos', async () => {
  const f = fixture();
  try {
    const soul = join(f.home, 'SOUL.md'), outside = join(f.base, 'fuera.md');
    writeFileSync(outside, 'Fuera'); unlinkSync(soul); symlinkSync(outside, soul);
    await rejects(saveProfileFile(f.discovery, f.backups, f.alpha.id, 'SOUL.md', { content: 'x', revision: fileRevision('Fuera') }), 400);
    assert.equal(readFileSync(outside, 'utf8'), 'Fuera');
    await rejects(saveProfileFile(f.discovery, f.backups, `profile-${'0'.repeat(24)}`, 'SOUL.md', { content: 'x', revision: null }), 404);
  } finally { f.close(); }
});

test('editar perfil: archivos con BOM, bloqueo o carpeta enlazados y edición con líneas visibles', async () => {
  const f = fixture();
  try {
    const soul = join(f.home, 'SOUL.md');
    writeFileSync(soul, '\uFEFF# Con BOM');
    await saveProfileFile(f.discovery, f.backups, f.alpha.id, 'SOUL.md', { content: '# Sin BOM', revision: fileRevision('# Con BOM') });
    assert.equal(readFileSync(soul, 'utf8'), '# Sin BOM');
    // Edited with hidden lines shown: the text is taken as is, so a literal marker stays literal.
    writeFileSync(soul, '[línea oculta 1]\npassword: CANARY');
    await saveProfileFile(f.discovery, f.backups, f.alpha.id, 'SOUL.md', { content: '[línea oculta 1]\npassword: CANARY\nnueva', revision: revisionOf(soul), revealed: true });
    assert.equal(readFileSync(soul, 'utf8'), '[línea oculta 1]\npassword: CANARY\nnueva');
    const memory = join(f.home, 'memories/MEMORY.md'), outside = join(f.base, 'fuera.lock');
    writeFileSync(outside, ''); symlinkSync(outside, `${memory}.lock`);
    await assert.rejects(saveProfileFile(f.discovery, f.backups, f.alpha.id, 'MEMORY.md', { entries: ['x'], revision: revisionOf(memory) }));
    assert.equal(readFileSync(memory, 'utf8'), 'Primer recuerdo\n§\nSegundo recuerdo');
    unlinkSync(`${memory}.lock`);
    const elsewhere = join(f.base, 'otra-memoria'); mkdirSync(elsewhere); writeFileSync(join(elsewhere, 'MEMORY.md'), 'Ajena');
    rmSync(join(f.home, 'memories'), { recursive: true }); symlinkSync(elsewhere, join(f.home, 'memories'));
    await assert.rejects(saveProfileFile(f.discovery, f.backups, f.alpha.id, 'MEMORY.md', { entries: ['x'], revision: fileRevision('Ajena') }));
    assert.equal(readFileSync(join(elsewhere, 'MEMORY.md'), 'utf8'), 'Ajena');
  } finally { f.close(); }
});

test('editar perfil: una entrada que acaba en una clave sin valor no se funde con la siguiente', () => {
  const masked = maskSecrets('Correo del banco, contraseña:\n§\nVive en Valencia').text;
  assert.equal(masked.split('\n§\n').length, 2);
  assert.match(masked, /Vive en Valencia/);
});
