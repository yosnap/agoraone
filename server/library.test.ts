import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, unlinkSync, linkSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Library, LibraryError } from './library';

test('biblioteca: registro por ID, UTF-8, contenido y revisión', () => {
  // realpath removes macOS /var -> /private/var alias, as production denies aliases.
  const directory = mkdtempSync(join(process.cwd(), '.agora-library-test-'));
  try {
    writeFileSync(join(directory, 'bienvenida.txt'), 'Texto de prueba con acentos: lectura.');
    const library = new Library(directory);
    assert.equal(library.list().length, 2);
    const document = library.read('welcome');
    assert.match(document.content, /acentos/);
    assert.equal(document.revision.length, 64);
    writeFileSync(join(directory, 'bienvenida.txt'), 'Versión nueva');
    assert.notEqual(library.read('welcome').revision, document.revision);
    for (const id of ['../.env', '/etc/passwd', 'bienvenida.txt', '%2e%2e', 'constructor', 'unknown']) {
      assert.throws(() => library.read(id), LibraryError);
    }
  } finally { rmSync(directory, { recursive: true }); }
});

test('biblioteca: rechaza enlaces, raíz redirigida, tamaño excesivo y binarios', () => {
  const directory = mkdtempSync(join(process.cwd(), '.agora-library-test-'));
  const root = join(directory, 'root'); mkdirSync(root);
  const outside = join(directory, 'outside.txt'); writeFileSync(outside, 'No autorizado');
  const file = join(root, 'bienvenida.txt');
  const library = new Library(root);
  try {
    symlinkSync(outside, file); assert.throws(() => library.read('welcome'), LibraryError); unlinkSync(file);
    linkSync(outside, file); assert.throws(() => library.read('welcome'), LibraryError); unlinkSync(file);
    writeFileSync(file, 'x'.repeat(24577)); assert.throws(() => library.read('welcome'), LibraryError);
    writeFileSync(file, Buffer.from([0xff, 0xfe])); assert.throws(() => library.read('welcome'), LibraryError);
    writeFileSync(file, 'text\0data'); assert.throws(() => library.read('welcome'), LibraryError);
    writeFileSync(file, 'válido');
    const redirected = join(directory, 'alias'); symlinkSync(root, redirected);
    assert.throws(() => new Library(redirected).read('welcome'), LibraryError);
    unlinkSync(file); mkdirSync(file); assert.throws(() => library.read('welcome'), LibraryError);
  } finally { rmSync(directory, { recursive: true }); }
});
