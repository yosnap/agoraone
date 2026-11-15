import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { appUrl } from './verify-targets.mjs';
// Agenda, reminders and their settings. First read only against the real calendars (or the permission card):
// the pages load, nothing is written, no native selects, no horizontal scroll. Then with sample data served by
// the test itself: overlaps are marked, an overlapping event is created only after the second, explicit yes,
// and a due reminder appears inside the app and is confirmed as shown. Prints counts, never titles.
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: true });
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport });
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET' && !r.url().endsWith('/api/session')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  // The toasts would confirm real reminders as shown: in this pass they find none.
  await page.route('**/api/core/alerts/due', route => route.fulfill({ json: { notifications: [] } }));
  await page.goto(appUrl(5173, 'agenda'));
  const agenda = page.locator('section.agenda');
  await agenda.getByRole('heading', { name: 'Agenda', level: 1 }).waitFor({ timeout: 60_000 });
  await agenda.locator('.agenda-list, .card, .muted, .load-error').first().waitFor();
  const granted = await agenda.getByRole('group', { name: 'Periodo' }).count() > 0;
  if (granted) {
    for (const when of ['Mañana', 'Esta semana', 'Hoy']) await agenda.getByRole('button', { name: when }).click();
    await agenda.getByRole('heading', { name: 'Recordatorios pendientes' }).waitFor({ timeout: 30_000 });
  }
  console.log(`${viewport.width}px · calendario ${granted ? `con permiso, ${await agenda.locator('.agenda-list li').count()} filas` : 'sin permiso (se ve la tarjeta para darlo)'}`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'sin desplazamiento horizontal');
  if (shots) await page.screenshot({ path: `${shots}/agenda-${viewport.width}.png` });
  await page.goto(appUrl(5173, 'ajustes'));
  for (const title of ['Calendarios', 'Avisos']) await page.getByRole('heading', { name: title, exact: true }).waitFor({ timeout: 60_000 });
  const alerts = page.locator('article', { has: page.getByRole('heading', { name: 'Avisos', exact: true }) });
  await alerts.locator('.alerts-permissions li').first().waitFor();
  assert.equal(await page.locator('.page select').count(), 0, 'ningún select nativo');
  // The confidentiality labels name the chosen character, not a fixed «Watson».
  await page.waitForTimeout(1000);
  const named = (await page.locator('.calendar-settings .modern-select button, .alerts-permissions ~ * .modern-select button, article .modern-select button').allInnerTexts()).map(t => t.replace('▾', '').trim()).filter(t => t.startsWith('Normal:'));
  console.log(`${viewport.width}px · etiquetas de nivel normal: ${[...new Set(named)].join(' | ') || 'ninguna a la vista'}`);
  if (shots) await alerts.screenshot({ path: `${shots}/alerts-settings-${viewport.width}.png` });
  assert.deepEqual(writes, [], 'no se escribió nada');
  assert.deepEqual(errors, [], 'sin errores JS');
  await page.close();
}

// Sample agenda: two meetings that overlap and a reminder, plus a morning summary.
const today = new Date();
const at = (hour, minute = 0) => { const d = new Date(today); d.setHours(hour, minute, 0, 0); return d.toISOString(); };
const sample = { events: [
  { id: 'e1', calendarId: 'c1', title: 'Reunión de ejemplo', start: at(10), end: at(11), allDay: false, location: 'Sala 1' },
  { id: 'e2', calendarId: 'c1', title: 'Llamada de ejemplo', start: at(10, 30), end: at(11, 30), allDay: false, location: null }],
  reminders: [{ id: 'r1', calendarId: 'c2', title: 'Recordatorio de ejemplo', due: null }], overlaps: [['e1', 'e2']], problem: null };
const view = { alerts: [], morning: { key: 'morning:x', kind: 'summary', title: 'Tu día en AgoraOne', body: '2 en la agenda (1 solape) · 1 recordatorio · 0 en la Bandeja.', at: '' },
  problems: [], callsProblem: null, contacts: 'granted',
  settings: { morning: '08:30', quietFrom: '22:00', quietTo: '08:00', missedCalls: true, meetings: true, commitments: true, summary: true, callsLevel: 'local_only' } };
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], created = [], acked = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/api/core/calendar/status', route => route.fulfill({ json: { events: 'granted', reminders: 'granted' } }));
await page.route('**/api/core/calendar/agenda?*', route => route.fulfill({ json: sample }));
await page.route('**/api/core/alerts', route => route.fulfill({ json: view }));
await page.route('**/api/core/calendar/calendars', route => route.fulfill({ json: { problem: null, calendars: [
  { id: 'c1', title: 'Trabajo', kind: 'event', account: 'iCloud', writable: true, scopeId: null, confidentiality: 'normal', hidden: false },
  { id: 'c2', title: 'Tareas', kind: 'reminder', account: 'iCloud', writable: true, scopeId: null, confidentiality: 'normal', hidden: false },
  { id: 'c3', title: 'Festivos', kind: 'event', account: 'iCloud', writable: false, scopeId: null, confidentiality: 'normal', hidden: true }] } }));
