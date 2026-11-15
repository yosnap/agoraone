import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { appUrl } from './verify-targets.mjs';
// Watson proposes a mail rule: the answer is served by the test (no model, nothing reaches the core's data).
// The rule shows exactly as it would be created, nothing is written until it is confirmed, and a plain «sí»
// creates it once; discreet mode hides its details.
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], accepted = [];
page.on('pageerror', e => errors.push(e.message));
const rule = { name: 'Facturas de Proveedor', sender: 'facturas@proveedor.com', action: 'invoice' };
const sse = (kind, data) => `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
const messages = [];
await page.route('**/api/core/alerts/due', route => route.fulfill({ json: { notifications: [] } }));
await page.route('**/api/core/mail/inbox/announce', route => route.fulfill({ json: { items: [] } }));
await page.route('**/api/core/assistant/conversations', route => route.request().method() === 'POST'
  ? route.fulfill({ status: 201, json: { id: 99, persona: 'watson' } })
  : route.fulfill({ json: { conversations: [] } }));
await page.route('**/api/core/assistant/conversations/99', route => route.fulfill({ json: { id: 99, title: 'Prueba', messages } }));
await page.route('**/api/core/assistant/conversations/99/messages', route => {
  messages.push({ role: 'user', content: 'Marca como factura lo de facturas@proveedor.com', sources: [] },
    { role: 'assistant', content: 'Te la he dejado en pantalla para que la confirmes.', sources: [], engine: 'claude-code', model: 'sonnet' });
  return route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: [
    sse('stage', { stage: 'recuerda' }), sse('sources', { sources: [] }), sse('stage', { stage: 'piensa' }),
    sse('tool', { tool: 'rule_proposal', id: 'p1', rule }), sse('sources', { sources: [] }),
    sse('stage', { stage: 'responde', engine: 'claude-code', model: 'sonnet' }), sse('delta', { text: 'Te la he dejado en pantalla para que la confirmes.' }),
    sse('done', { engine: 'claude-code', model: 'sonnet' })].join('') });
});
await page.route('**/api/core/assistant/proposals/p1/accept', route => { accepted.push('p1'); return route.fulfill({ status: 201, json: { id: 7, name: rule.name } }); });
await page.goto(appUrl(5173, 'asistente'));
const input = page.locator('#assistant-input');
await input.waitFor({ timeout: 60_000 });
await input.fill('Marca como factura lo de facturas@proveedor.com');
await input.press('Enter');
const card = page.getByRole('article', { name: 'Regla propuesta' });
await card.waitFor({ timeout: 30_000 });
await card.getByText('facturas@proveedor.com').waitFor();
await card.getByRole('button', { name: 'Crear regla' }).waitFor();
assert.equal(accepted.length, 0, 'proponer no crea nada');
if (shots) await page.screenshot({ path: `${shots}/watson-rule.png` });
await page.getByRole('button', { name: /discreto/i }).first().click();
assert.equal(await card.getByText('facturas@proveedor.com').count(), 0, 'en modo discreto no se ve el remitente');
assert.ok(await card.getByRole('button', { name: 'Crear regla' }).isDisabled(), 'en modo discreto no se puede confirmar');
await page.getByRole('button', { name: /discreto/i }).first().click();
await input.fill('sí');
await input.press('Enter');
await card.getByText('Regla «Facturas de Proveedor» creada').waitFor();
assert.deepEqual(accepted, ['p1'], 'un «sí» la crea una sola vez, sin pasar por el modelo');
assert.equal(await card.getByRole('button', { name: 'Crear regla' }).count(), 0);
assert.deepEqual(errors, [], 'sin errores JS');
console.log('regla propuesta por Watson y creada solo al confirmar: correcto');
await browser.close();
