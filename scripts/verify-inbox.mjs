import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { appUrl } from './verify-targets.mjs';
// The Bandeja and Settings › mail rules, read only: the Bandeja loads with its tabs and cards (or says it is
// empty), and the rules card opens and cancels its form. Nothing is written; prints counts, never content.
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: true });
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport });
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET' && !r.url().endsWith('/api/session')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.goto(appUrl(5173, 'bandeja'));
  const inbox = page.locator('section.inbox');
  await inbox.getByRole('heading', { name: 'Bandeja' }).waitFor({ timeout: 60_000 });
  await inbox.locator('.inbox-cards, .muted').first().waitFor();
  console.log(`${viewport.width}px · tarjetas pendientes: ${await inbox.locator('.inbox-card').count()}`);
  for (const tab of ['Hechos', 'Descartados', 'Pendientes']) {
    await inbox.getByRole('button', { name: new RegExp(`^${tab}`) }).click();
  }
  await inbox.locator('.inbox-card, p.muted:has-text("No hay nada pendiente")').first().waitFor();
  assert.equal(await page.locator('.rail-pending', { hasText: 'Bandeja' }).count(), 0, 'la Bandeja ya no está marcada como pendiente');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'sin desplazamiento horizontal');
  if (shots) await page.screenshot({ path: `${shots}/inbox-${viewport.width}.png` });
  await page.goto(appUrl(5173, 'ajustes'));
  const rules = page.locator('article', { has: page.getByRole('heading', { name: 'Reglas del correo' }) });
  await rules.waitFor({ timeout: 60_000 });
  await rules.getByRole('button', { name: 'Añadir regla' }).click();
  await rules.getByLabel('Remitente o dominio').waitFor();
  await rules.locator('.modern-select button').first().click();
  await page.getByRole('option', { name: 'Cliente o proyecto' }).click();
  assert.equal(await page.getByRole('listbox').count(), 0, 'el desplegable se cierra al elegir');
  assert.equal(await page.locator('.page select').count(), 0, 'ningún select nativo');
  if (shots) await rules.screenshot({ path: `${shots}/mail-rules-${viewport.width}.png` });
  await rules.getByRole('button', { name: 'Cancelar' }).click();
  assert.deepEqual(writes, [], 'no se escribió nada');
  assert.deepEqual(errors, [], 'sin errores JS');
  await page.close();
}

// Rendering with sample cards, served by the test itself (no real mail, nothing reaches the backend's data):
// the Bandeja groups them by scope and Watson announces the pending one; a plain «no» dismisses it locally.
const sample = { id: 1, kind: 'invoice', source: 'model', ruleId: null, ruleName: null, confidentiality: 'normal', summary: 'Factura de ejemplo por 12,50 €.',
  details: { asks: ['Pagar antes del viernes'], amounts: ['12,50 €'], dates: ['2026-11-20'] }, state: 'pending', proposal: 'archive_invoice',
  suggestion: { sender: 'ejemplo.com', action: 'invoice', name: 'Facturas de ejemplo.com' }, from: { name: 'Proveedor de ejemplo', address: 'facturas@ejemplo.com' },
  subject: 'Tu factura de noviembre', sentAt: '2026-11-14T09:00:00Z', account: { id: 1, address: 'yo@ejemplo.com' }, scope: { id: 1, name: 'Ejemplo', color: null },
  attachments: 1, announcedAt: null };
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], decided = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/api/core/mail/inbox?state=pending', route => route.fulfill({ json: { items: [sample], counts: { pending: 1, done: 0, dismissed: 0, unread: 0 }, problem: null } }));
await page.route('**/api/core/mail/inbox/announce', route => route.fulfill({ json: { items: [sample] } }));
await page.route('**/api/core/mail/inbox/announced', route => route.fulfill({ json: { ok: true } }));
await page.route('**/api/core/mail/inbox/1', route => { decided.push(route.request().postDataJSON().state); return route.fulfill({ json: { ok: true } }); });
await page.goto(appUrl(5173, 'bandeja'));
const card = page.locator('.inbox-card');
await card.waitFor({ timeout: 60_000 });
assert.ok(await page.getByRole('heading', { name: /Ejemplo/ }).count(), 'agrupada por ámbito');
assert.ok(await card.getByRole('button', { name: 'Descargar y archivar la factura' }).isDisabled(), 'la acción que aún no existe no se puede pulsar');
assert.ok(await card.getByText('Pendiente: llega con las facturas de proveedores.').count());
await page.goto(appUrl(5173, 'asistente'));
const notice = page.locator('.announcement');
await notice.waitFor({ timeout: 60_000 });
assert.match(await notice.innerText(), /Tienes una factura de Proveedor de ejemplo \(12,50 €\)/);
await page.locator('#assistant-input').fill('no');
await page.locator('#assistant-input').press('Enter');
await page.getByText('Descartado en la Bandeja.').waitFor();
assert.deepEqual(decided, ['dismissed'], '«no» descarta el aviso sin pasar por el modelo');
if (shots) await page.screenshot({ path: `${shots}/announcement.png` });
assert.deepEqual(errors, [], 'sin errores JS');
console.log('tarjeta de ejemplo y aviso de Watson: correctos');
await browser.close();
