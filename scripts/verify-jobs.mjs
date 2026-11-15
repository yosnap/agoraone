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
  await page.goto(appUrl(5173, 'ajustes&pestana=trabajos'));
  const jobsCard = page.locator('article', { has: page.getByRole('heading', { name: 'Trabajos', exact: true }) });
  await jobsCard.locator('label.field', { hasText: 'Bot central' }).waitFor({ timeout: 60_000 });
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
      startedAt: iso(now - 300_000), completedAt: null, runs: [{ profile: 'alfa', status: 'running', outcome: null, startedAt: iso(now - 300_000), endedAt: null, seconds: 300 }], seconds: 300, tokens: null,
      totals: { '24h': period(1, 300, 0, tokens(0, 0, null)), '7d': period(1, 300, 0, tokens(0, 0, null)), '30d': period(1, 300, 0, tokens(0, 0, null)) } },
    { id: 't2', board: 'default', title: 'Tarjeta hecha', assignee: 'beta', profileId: 'beta', status: 'done', priority: 0, createdBy: 'user', createdAt: iso(now - 86_400_000 * 2),
      startedAt: null, completedAt: iso(now - 86_400_000), runs: [], seconds: 600, tokens: tokens(3000, 400, 0.25),
      totals: { '24h': period(0, 0, 0, tokens(0, 0, null)), '7d': period(0, 0, 0, tokens(0, 0, null)), '30d': period(0, 0, 0, tokens(0, 0, null)) },
      events: [{ kind: 'completed', at: iso(now - 86_400_000) }, { kind: 'created', at: iso(now - 86_400_000 * 2) }] }] }, dispatcher: true };
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], changed = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/api/core/alerts/due', route => route.fulfill({ json: { notifications: [] } }));
await page.route('**/api/hermes/work', route => route.fulfill({ json: sample }));
// Two sample profiles: the root one (the central bot) and another; a commission is created only on its button.
const created = [];
await page.route('**/api/hermes/catalog', async route => {
  const real = await (await route.fetch()).json();
  const base = real.profiles[0];
  return route.fulfill({ json: { ...real, profiles: [{ ...base, id: 'alfa', name: 'default', label: 'Hermes principal' }, { ...base, id: 'beta', name: 'pro', label: 'Pro' }] } });
});
await page.route('**/api/core/jobs/settings', route => route.fulfill({ json: { central: 'default' } }));
const usage = (day, week, month) => ({ '24h': { tokens: day, turns: 1 }, '7d': { tokens: week, turns: 2 }, '30d': { tokens: month, turns: 3 } });
await page.route('**/api/core/jobs/projects', route => route.fulfill({ json: { costguard: true, problem: null, fetchedAt: null,
  clients: [{ name: 'Cliente de ejemplo', company: null, projects: [
    { name: 'Café Web', status: 'ACTIVE', phase: 'Diseño', usage: usage(1200, 1800, 5000) },
    { name: 'Sin carpeta', status: 'MAINTENANCE', phase: null, usage: null },
    { name: 'Proyecto viejo', status: 'ARCHIVED', phase: null, usage: null }] }],
  unmatched: [{ name: 'otra-cosa', usage: usage(0, 55, 55) }] } }));
await page.route('**/api/hermes/summary', route => route.fulfill({ json: { readAt: '', days: 30, messagesCounted: 0, profiles: [], words: [],
  projects: [{ project: 'cafe_web', tokens: 9000, costUsd: 0.1, sessions: 2 }] } }));
