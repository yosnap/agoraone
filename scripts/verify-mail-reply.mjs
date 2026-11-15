import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { appUrl } from './verify-targets.mjs';
// Replying and the project note, with sample cards served by the test itself (no real mail, no real vault,
// nothing is sent): the reply is drafted, previewed and sent only with «Enviar» on the sealed preview; a private
// mail offers no Watson; a client's mail becomes one new note in the client's folder, created only on
// «Crear la nota», marked like the mail. Prints counts, never content.
const shots = process.env.SHOTS;
const base = { kind: 'client', source: 'rule', ruleId: 1, ruleName: 'Clientes', summary: 'Piden cambiar el texto de la portada.',
  details: { asks: ['Cambiar el texto de la portada'], dates: [], amounts: [] }, state: 'pending', proposal: 'add_to_project', suggestion: null,
  from: { name: 'Cliente de ejemplo', address: 'hola@cliente-uno.es' }, subject: 'Cambio en la portada', sentAt: '2026-11-14T09:00:00Z',
  account: { id: 1, address: 'yo@ejemplo.com' }, scope: null, attachments: 0, announcedAt: null, client: { name: 'Cliente Uno', projects: ['Web'] } };
const normal = { ...base, id: 1, confidentiality: 'normal' };
const secret = { ...base, id: 2, confidentiality: 'private', subject: 'Asunto privado', client: null, proposal: null };
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], sent = [], decided = [], notes = [], composed = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/api/core/alerts/due', route => route.fulfill({ json: { notifications: [] } }));
await page.route('**/api/core/mail/inbox?state=pending', route => route.fulfill({ json: { items: [normal, secret], counts: { pending: 2, done: 0, dismissed: 0, unread: 0, since: null }, problem: null } }));
await page.route('**/api/core/mail/inbox/announce', route => route.fulfill({ json: { items: [] } }));
await page.route(/\/api\/core\/mail\/inbox\/\d+$/, route => { decided.push(route.request().postDataJSON().state); return route.fulfill({ json: { ok: true } }); });
await page.route(/\/api\/core\/mail\/messages\/\d+\/reply$/, route => {
  const id = Number(route.request().url().match(/messages\/(\d+)/)[1]);
  return route.fulfill({ json: { accountId: 1, to: 'hola@cliente-uno.es', cc: '', subject: `Re: ${id === 1 ? normal.subject : secret.subject}`, body: '\n\n> Texto citado', replyTo: id } });
});
await page.route('**/api/core/mail/messages/1/compose', route => { composed.push(route.request().postDataJSON().instructions); return route.fulfill({ json: { body: 'Hola, lo cambio el lunes.' } }); });
await page.route('**/api/core/mail/drafts/preview', route => {
  const draft = route.request().postDataJSON();
  return route.fulfill({ json: { draft: { ...draft, to: [draft.to], cc: draft.cc ? [draft.cc] : [] }, from: 'Yo <yo@ejemplo.com>', digest: 'a'.repeat(64), attachments: [] } });
});
await page.route('**/api/core/mail/send', route => { sent.push(route.request().postDataJSON()); return route.fulfill({ json: { sent: true, savedToSent: true, refused: [] } }); });
// One test vault with the client folders convention; the rest of the catalog stays as the backend gives it.
await page.route('**/api/hermes/catalog', async route => {
  const real = await (await route.fetch()).json();
  return route.fulfill({ json: { ...real, vaults: [{ id: 'vault-prueba', name: 'Vault de prueba', available: true }] } });
});
await page.route('**/api/hermes/vaults/vault-prueba/notes', route => route.request().method() === 'POST'
  ? (notes.push(route.request().postDataJSON()), route.fulfill({ status: 201, json: { id: 'n1', folder: route.request().postDataJSON().folder, title: route.request().postDataJSON().title } }))
  : route.fulfill({ json: { vault: { id: 'vault-prueba', name: 'Vault de prueba' }, truncated: false, notes: [
    { id: 'a', title: 'Índice', folder: '- Clientes/Proyectos', bytes: 10, modifiedAt: '2026-11-01T00:00:00Z', readable: true },
    { id: 'b', title: 'Cliente Uno - Inicio 01-10-2026', folder: '- Clientes/Proyectos/Cliente Uno', bytes: 10, modifiedAt: '2026-11-01T00:00:00Z', readable: true }] } }));

