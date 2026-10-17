import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, linkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrivateLibrary } from './private-library';

test('importación privada: persistencia, permisos, propietarios y nombres sin rutas', () => {
  const root = mkdtempSync(join(process.cwd(), '.agora-import-test-'));
  const owner = 'a'.repeat(64), other = 'b'.repeat(64);
  const input = { name: 'notas.md', base64: Buffer.from('# Lectura\nSolo mi archivo.').toString('base64') };
  try {
    const library = new PrivateLibrary(root);
    const document = library.import(input, owner);
    assert.match(document.id, /^import-/);
    assert.equal(new PrivateLibrary(root).read(document.id, owner).content, '# Lectura\nSolo mi archivo.');
    assert.equal(library.list(owner).length, 1);
    assert.deepEqual(library.list(other), []);
    assert.throws(() => library.read(document.id, other));
    const file = join(root, owner, `${document.id}.json`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, owner)).mode & 0o777, 0o700);
    assert.ok(!readFileSync(file, 'utf8').includes('originalPath'));
    for (const name of ['../notas.txt', '/tmp/notas.txt', 'a\\b.md', '.env', 'foto.exe', 'x\0.txt']) {
      assert.throws(() => library.import({ ...input, name }, owner));
    }
    assert.throws(() => library.import({ ...input, owner: other }, owner));
    const link = join(root, owner, 'linked.json'); linkSync(file, link);
    assert.throws(() => library.read(document.id, owner)); unlinkSync(link);
    unlinkSync(file); symlinkSync('/etc/hosts', file);
    assert.throws(() => library.read(document.id, owner));
  } finally { rmSync(root, { recursive: true }); }
});

test('importación privada: rechaza binarios, UTF-8 inválido, tamaño, vacíos y cuota', () => {
  const root = mkdtempSync(join(process.cwd(), '.agora-import-test-'));
  const owner = 'a'.repeat(64);
  try {
    const library = new PrivateLibrary(root);
    for (const bytes of [Buffer.from([255, 254]), Buffer.from('a\0b'), Buffer.alloc(24577, 65), Buffer.from('   '), Buffer.alloc(0)]) {
      assert.throws(() => library.import({ name: 'test.txt', base64: bytes.toString('base64') }, owner));
    }
    assert.throws(() => library.import({ name: 'test.txt', base64: '!invalid!' }, owner));
    const input = { name: 'test.txt', base64: Buffer.from('test').toString('base64') };
    for (let index = 0; index < 100; index++) library.import(input, owner);
    assert.throws(() => library.import(input, owner), /100/);
    assert.equal(library.list(owner).length, 100);
  } finally { rmSync(root, { recursive: true }); }
});

test('renombrado persistente conserva bytes/ID/revisión; borrar libera cuota y rechaza enlaces', () => {
  const root = mkdtempSync(join(process.cwd(), '.agora-import-test-'));
  const owner = 'a'.repeat(64);
  try {
    const library = new PrivateLibrary(root);
    const imported = library.import({ name: 'notas.md', base64: Buffer.from('\ufeff# Texto\r\n').toString('base64') }, owner);
    const file = join(root, owner, `${imported.id}.json`);
    const before = JSON.parse(readFileSync(file, 'utf8'));
    library.rename(imported.id, owner, { title: 'Notas renombradas' });
    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(after.base64, before.base64);
    assert.equal(after.name, before.name);
    const persisted = new PrivateLibrary(root).read(imported.id, owner);
    assert.equal(persisted.title, 'Notas renombradas'); assert.equal(persisted.revision, imported.revision);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const link = `${file}.hardlink`; linkSync(file, link);
    assert.throws(() => library.rename(imported.id, owner, { title: 'No' }));
    assert.throws(() => library.delete(imported.id, owner)); unlinkSync(link);
    library.delete(imported.id, owner);
    assert.deepEqual(library.list(owner), []);
    assert.throws(() => library.read(imported.id, owner));
    assert.throws(() => library.delete(imported.id, owner));
    assert.throws(() => library.rename(imported.id, owner, { title: 'No' }));
  } finally { rmSync(root, { recursive: true }); }
});
