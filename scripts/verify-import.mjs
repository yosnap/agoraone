import { chromium } from '@playwright/test';
import { appUrl } from './verify-targets.mjs';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const live = process.argv.includes('--live');
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  let calls = 0;
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/messages')) calls++; });
  await page.goto(appUrl(4317));
  await page.getByRole('button', { name: 'Luma', exact: true }).click();
  await page.getByRole('button', { name: 'Documentos', exact: true }).click();
  const marker = `NUBE-${Date.now()}`;
  const importedResponse = page.waitForResponse(r => r.url().endsWith('/api/library/imports'));
  await page.getByLabel('Archivo para importar').setInputFiles({
    name: 'mi-prueba.md', mimeType: 'text/markdown', buffer: Buffer.from(`# Prueba de importación\nLa clave de este documento es ${marker}.\nDocumento ficticio generado por la verificación.`),
  });
  const imported = await importedResponse;
  assert.equal(imported.status(), 201);
  const { id } = await imported.json();
  await page.getByText(`La clave de este documento es ${marker}.`, { exact: false }).waitFor();
  assert.equal(calls, 0);
  await page.reload();
  await page.getByRole('button', { name: 'Luma', exact: true }).click();
  await page.getByRole('button', { name: 'Documentos', exact: true }).click();
  await page.getByRole('button', { name: /mi-prueba.md/ }).click();
  await page.getByText(marker, { exact: false }).waitFor();
  const other = await browser.newContext();
  const denied = await other.request.get(`http://127.0.0.1:4317/api/library/documents/${id}`);
  assert.equal(denied.status(), 404);
  const list = await (await other.request.get('http://127.0.0.1:4317/api/library/documents')).json();
  assert.ok(!list.documents.some(d => d.id === id));
  await other.close();
  await page.getByRole('button', { name: 'Consultar este documento con Luma' }).click();
  if (live) {
    await page.getByLabel('Tu mensaje a Luma').fill('¿Cuál es la clave de este documento? Responde con la clave exacta y cita el título.');
    await page.getByRole('button', { name: 'Enviar a Hermes' }).click();
    await page.waitForFunction(() => !document.querySelector('.detail-panel:not([hidden]) .chat textarea')?.disabled, null, { timeout: 125_000 });
    assert.equal(await page.locator('[role="alert"]').count(), 0);
    assert.ok((await page.locator('.message.assistant').innerText()).includes(marker));
    console.log('Hermes real ha respondido usando la clave del archivo importado.');
  }
  assert.equal(calls, live ? 1 : 0);
  await page.getByRole('button', { name: 'Documentos', exact: true }).click();
  await page.getByLabel('Archivo para importar').setInputFiles({ name: 'incorrecto.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-demo') });
  await page.getByRole('alert').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  mkdirSync('.agora', { recursive: true });
  await page.screenshot({ path: '.agora/import-mobile.png' });
  assert.deepEqual(errors, []);
  console.log('Importación, recarga, aislamiento, rechazo de formato y móvil: OK.');
} finally { await browser.close(); }
