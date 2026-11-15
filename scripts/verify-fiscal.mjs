import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { appUrl } from './verify-targets.mjs';
// Fiscal, read only: the page loads with the quarter of the first professional folder (or says there is none),
// the quarters can be switched, nothing is written, no native selects, no horizontal scroll. Opening the page
// reads the folder's invoices as the app always does (already-read files come from the cache). Prints counts.
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: true });
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport });
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET' && !r.url().endsWith('/api/session')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.route('**/api/core/alerts/due', route => route.fulfill({ json: { notifications: [] } }));
  await page.goto(appUrl(5173, 'fiscal'));
  const fiscal = page.locator('section.fiscal');
  await fiscal.getByRole('heading', { name: 'Fiscal', level: 1 }).waitFor({ timeout: 60_000 });
  const quarters = fiscal.getByRole('group', { name: 'Trimestre' });
  await quarters.or(fiscal.getByText(/Añade una carpeta de tipo autónomo/)).or(fiscal.locator('.load-error')).first().waitFor({ timeout: 60_000 });
  if (await quarters.count()) {
    await quarters.getByRole('button').first().click();
    await quarters.getByRole('button').last().click();
  }
  console.log(`${viewport.width}px · ${await quarters.count() ? 'trimestre visible' : 'sin carpeta profesional'}`);
  assert.equal(await page.locator('.page select').count(), 0, 'ningún select nativo');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'sin desplazamiento horizontal');
  if (shots) await page.screenshot({ path: `${shots}/fiscal-${viewport.width}.png` });
  assert.deepEqual(writes, [], 'no se escribió nada');
  assert.deepEqual(errors, [], 'sin errores JS');
  await page.close();
}
console.log('fiscal en solo lectura: correcto');

// Receipts in Fiscal: one the user's bot left in «Recibos por revisar», and preparing the bot creates its
// skill only on «Crear la skill» (served by the test: nothing reaches Hermes).
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], skills = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/api/core/alerts/due', route => route.fulfill({ json: { notifications: [] } }));
await page.route('**/api/core/fiscal/folders', route => route.fulfill({ json: { folders: [{ id: 7, name: 'Autónomo', kind: 'autonomo', path: '/carpeta/de/prueba', scopeId: null, holder: null }] } }));
await page.route('**/api/core/fiscal/receipts', route => route.fulfill({ json: { inbox: 'Recibos por revisar', receipts: [
  { id: 1, name: '2026-11-14 gasolinera 40,00.jpg', mediaType: 'image/jpeg', bytes: 1000, fields: {}, uploadedAt: '2026-11-14T10:00:00Z', source: 'inbox', inboxFolder: 7 }] } }));
await page.route('**/api/hermes/profiles/*/skills', route => { skills.push(route.request().postDataJSON()); return route.fulfill({ status: 201, json: { id: 's1' } }); });
await page.goto(appUrl(5173, 'fiscal'));
const receipt = page.locator('.inbox-card', { hasText: '2026-11-14 gasolinera' });
await receipt.waitFor({ timeout: 60_000 });
await receipt.getByText('De tu bot').waitFor();
await page.getByRole('button', { name: 'Prepararlo' }).click();
await page.getByText('Recibir facturas por tu bot de Hermes').waitFor();
await page.getByText('Texto exacto de la skill').click();
await page.getByText('/carpeta/de/prueba/Recibos por revisar').first().waitFor();
assert.equal(skills.length, 0, 'preparar no crea nada');
await page.getByRole('button', { name: 'Crear la skill' }).click();
await page.getByText(/^Skill creada\./).waitFor();
assert.equal(skills.length, 1);
assert.equal(skills[0].category, 'agoraone');
assert.equal(skills[0].name, 'guardar-facturas');
assert.match(skills[0].body, /\/carpeta\/de\/prueba\/Recibos por revisar/);
assert.equal(await page.locator('.page select').count(), 0, 'ningún select nativo');
assert.deepEqual(errors, [], 'sin errores JS');
console.log('recibos en Fiscal y bot de Hermes preparado: correctos');
await browser.close();