await page.route('**/api/core/calendar/calendars/*', route => route.fulfill({ json: { ok: true } }));
await page.route('**/api/core/calendar/events', route => {
  const body = route.request().postDataJSON();
  created.push(body);
  return body.overlapOk ? route.fulfill({ status: 201, json: { id: 'e3', clashes: 1 } })
    : route.fulfill({ status: 409, json: { error: 'Se solapa con otro evento.', clashes: [{ title: 'Reunión de ejemplo', start: sample.events[0].start, end: sample.events[0].end }] } });
});
await page.route('**/api/core/alerts/due', route => route.fulfill({ json: { notifications: acked.length ? [] : [{ key: 'event:e1', kind: 'meeting', title: 'A las 10:00: Reunión de ejemplo', body: 'Sala 1' }] } }));
await page.route('**/api/core/alerts/ack', route => { acked.push(...route.request().postDataJSON().keys); return route.fulfill({ json: { ok: true } }); });
await page.goto(appUrl(5173, 'agenda'));
const agenda = page.locator('section.agenda');
await agenda.locator('.agenda-list li').first().waitFor({ timeout: 60_000 });
assert.equal(await agenda.locator('.agenda-clash').count(), 2, 'los dos eventos que coinciden van marcados');
await agenda.getByText('Hay un solape').waitFor();
await agenda.getByText('2 en la agenda (1 solape)').waitFor();
await agenda.getByRole('button', { name: 'Nuevo evento o recordatorio' }).click();
const form = page.getByRole('form', { name: 'Nuevo evento o recordatorio' });
await form.getByLabel('Título').fill('Evento de prueba');
await form.getByRole('button', { name: 'Crear el evento' }).click();
await form.getByText('Se solapa con:').waitFor();
assert.equal(created.length, 1, 'el primer intento no fuerza el solape');
assert.equal(created[0].overlapOk, false);
await form.getByRole('button', { name: 'Crear de todos modos' }).click();
await agenda.getByText('Evento «Evento de prueba» creado; se solapa con 1.').waitFor();
assert.equal(created[1].overlapOk, true, 'solo se crea con el segundo sí');
await page.bringToFront();
await page.locator('.alert-toast').getByText('A las 10:00: Reunión de ejemplo').waitFor({ timeout: 20_000 });
assert.deepEqual(acked, ['event:e1'], 'el aviso mostrado se confirma una vez');
if (shots) await page.screenshot({ path: `${shots}/agenda-sample.png` });
await page.locator('.alert-toast').getByRole('button', { name: 'Cerrar el aviso' }).click();
assert.equal(await page.locator('.alert-toast').count(), 0);
// Settings › Calendarios: hidden calendars stay out of the list until asked for.
await page.goto(appUrl(5173, 'ajustes'));
const calendarsCard = page.locator('article', { has: page.getByRole('heading', { name: 'Calendarios', exact: true }) });
await calendarsCard.locator('.calendar-settings li').first().waitFor({ timeout: 60_000 });
assert.equal(await calendarsCard.locator('.calendar-settings li').count(), 2, 'el oculto no se ve');
await calendarsCard.getByRole('button', { name: 'Mostrar el calendario oculto' }).click();
assert.equal(await calendarsCard.locator('.calendar-settings li').count(), 3, 'se ve al pedirlo');
await calendarsCard.getByRole('button', { name: 'Esconder los ocultos' }).click();
await calendarsCard.locator('li', { hasText: 'Trabajo' }).getByLabel('Ocultar').check();
assert.equal(await calendarsCard.locator('.calendar-settings li').count(), 2, 'el recién ocultado sigue a la vista para deshacerlo');
assert.deepEqual(errors, [], 'sin errores JS');
console.log('agenda de ejemplo, solape confirmado y aviso dentro de la app: correctos');
await browser.close();
