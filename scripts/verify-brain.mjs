import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { appUrl } from './verify-targets.mjs';
// The new frame: rail, brain graph, assistant, connectors, settings, pending sections and the office.
// Read only and without inference: no question is sent and nothing is saved. Prints counts, never note text.
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport });
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET' && !r.url().endsWith('/api/session')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  const graphs = [];
  page.on('response', async r => { if (r.url().includes('/api/core/graph')) graphs.push(await r.json().catch(() => null)); });
  await page.goto(appUrl(5173, 'cerebro'));
  const rail = page.getByRole('navigation', { name: 'Secciones de AgoraOne' });
  await rail.waitFor();
  assert.equal(await rail.getByRole('button', { name: 'Cerebro' }).getAttribute('aria-current'), 'page');
  await page.locator('.brain-stats').waitFor({ timeout: 60_000 });
  const graph = graphs.at(-1);
  assert.ok(graph?.nodes.length, 'el grafo trae notas reales');
  const links = graph.edges.filter(edge => edge.kind === 'link').length, near = graph.edges.length - links;
  console.log(`${viewport.width}px · grafo: ${graph.nodes.length} notas, ${links} enlaces, ${near} cercanías, semántica ${graph.semantic}`);
  await page.locator('.brain-stage canvas').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(6000); // software WebGL draws slowly; let the first frames land before the screenshot
  if (shots) await page.screenshot({ path: `${shots}/brain-${viewport.width}.png` });
  // A connected note opens as a book; Esc closes it.
  const hub = page.locator('.brain-list button').first();
  await hub.click();
  await page.locator('.vault-book-backdrop[open]').waitFor({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await page.locator('.vault-book-backdrop[open]').waitFor({ state: 'detached' });
  // Search lights notes up and lists them (counts only).
  await page.locator('#brain-find').fill('proyecto');
  await page.locator('.brain-list h2').filter({ hasText: /encontradas|Sin resultados/ }).waitFor();
  console.log(`${viewport.width}px · búsqueda: ${await page.locator('.brain-list li').count()} notas`);
  await page.locator('#brain-find').fill('');
  // Discreet mode asks the core for normal notes only.
  const before = graphs.length;
  await rail.getByRole('button', { name: 'Discreto' }).click();
  assert.equal(await rail.getByRole('button', { name: 'Discreto' }).getAttribute('aria-pressed'), 'true');
  await page.waitForFunction(count => document.querySelector('.brain .eyebrow')?.textContent?.includes('DISCRETO'), before);
  // The new graph is parsed when it has arrived, which takes longer as the vault grows: wait for it, not a fixed time.
  for (let waited = 0; graphs.length <= before && waited < 15_000; waited += 100) await page.waitForTimeout(100);
  const discreet = graphs.at(-1);
  assert.ok(graphs.length > before && discreet.nodes.filter(node => node.type === 'note').every(node => node.confidentiality === 'normal'), 'en modo discreto solo hay notas normales');
  await rail.getByRole('button', { name: 'Discreto' }).click();
  // Summary: status, connected agents and words, from real data.
  await rail.getByRole('button', { name: 'Resumen' }).click();
  await page.locator('#summary-status').waitFor({ timeout: 60_000 });
  await page.locator('.figures dd').first().filter({ hasNotText: '—' }).waitFor({ timeout: 30_000 });
  console.log(`${viewport.width}px · resumen: ${await page.locator('.agent-list li').count()} agentes, ${await page.locator('.bars li').count()} barras, ${await page.locator('.word-heat li').count()} palabras`);
  assert.equal(await page.locator('.summary').getByText(/\/Users\/|\/Volumes\//).count(), 0, 'ninguna ruta completa');
  // Assistant: shows the engine, sends nothing.
  await rail.getByRole('button', { name: 'Asistente' }).click();
  await page.getByRole('heading', { level: 1, name: /Watson|Mentor|Viernes|Passepartout|Bernardo/ }).waitFor();
  await page.locator('.assistant-head .chip').filter({ hasNotText: 'Comprobando' }).waitFor({ timeout: 30_000 });
  console.log(`${viewport.width}px · motor: ${await page.locator('.assistant-head .chip').textContent()}`);
  if (shots) await page.screenshot({ path: `${shots}/assistant-${viewport.width}.png` });
  // Connectors: the three add-ons and the brain's MCP command.
  await rail.getByRole('button', { name: 'Conectores' }).click();
  await page.locator('.brain-mcp-card .code-block').waitFor();
  assert.equal(await page.locator('.page-grid > .card h2').filter({ hasText: /^(Central|CostGuard|Mi fábrica)$/ }).count(), 3);
  console.log(`${viewport.width}px · complementos: ${(await page.locator('.page-grid .card .chip').allTextContents()).slice(0, 3).join(' / ')}`);
  if (shots) await page.screenshot({ path: `${shots}/connectors-${viewport.width}.png`, fullPage: true });
  // Settings: characters, rules and backups.
  await rail.getByRole('button', { name: 'Ajustes' }).click();
  await page.locator('.persona-option').first().waitFor();
  assert.equal(await page.locator('.persona-option').count(), 5);
  await page.locator('#settings-backups').waitFor();
  assert.equal(await page.locator('.page select').count(), 0, 'ningún select nativo');
  if (shots) await page.screenshot({ path: `${shots}/settings-${viewport.width}.png`, fullPage: true });
  // A pending section says so and shows no data.
  if (viewport.width > 850) {
    await rail.getByRole('button', { name: /Bandeja/ }).click();
    await page.getByText(/PENDIENTE · VERSIÓN 1\.1/).waitFor();
  }
  // The office is the city, unchanged.
  await rail.getByRole('button', { name: 'Oficina 3D' }).click();
  await page.locator('.directory').waitFor({ timeout: 120_000 });
  await rail.getByRole('button', { name: 'Cerebro' }).click();
  await page.locator('.brain-stats').waitFor();
  assert.equal(await page.locator('main.inside-world, main:not(.shell-page)').first().isVisible(), false, 'la ciudad queda oculta y en pausa');
  assert.deepEqual(writes, [], 'no se escribió nada');
  assert.deepEqual(errors, [], 'sin errores JS');
  await page.close();
}
await browser.close();
console.log('verify-brain correcto');