await page.goto(appUrl(5173, 'bandeja'));
const cards = page.locator('.inbox-card');
await cards.first().waitFor({ timeout: 60_000 });
const first = cards.filter({ hasText: 'Cambio en la portada' });
// The reply: Watson drafts, the user previews, and only «Enviar» sends the sealed preview.
await first.getByRole('button', { name: 'Responder…' }).click();
const composer = first.getByRole('form', { name: 'Responder al correo' });
await composer.getByLabel(/^Indicaciones para /).fill('dile que el lunes');
await composer.getByRole('button', { name: /^Redactar con / }).click();
await composer.getByLabel('Mensaje').evaluate(node => new Promise(resolve => { const wait = () => node.value.startsWith('Hola') ? resolve() : setTimeout(wait, 50); wait(); }));
assert.deepEqual(composed, ['dile que el lunes']);
assert.match(await composer.getByLabel('Mensaje').inputValue(), /^Hola, lo cambio el lunes\.\n\n> Texto citado/, 'el texto citado se conserva');
await composer.getByRole('button', { name: 'Vista previa' }).click();
const preview = first.locator('[aria-label="Vista previa del correo"]');
await preview.getByText('Esto es exactamente lo que se enviará').waitFor();
assert.equal(sent.length, 0, 'la vista previa no envía');
if (shots) await page.screenshot({ path: `${shots}/reply-preview.png` });
await preview.getByRole('button', { name: 'Enviar' }).click();
await page.getByText(/Correo enviado a hola@cliente-uno\.es/).waitFor();
assert.equal(sent.length, 1, 'un solo envío');
assert.equal(sent[0].digest, 'a'.repeat(64), 'se envía lo sellado en la vista previa');
// A private mail: written by hand, Watson is not offered.
const second = cards.filter({ hasText: 'Asunto privado' });
await second.getByRole('button', { name: 'Responder…' }).click();
await second.getByText(/no lo lee, escribe la respuesta tú\./).waitFor();
assert.equal(await second.getByRole('button', { name: /^Redactar con / }).count(), 0, 'sin asistente en un correo privado');
await second.getByRole('button', { name: 'Cancelar' }).click();
// The project note: one new note in the client's folder, created only on «Crear la nota».
await first.getByRole('button', { name: 'Añadir a la nota del proyecto…' }).click();
const noteForm = first.getByRole('form', { name: 'Añadir a la nota del proyecto' });
await noteForm.getByLabel('Título').waitFor({ timeout: 30_000 });
assert.equal(await noteForm.getByLabel('Título').inputValue(), 'Cliente Uno - Cambio en la portada 14-11-2026');
assert.match(await noteForm.getByLabel('Texto de la nota').inputValue(), /- Proyecto: Web/);
assert.equal(notes.length, 0, 'abrir el formulario no escribe');
await noteForm.getByRole('button', { name: 'Crear la nota' }).click();
await page.getByText(/Nota creada en - Clientes\/Proyectos\/Cliente Uno/).waitFor();
assert.equal(notes.length, 1);
assert.equal(notes[0].folder, '- Clientes/Proyectos/Cliente Uno');
assert.ok(decided.includes('done'), 'la tarjeta pasa a Hechos');
assert.equal(await page.locator('.page select').count(), 0, 'ningún select nativo');
assert.deepEqual(errors, [], 'sin errores JS');
console.log('respuesta sellada, correo privado sin Watson y nota del proyecto: correctos');
await browser.close();
