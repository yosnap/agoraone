import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { appUrl } from './verify-targets.mjs';
// Trabajos. First read only against the real Hermes: the page loads, nothing is written, no native selects,
// no horizontal scroll (prints counts, never names). Then with sample work served by the test itself: the
// period totals add up, runs show their time and tokens, the kanban groups cards by state, discreet mode
// hides names, and a card's action reaches Hermes only through its button.
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: true });
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport });
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET' && !r.url().endsWith('/api/session')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.route('**/api/core/alerts/due', route => route.fulfill({ json: { notifications: [] } }));
  await page.goto(appUrl(5173, 'trabajos'));
  const jobs = page.locator('section.jobs');
  await jobs.getByRole('heading', { name: 'Trabajos', level: 1 }).waitFor({ timeout: 60_000 });
  await jobs.locator('.work-totals, .load-error').first().waitFor({ timeout: 60_000 });
  console.log(`${viewport.width}px · perfiles con tareas: ${await jobs.locator('.work-profile').count()} · tarjetas: ${await jobs.locator('.work-card').count()}`);
  for (const period of ['24 h', '30 días', '7 días']) await jobs.getByRole('button', { name: period, exact: true }).click();
  assert.equal(await page.locator('.page select').count(), 0, 'ningún select nativo');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'sin desplazamiento horizontal');
  if (shots) await page.screenshot({ path: `${shots}/jobs-${viewport.width}.png`, fullPage: true });
  assert.deepEqual(writes, [], 'no se escribió nada');
  assert.deepEqual(errors, [], 'sin errores JS');
  await page.close();
}

const now = Date.now();
const iso = ms => new Date(ms).toISOString();
const tokens = (input, output, costUsd) => ({ input, output, costUsd });
const period = (runs, seconds, measured, used) => ({ runs, seconds, measured, tokens: used });
const sample = { schema: 1, readAt: iso(now), profiles: {
  alfa: { name: 'alfa', tasks: [{ id: 'job1', name: 'Resumen de ejemplo', enabled: true, state: 'scheduled', schedule: 'every day at 20:00', lastStatus: 'ok',
    lastRunAt: iso(now - 3_600_000), nextRunAt: iso(now + 3_600_000),
    runs: [{ startedAt: iso(now - 3_600_000), finishedAt: iso(now - 3_510_000), status: 'completed', seconds: 90, tokens: tokens(1000, 200, 0.05) },
      { startedAt: iso(now - 3 * 86_400_000), finishedAt: iso(now - 3 * 86_400_000 + 20_000), status: 'failed', seconds: 20, tokens: null }],
    totals: { '24h': period(1, 90, 1, tokens(1000, 200, 0.05)), '7d': period(2, 110, 1, tokens(1000, 200, 0.05)), '30d': period(2, 110, 1, tokens(1000, 200, 0.05)) } }] },
  beta: { name: 'beta', tasks: [] } },
  board: { cards: [
    { id: 't1', board: 'default', title: 'Tarjeta en curso', assignee: 'alfa', profileId: 'alfa', status: 'running', priority: 0, createdBy: 'agoraone', createdAt: iso(now - 600_000),
      startedAt: iso(now - 300_000), completedAt: null, runs: [{ profile: 'alfa', status: 'running', outcome: null, startedAt: iso(now - 300_000), endedAt: null, seconds: 300 }], seconds: 300, tokens: null },
    { id: 't2', board: 'default', title: 'Tarjeta hecha', assignee: 'beta', profileId: 'beta', status: 'done', priority: 0, createdBy: 'user', createdAt: iso(now - 86_400_000 * 2),
      startedAt: null, completedAt: iso(now - 86_400_000), runs: [], seconds: 600, tokens: tokens(3000, 400, 0.25) }] } };
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], changed = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/api/core/alerts/due', route => route.fulfill({ json: { notifications: [] } }));
await page.route('**/api/hermes/work', route => route.fulfill({ json: sample }));
await page.route(/\/api\/hermes\/profiles\/[^/]+\/cards\/[^/]+$/, route => { changed.push(route.request().postDataJSON()); return route.fulfill({ json: { card: 't1' } }); });
await page.goto(appUrl(5173, 'trabajos'));
const jobs = page.locator('section.jobs');
await jobs.locator('.work-card').first().waitFor({ timeout: 60_000 });
const totals = jobs.locator('.work-totals');
assert.equal(await totals.locator('div', { hasText: 'Ejecuciones' }).locator('dd').innerText(), '5', '2 ejecuciones de la tarea + 1 de la tarjeta en curso... y las de la hecha');
await jobs.getByRole('button', { name: '24 h', exact: true }).click();
assert.equal(await totals.locator('div', { hasText: 'Ejecuciones' }).locator('dd').innerText(), '2', 'en 24 h: la última ejecución y la tarjeta de hoy');
await jobs.getByText('En 24 h: 1 ejecución · 2 min · 1,2 mil tokens · 0,05 $').waitFor();
await jobs.getByText('Últimas ejecuciones').click();
assert.ok(await jobs.locator('.work-table').getByText('sin medir').count(), 'una ejecución sin sesión dice «sin medir»');
assert.equal(await jobs.locator('.work-column[aria-label="En curso"] .work-card').count(), 1);
assert.equal(await jobs.locator('.work-column[aria-label="Hechas"] .work-card').count(), 1);
await jobs.getByText('encargo de AgoraOne').waitFor();
if (shots) await page.screenshot({ path: `${shots}/jobs-sample.png`, fullPage: true });
assert.equal(changed.length, 0, 'mirar no cambia nada');
const running = jobs.locator('.work-card', { hasText: 'Tarjeta en curso' });
await running.getByRole('button', { name: 'Completar' }).click();
await running.getByText('Tarjeta «Tarjeta en curso» completada.').waitFor();
assert.deepEqual(changed, [{ action: 'complete' }]);
assert.equal(await jobs.locator('.work-column[aria-label="Hechas"] button').count(), 0, 'las hechas no tienen acciones');
// Discreet mode hides task names and card titles.
await page.getByRole('button', { name: /discreto/i }).first().click();
await jobs.getByText('TRABAJOS · MODO DISCRETO').waitFor();
assert.equal(await jobs.getByText('Tarjeta en curso').count(), 0, 'títulos ocultos');
assert.equal(await jobs.getByText('Resumen de ejemplo').count(), 0, 'nombres ocultos');
await page.getByRole('button', { name: /discreto/i }).first().click();
assert.deepEqual(errors, [], 'sin errores JS');
console.log('trabajos de ejemplo, totales, kanban, acciones y modo discreto: correctos');
await browser.close();
