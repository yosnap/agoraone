import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUpload, uploadSchema } from './document-extraction';
import { pdfFixture, docxFixture } from './document-fixtures';

test('extrae PDF y DOCX reales como texto, sin HTML ni acceso por rutas', async () => {
  for (const [name, bytes, expected] of [
    ['prueba.pdf', pdfFixture(), 'FARO-842'],
    ['prueba.docx', await docxFixture('Español: áéíóú, <script>texto</script> LUNA-913'), 'áéíóú'],
  ] as const) {
    const extracted = await extractUpload({ name, base64: bytes.toString('base64') });
    assert.equal(extracted.name, name);
    assert.ok(Buffer.from(extracted.base64, 'base64').toString().includes(expected));
  }
  assert.equal(uploadSchema.safeParse({ name: '../a.pdf', base64: 'AAAA' }).success, false);
  assert.equal(uploadSchema.safeParse({ name: 'a.docx', base64: 'AAAA', path: '/etc/hosts' }).success, false);
});

test('rechaza archivos dañados, vacíos, demasiado grandes, sin texto y expansión ZIP', async () => {
  for (const [name, bytes] of [
    ['falso.pdf', Buffer.from('Texto normal')], ['falso.docx', Buffer.from('PKbad')],
    ['vacio.pdf', pdfFixture('')], ['vacio.docx', await docxFixture('')],
    ['largo.docx', await docxFixture('a'.repeat(24577))],
    ['expandido.docx', await docxFixture('test', true)],
    ['paginas.pdf', pdfFixture('texto', 101)],
    ['grande.pdf', Buffer.alloc(5 * 1024 * 1024 + 1)],
  ] as const) await assert.rejects(extractUpload({ name, base64: bytes.toString('base64') }));
});
