import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, readFileSync, chmodSync, readdirSync, linkSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { VaultNotes, VaultError, VaultWriteError } from './vault-notes';
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
  return { notes, vaultId, vault, base, close: () => rmSync(base, { recursive: true, force: true }) };
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

const failsWith = (run: () => unknown, status: number) => assert.throws(run, error => error instanceof VaultWriteError && error.status === status);
const byTitle = (notes: VaultNotes, vaultId: string, title: string) => notes.list(vaultId).notes.find(note => note.title === title)!;

test('vault editable: guarda con copia previa, conserva las líneas ocultas y respeta los cambios hechos fuera', () => {
  const { notes, vaultId, vault, base, close } = fixture();
  const backups = join(base, 'copias');
  try {
    writeFileSync(join(vault, 'Claves.md'), 'Servicio\napi_key: CANARY_VAULT_KEY\nfin');
    chmodSync(join(vault, 'Claves.md'), 0o640);
    const note = byTitle(notes, vaultId, 'Claves');
    const opened = notes.read(vaultId, note.id);
    assert.doesNotMatch(opened.content, /CANARY/);
    const saved = notes.save(vaultId, note.id, { content: opened.content.replace('fin', 'final editado'), revision: opened.revision }, backups);
    const disk = readFileSync(join(vault, 'Claves.md'), 'utf8');
    assert.equal(disk, 'Servicio\napi_key: CANARY_VAULT_KEY\nfinal editado', 'la línea oculta vuelve de disco');
    assert.equal(statSync(join(vault, 'Claves.md')).mode & 0o777, 0o640, 'conserva los permisos');
    assert.equal(notes.read(vaultId, note.id).revision, saved.revision, 'el listado y la lectura ven la versión nueva');
    const copies = readdirSync(join(backups, vaultId));
    assert.equal(copies.length, 1); assert.equal(readFileSync(join(backups, vaultId, copies[0]), 'utf8'), 'Servicio\napi_key: CANARY_VAULT_KEY\nfin');
    assert.ok(!readdirSync(vault).some(name => name.includes('.agora-')), 'sin temporales');
    // Changed in Obsidian meanwhile: the old revision no longer saves.
    writeFileSync(join(vault, 'Claves.md'), 'otra cosa');
    failsWith(() => notes.save(vaultId, note.id, { content: 'pisado', revision: saved.revision }, backups), 409);
    assert.equal(readFileSync(join(vault, 'Claves.md'), 'utf8'), 'otra cosa');
    const fresh = notes.read(vaultId, note.id);
    failsWith(() => notes.save(vaultId, note.id, { content: 'a\u0007b', revision: fresh.revision }, backups), 400);
    failsWith(() => notes.save(vaultId, 'note-' + '0'.repeat(24), { content: 'x', revision: fresh.revision }, backups), 404);
  } finally { close(); }
});

test('vault editable: no escribe a través de enlaces ni crea fuera de carpetas existentes o pisando notas', () => {
  const { notes, vaultId, vault, base, close } = fixture();
  const backups = join(base, 'copias');
  try {
    // A note that became a hard link after it was listed is refused, and nothing is written.
    const note = byTitle(notes, vaultId, 'Inicio');
    const { revision } = notes.read(vaultId, note.id);
    linkSync(join(vault, 'Inicio.md'), join(base, 'segundo-nombre.md'));
    failsWith(() => notes.save(vaultId, note.id, { content: 'cambio', revision }, backups), 404);
    assert.equal(readFileSync(join(vault, 'Inicio.md'), 'utf8'), '# Inicio\nBienvenida al vault.');

    const created = notes.create(vaultId, 'Proyectos/Activos', 'Huerto nuevo', '# Huerto\nSemillas.');
    assert.equal(readFileSync(join(vault, 'Proyectos/Activos/Huerto nuevo.md'), 'utf8'), '# Huerto\nSemillas.');
    assert.equal(byTitle(notes, vaultId, 'Huerto nuevo').id, created.id, 'aparece en el listado al momento');
    failsWith(() => notes.create(vaultId, 'Proyectos/Activos', 'Huerto nuevo', 'pisar'), 409);
    assert.equal(readFileSync(join(vault, 'Proyectos/Activos/Huerto nuevo.md'), 'utf8'), '# Huerto\nSemillas.');
    for (const title of ['../fuera', 'a/b', '.oculta', '', 'x'.repeat(260), 'ñ'.repeat(130), 'a:b', 'a\u202eb']) failsWith(() => notes.create(vaultId, '', title, 'x'), 400);
    failsWith(() => notes.create(vaultId, 'Carpeta enlazada', 'Nota', 'x'), 404);
    failsWith(() => notes.create(vaultId, '../fuera', 'Nota', 'x'), 404);
    failsWith(() => notes.create(vaultId, 'No existe', 'Nota', 'x'), 404);
    assert.equal(existsSync(join(base, 'fuera', 'Nota.md')), false);
    notes.create(vaultId, '', 'En la raíz', 'texto');
    assert.equal(readFileSync(join(vault, 'En la raíz.md'), 'utf8'), 'texto');
  } finally { close(); }
});

test('vault editable: conserva el mismo archivo, los finales de línea, el BOM y los permisos, y no toca notas con caracteres de control', () => {
  const { notes, vaultId, vault, base, close } = fixture();
  const backups = join(base, 'copias');
  try {
    writeFileSync(join(vault, 'Control.md'), 'texto\u000cpágina');
    const crlf = join(vault, 'Windows.md');
    writeFileSync(crlf, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('uno\r\napi_key: CANARY_CRLF\r\ndos')]));
    chmodSync(crlf, 0o664);
    const before = statSync(crlf);
    const note = byTitle(notes, vaultId, 'Windows');
    const opened = notes.read(vaultId, note.id);
    notes.save(vaultId, note.id, { content: opened.content.replace('dos', 'tres'), revision: opened.revision }, backups);
    const bytes = readFileSync(crlf);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'el BOM se conserva');
    assert.equal(bytes.subarray(3).toString(), 'uno\r\napi_key: CANARY_CRLF\r\ntres', 'CRLF en todas las líneas, también la oculta');
    const after = statSync(crlf);
    assert.equal(after.ino, before.ino, 'el mismo archivo: Obsidian conserva su fecha de creación');
    assert.equal(after.mode & 0o777, 0o664);
    assert.equal(notes.read(vaultId, note.id).revision, notes.read(vaultId, note.id).revision);

    const control = byTitle(notes, vaultId, 'Control');
    const read = notes.read(vaultId, control.id);
    failsWith(() => notes.save(vaultId, control.id, { content: 'nuevo', revision: read.revision }, backups), 400);
    assert.equal(readFileSync(join(vault, 'Control.md'), 'utf8'), 'texto\u000cpágina');
  } finally { close(); }
});