await page.route(/\/api\/hermes\/profiles\/[^/]+\/cards$/, route => { created.push({ url: new URL(route.request().url()).pathname, body: route.request().postDataJSON() }); return route.fulfill({ status: 201, json: { card: 't9' } }); });
await page.route(/\/api\/hermes\/profiles\/[^/]+\/cards\/[^/]+$/, route => { changed.push(route.request().postDataJSON()); return route.fulfill({ json: { card: 't1' } }); });
await page.goto(appUrl(5173, 'trabajos'));
const jobs = page.locator('section.jobs');
await jobs.locator('.work-card').first().waitFor({ timeout: 60_000 });
const totals = jobs.locator('.work-totals');
assert.equal(await totals.locator('div', { hasText: 'Ejecuciones' }).locator('dd').innerText(), '3', 'en 7 días: 2 ejecuciones de la tarea y 1 de la tarjeta en curso (la hecha no tiene ejecuciones)');
await jobs.getByRole('button', { name: '24 h', exact: true }).click();
assert.equal(await totals.locator('div', { hasText: 'Ejecuciones' }).locator('dd').innerText(), '2', 'en 24 h: la última ejecución y la tarjeta de hoy');
await jobs.getByText('En 24 h: 1 ejecución · 2 min · 1,2 mil tokens · 0,05 $').waitFor();
await jobs.getByText('Últimas ejecuciones').click();
assert.ok(await jobs.locator('.work-table').getByText('sin medir').count(), 'una ejecución sin sesión dice «sin medir»');
assert.equal(await jobs.locator('.work-column[aria-label="En curso"] .work-card').count(), 1);
assert.equal(await jobs.locator('.work-column[aria-label="Hechas"] .work-card').count(), 1);
await jobs.getByText('encargo de AgoraOne').waitFor();
// A card's history, from Hermes' events.
await jobs.getByText('Historia (2)').click();
await jobs.locator('.card-history').getByText('Completada').waitFor();
// The commission: the central bot comes chosen; another profile can be picked; nothing is sent until «Crear encargo».
await jobs.getByRole('button', { name: 'Nuevo encargo' }).click();
const form = page.getByRole('form', { name: 'Nuevo encargo' });
await form.getByText('Hermes principal (bot central)').waitFor();
await form.getByLabel('Qué quieres que haga').fill('Revisa las facturas de prueba');
await form.locator('.modern-select button').first().click();
await page.getByRole('option', { name: 'Pro' }).click();
assert.equal(created.length, 0, 'abrir y rellenar no crea nada');
await form.getByRole('button', { name: 'Crear encargo' }).click();
await jobs.getByText(/^Encargo «Revisa las facturas de prueba» creado para Pro\./).waitFor();
assert.deepEqual(created, [{ url: '/api/hermes/profiles/beta/cards', body: { title: 'Revisa las facturas de prueba' } }]);
// Clients' projects: matched by the same name only; archived ones hidden by default; the rest apart.
const projects = jobs.locator('.projects-table');
await projects.getByText('Café Web').waitFor();
const web = projects.locator('tr', { hasText: 'Café Web' });
assert.match(await web.innerText(), /1,2 mil tokens · 1 turno\b/, 'consumo del periodo elegido (24 h)');
assert.match(await web.innerText(), /9 mil tokens/, 'Hermes por el mismo nombre');
assert.match(await projects.locator('tr', { hasText: 'Sin carpeta' }).innerText(), /sin carpeta/);
assert.equal(await projects.getByText('Proyecto viejo').count(), 0, 'los archivados no salen por defecto');
assert.equal(await jobs.getByText(/Otras carpetas con consumo/).count(), 0, 'en 24 h esa carpeta no gastó nada');
await jobs.getByRole('button', { name: '7 días', exact: true }).click();
await jobs.getByText(/Otras carpetas con consumo en 7 días/).click();
await jobs.getByText('otra-cosa · 55 tokens').waitFor();
if (shots) await page.screenshot({ path: `${shots}/jobs-sample.png`, fullPage: true });
assert.equal(changed.length, 0, 'mirar no cambia nada');
const running = jobs.locator('.work-card', { hasText: 'Tarjeta en curso' });
await running.getByRole('button', { name: 'Completar' }).click();
await jobs.getByText('Tarjeta «Tarjeta en curso» completada.').waitFor();
assert.deepEqual(changed, [{ action: 'complete' }]);
assert.equal(await jobs.locator('.work-column[aria-label="Hechas"] button').count(), 0, 'las hechas no tienen acciones');
// Discreet mode hides task names and card titles.
await page.getByRole('button', { name: /discreto/i }).first().click();
await jobs.getByText('TRABAJOS · MODO DISCRETO').waitFor();
assert.equal(await jobs.getByText('Tarjeta en curso').count(), 0, 'títulos ocultos');
assert.equal(await jobs.getByText('Resumen de ejemplo').count(), 0, 'nombres ocultos');
assert.equal(await jobs.getByText('Cliente de ejemplo').count(), 0, 'clientes ocultos');
await page.getByRole('button', { name: /discreto/i }).first().click();
assert.deepEqual(errors, [], 'sin errores JS');
console.log('trabajos de ejemplo, totales, kanban, acciones y modo discreto: correctos');
await browser.close();
