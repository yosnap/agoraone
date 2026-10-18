import { chromium } from '@playwright/test';
import { appUrl } from './verify-targets.mjs';
import assert from 'node:assert/strict';
import { pdfFixture, docxFixture } from '../server/document-fixtures.ts';

const live = process.argv.includes('--live');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(appUrl(4317));
  await page.getByRole('button', { name: 'Luma', exact: true }).click();
  for (const extension of ['pdf', 'docx']) {
    await page.getByRole('button', { name: 'Documentos', exact: true }).click();
    const marker = `CLAVE-${extension.toUpperCase()}-${Date.now()}`;
    const text = `La clave del documento es ${marker}.`;
    const response = page.waitForResponse(r => r.url().endsWith('/api/library/imports'));
    await page.getByLabel('Archivo para importar').setInputFiles({ name: `prueba.${extension}`, mimeType: 'application/octet-stream', buffer: extension === 'pdf' ? pdfFixture(text) : await docxFixture(text) });
    assert.equal((await response).status(), 201);
    await page.getByText(marker, { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Consultar este documento con Luma' }).click();
    if (live) {
      await page.getByLabel('Tu mensaje a Luma').fill('¿Cuál es la clave exacta del documento adjunto actual?');
      const reply = page.waitForResponse(r => r.url().endsWith('/messages'), { timeout: 125000 });
      await page.getByRole('button', { name: 'Enviar a Hermes' }).click();
      const result = await reply;
      assert.equal(result.status(), 200);
      const event = (await result.text()).trim().split('\n').map(line => JSON.parse(line)).at(-1);
      assert.equal(event.type, 'done');
      assert.ok(event.conversation.messages.at(-1).content.includes(marker));
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Documentos', exact: true }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '.agora/formats-mobile.png' });
  assert.deepEqual(errors, []);
  console.log(`PDF y DOCX: importación, lectura, adjunto y móvil OK. Hermes real: ${live ? 'dos respuestas verificadas' : 'no invocado'}.`);
} finally { await browser.close(); }
