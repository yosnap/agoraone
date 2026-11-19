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
  await page.goto(appUrl(5173, 'ajustes&pestana=correo'));
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
  // The fiscal folders live in their own tab of Settings.
  await page.getByRole('tab', { name: 'Fiscal' }).click();
  const fiscalCard = page.locator('article', { has: page.getByRole('heading', { name: 'Carpetas fiscales' }) });
  await fiscalCard.locator('.mail-accounts').waitFor();
  console.log(`${viewport.width}px · carpetas fiscales: ${await fiscalCard.locator('.mail-accounts > li:not(.muted) .compact-name').count()}`);
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
await page.route('**/api/core/fiscal/invoices/prepare', route => route.fulfill({ status: 422, json: { error: 'Elige primero la carpeta fiscal en Ajustes.' } }));
page.on('pageerror', e => errors.push(e.message));
await page.route('**/api/core/mail/inbox?state=pending', route => route.fulfill({ json: { items: [sample], counts: { pending: 1, done: 0, dismissed: 0, unread: 0 }, problem: null } }));
await page.route('**/api/core/mail/inbox/announce', route => route.fulfill({ json: { items: [sample] } }));
await page.route('**/api/core/mail/inbox/1', route => { decided.push(route.request().postDataJSON().state); return route.fulfill({ json: { ok: true } }); });
await page.goto(appUrl(5173, 'bandeja'));
const card = page.locator('.inbox-card');
await card.waitFor({ timeout: 60_000 });
assert.ok(await page.getByRole('heading', { name: /Ejemplo/ }).count(), 'agrupada por ámbito');
// Filing the invoice: prepared from the message, edited by the user, written only on «Archivar».
const prepared = { folders: [{ id: 1, name: 'Autónomo', kind: 'autonomo', path: '/x', scopeId: null }], folderId: 1, source: { kind: 'attachment', part: 2, name: 'factura.pdf' }, sources: [{ kind: 'attachment', part: 2, name: 'factura.pdf' }], links: [], doubts: ['No aparece el NIF del proveedor.'],
  proposal: { supplier: 'Proveedor de ejemplo', taxId: null, issuedOn: '2026-11-13', total: '12.50', currency: 'EUR' },
  destination: 'Facturas Entrantes/2026/4T/2026-11-13 Proveedor de ejemplo 12,50.pdf' };
const filed = [];
await page.route('**/api/core/fiscal/invoices/prepare', route => route.fulfill({ json: prepared }));
await page.route('**/api/core/fiscal/invoices', route => { filed.push(route.request().postDataJSON()); return route.fulfill({ status: 201, json: { id: 1, path: prepared.destination, quarter: '2026-4T' } }); });
await card.getByRole('button', { name: 'Descargar y archivar la factura…' }).click();
await card.getByText('No aparece el NIF del proveedor.').waitFor();
assert.equal(filed.length, 0, 'preparar no archiva');
await card.getByLabel('Proveedor').fill('Proveedor Uno');
assert.ok(await card.getByText('Facturas Entrantes/2026/4T/2026-11-13 Proveedor Uno 12,50.pdf').count(), 'el destino sigue a los datos');
await card.getByRole('button', { name: 'Archivar la factura' }).click();
await page.getByText(/Factura archivada en/).waitFor();
assert.equal(filed[0].fields.supplier, 'Proveedor Uno');
assert.deepEqual(filed[0].source, { kind: 'attachment', part: 2 });
await page.goto(appUrl(5173, 'asistente'));
const notice = page.locator('.announcement');
await notice.waitFor({ timeout: 60_000 });
assert.match(await notice.innerText(), /Tienes una factura de Proveedor de ejemplo \(12,50 €\)/);
await page.locator('#assistant-input').fill('no');
await page.locator('#assistant-input').press('Enter');
await page.getByText('«Tu factura de noviembre»: descartado en la Bandeja.').waitFor();
assert.deepEqual(decided, ['dismissed'], '«no» descarta el aviso sin pasar por el modelo');
if (shots) await page.screenshot({ path: `${shots}/announcement.png` });
assert.deepEqual(errors, [], 'sin errores JS');
console.log('tarjeta de ejemplo y aviso de Watson: correctos');

// WhatsApp's cards with sample data (no real conversation, nothing written): both sources in one list, the source
// filter, the latest messages read from the core only (never from Zernio nor any address outside loopback) and the
// discreet mode hiding the number, the summary and the messages.
const chatSample = { id: 1, kind: 'client', source: 'model', ruleId: null, ruleName: null, label: 'Instinct', confidentiality: 'normal', state: 'pending',
  summary: 'Quiere mover la cita al lunes.', details: { asks: ['Mover la cita al lunes'], dates: ['2026-11-24'] },
  participant: { name: 'Contacto de ejemplo', phone: '+34 600 000 000' }, account: { id: 1, phone: '+34 600 999 999', label: 'Mi número' },
  client: null, attachments: { image: 1 }, scope: { id: 1, name: 'Ejemplo', color: null }, lastIncomingAt: '2026-11-19T08:00:00Z', updatedAt: '2026-11-19T08:00:00Z' };
const chatPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const chatErrors = [], outside = [], chatCalls = [];
chatPage.on('pageerror', e => chatErrors.push(e.message));
chatPage.on('request', r => {
  const url = new URL(r.url());
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.protocol.startsWith('data')) outside.push(url.hostname);
  if (url.pathname.includes('/api/core/chat/')) chatCalls.push(`${r.method()} ${url.pathname}`);
});
await chatPage.route('**/api/core/modules', async route => {
  const response = await route.fetch();
  const json = await response.json();
  return route.fulfill({ response, json: { ...json, modules: { ...json.modules, whatsapp: true } } });
});
await chatPage.route('**/api/core/mail/inbox?state=pending', route => route.fulfill({ json: { items: [sample], counts: { pending: 1, done: 0, dismissed: 0, unread: 0 }, problem: null } }));
await chatPage.route('**/api/core/chat/settings', route => route.fulfill({ json: { hasKey: true, accounts: [], lastSync: null } }));
await chatPage.route('**/api/core/chat/summaries?state=pending', route => route.fulfill({ json: { items: [chatSample], counts: { pending: 1, done: 0, dismissed: 0, quiet: 0 }, problem: null } }));
await chatPage.route('**/api/core/chat/summaries/1/messages', route => route.fulfill({ json: { messages: [
  { id: 1, direction: 'incoming', at: '2026-11-19T07:59:00Z', text: '<b>¿Podemos</b> moverla al lunes?', unsupported: false, attachments: [] },
  { id: 2, direction: 'incoming', at: '2026-11-19T08:00:00Z', text: null, unsupported: false, attachments: ['image'] },
  { id: 3, direction: 'outgoing', at: '2026-11-19T08:01:00Z', text: null, unsupported: true, attachments: [] }] } }));
await chatPage.goto(appUrl(5173, 'bandeja'));
const chatCard = chatPage.locator('.chat-card');
await chatCard.waitFor({ timeout: 60_000 });
assert.equal(await chatPage.locator('.inbox-card').count(), 2, 'correo y WhatsApp en la misma lista');
assert.ok(await chatCard.getByText('WhatsApp', { exact: true }).count(), 'distintivo de WhatsApp');
assert.ok(await chatCard.getByText('Instinct', { exact: true }).count(), 'etiqueta de la regla');
assert.match(await chatPage.getByRole('button', { name: /^Pendientes/ }).innerText(), /· 2/, 'las pestañas suman las dos fuentes');
await chatPage.locator('.inbox-tools label.field', { hasText: 'Fuente' }).locator('.modern-select button').first().click();
await chatPage.getByRole('option', { name: 'WhatsApp' }).click();
assert.equal(await chatPage.locator('.inbox-card').count(), 1, 'el filtro deja solo WhatsApp');
assert.equal(await chatPage.locator('.page select').count(), 0, 'ningún select nativo');
const before = chatCalls.length;
await chatCard.getByRole('button', { name: 'Ver mensajes' }).click();
await chatCard.locator('.chat-message').first().waitFor();
assert.deepEqual(chatCalls.slice(before), ['GET /api/core/chat/summaries/1/messages'], 'abrir los mensajes solo lee el núcleo');
assert.ok(await chatCard.getByText('<b>¿Podemos</b> moverla al lunes?').count(), 'el texto sale tal cual, sin interpretar marcado');
assert.ok(await chatCard.getByText('Mensaje no disponible').count() && await chatCard.getByText('imagen', { exact: true }).count());
assert.equal(await chatCard.locator('.chat-messages a').count(), 0, 'sin enlaces');
if (shots) await chatPage.screenshot({ path: `${shots}/inbox-whatsapp.png` });
await chatPage.getByRole('button', { name: /discreto/i }).first().click();
await chatCard.getByText('Resumen y mensajes ocultos en modo discreto.').waitFor();
assert.equal(await chatCard.getByText(/600 000 000|Quiere mover|moverla al lunes/).count(), 0, 'el discreto oculta número, resumen y mensajes');
assert.ok(await chatCard.getByText('Contacto de ejemplo').count(), 'el nombre se ve, como el remitente de un correo');
await chatPage.getByRole('button', { name: /discreto/i }).first().click();
assert.deepEqual(outside, [], 'ninguna petición fuera de loopback');
assert.deepEqual(chatErrors, [], 'sin errores JS');
console.log('tarjetas de WhatsApp de ejemplo, filtro, mensajes y modo discreto: correctos');
await browser.close();
