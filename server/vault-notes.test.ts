import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { VaultNotes, VaultError } from './vault-notes';
import { obsidianVaults } from './resource-discovery';

function fixture() {
  const base = realpathSync(mkdtempSync(join(process.cwd(), '.agora-vault-test-')));
  const vault = join(base, 'Mi vault'), outside = join(base, 'fuera');
  mkdirSync(join(vault, 'Proyectos/Activos'), { recursive: true });
  mkdirSync(join(vault, '.obsidian')); mkdirSync(join(vault, '.trash')); mkdirSync(outside);
  writeFileSync(join(vault, 'Inicio.md'), '# Inicio\nBienvenida al vault.');
  writeFileSync(join(vault, 'Proyectos/Activos/Jardín.md'), 'Plan del jardín\nRegar las TOMATERAS cada mañana.');
  writeFileSync(join(vault, 'Proyectos/Largo.md'), `${'x'.repeat(30 * 1024)}FINAL_OCULTO`);
  writeFileSync(join(vault, 'Proyectos/Roto.md'), Buffer.from([0xff, 0xfe, 0x00]));
  writeFileSync(join(vault, '.obsidian/workspace.md'), 'CANARY_CONFIG');
  writeFileSync(join(vault, '.trash/Borrada.md'), 'CANARY_TRASH');
  writeFileSync(join(vault, 'foto.png'), 'CANARY_ATTACHMENT');
  writeFileSync(join(outside, 'secreto.md'), 'CANARY_OUTSIDE');
  symlinkSync(join(outside, 'secreto.md'), join(vault, 'Enlace.md'));
  symlinkSync(outside, join(vault, 'Carpeta enlazada'));
  const registry = join(base, 'obsidian.json');
  writeFileSync(registry, JSON.stringify({ vaults: { a: { path: vault } } }));
  const notes = new VaultNotes(registry);
  const vaultId = obsidianVaults(registry).vaults[0].id;
  return { notes, vaultId, vault, close: () => rmSync(base, { recursive: true, force: true }) };
}

test('vault: lista solo notas Markdown propias, sin carpetas ocultas, adjuntos ni enlaces simbólicos', () => {
  const { notes, vaultId, close } = fixture();
  try {
    const list = notes.list(vaultId);
    assert.equal(list.vault.name, 'Mi vault');
    assert.deepEqual(list.notes.map(note => `${note.folder}|${note.title}`).sort(), ['Proyectos/Activos|Jardín', 'Proyectos|Largo', 'Proyectos|Roto', '|Inicio'].sort());
    assert.doesNotMatch(JSON.stringify(list), /CANARY|\/Users|fuera|file/);
    assert.ok(list.notes.every(note => /^note-[0-9a-f]{24}$/.test(note.id)));
    assert.throws(() => notes.list('vault-desconocido'), VaultError);
  } finally { close(); }
});

test('vault: lectura por ID opaco, UTF-8 estricto y búsqueda sin tildes ni mayúsculas', () => {
  const { notes, vaultId, close } = fixture();
  try {
    const list = notes.list(vaultId).notes;
    const garden = list.find(note => note.title === 'Jardín')!;
    const read = notes.read(vaultId, garden.id);
    assert.match(read.content, /TOMATERAS/);
    assert.match(read.revision, /^[0-9a-f]{64}$/);
    assert.throws(() => notes.read(vaultId, list.find(note => note.title === 'Roto')!.id), VaultError);
    assert.throws(() => notes.read(vaultId, 'note-000000000000000000000000'), VaultError);
    assert.deepEqual(notes.search(vaultId, 'jardin').results.map(item => item.title), ['Jardín']);
    assert.equal(notes.search(vaultId, 'tomateras').results[0].snippet, 'Regar las TOMATERAS cada mañana.');
    assert.equal(notes.search(vaultId, 'CANARY').results.length, 0);
  } finally { close(); }
});

test('vault: una nota enviada a consulta se recorta a 24 KiB y lo indica', () => {
  const { notes, vaultId, close } = fixture();
  try {
    const long = notes.list(vaultId).notes.find(note => note.title === 'Largo')!;
    const document = notes.document(long.id);
    assert.equal(document.title, 'Mi vault · Proyectos/Largo');
    assert.doesNotMatch(document.content, /FINAL_OCULTO/);
    assert.match(document.content, /\[Nota recortada a 24 KiB para la consulta\]$/);
    assert.ok(Buffer.byteLength(document.content) <= 24 * 1024, 'el documento completo cabe en el límite del puente');
    assert.throws(() => notes.document('note-000000000000000000000000'), VaultError);
  } finally { close(); }
});

test('vault: las líneas que parecen claves se ocultan al leer, buscar y consultar, salvo petición explícita', () => {
  const { notes, vaultId, vault, close } = fixture();
  try {
    writeFileSync(join(vault, 'Cuentas.md'), 'Servicio de correo\npassword: CANARY_NOTE_SECRET\nRenovar en marzo.');
    const id = notes.list(vaultId).notes.find(note => note.title === 'Cuentas')!.id;
    const read = notes.read(vaultId, id);
    assert.equal(read.hidden, 1); assert.doesNotMatch(read.content, /CANARY/); assert.match(read.content, /Renovar en marzo/);
    assert.match(notes.read(vaultId, id, true).content, /CANARY_NOTE_SECRET/);
    assert.doesNotMatch(JSON.stringify(notes.search(vaultId, 'canary')), /CANARY/);
    assert.doesNotMatch(notes.document(id).content, /CANARY/);
  } finally { close(); }
});

test('vault: una carpeta ilegible no impide listar el resto del vault', () => {
  const { notes, vaultId, close } = fixture();
  const all = notes.list(vaultId).notes.length;
  const folder = join(notes['index'](vaultId).vault.root, 'Proyectos/Activos');
  try {
    chmodSync(folder, 0o000);
    notes['indexes'].clear();
    const after = notes.list(vaultId);
    assert.ok(after.notes.some(note => note.title === 'Inicio'));
    assert.ok(after.notes.length < all);
    assert.equal(after.truncated, true);
  } finally { chmodSync(folder, 0o755); close(); }
});

test('puente: los patrones de documentos permitidos aceptan notas y copias, y nada más', () => {
  // The Python bridge keeps its own allowlist; this keeps it in step with the IDs the backend issues.
  const source = readFileSync(join(process.cwd(), 'server/hermes_bridge.py'), 'utf8');
  const patterns = [...source.matchAll(/re\.fullmatch\(r"([^"]+)", document_id\)/g)].map(match => new RegExp(`^${match[1]}$`));
  const allowed = (id: string) => ['welcome', 'orbital-garden'].includes(id) || patterns.some(pattern => pattern.test(id));
  assert.ok(allowed(`note-${'a'.repeat(24)}`));
  assert.ok(allowed('import-12345678-abcd-abcd-abcd-123456789abc'));
  assert.ok(!allowed('note-../../etc'));
  assert.ok(!allowed(`note-${'a'.repeat(25)}`));
});
