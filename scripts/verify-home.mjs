import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { appUrl } from './verify-targets.mjs';
// The home panel: blocks with real data at the centre of the brain, the graph one click away, Watson at the
// right. Read only: no question is sent and nothing is saved. Prints block titles and counts, never mail text.
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: true });
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport });
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { // Watson's own claim of mail announcements is not the panel's.
    if (r.method() !== 'GET' && !r.url().endsWith('/api/session') && !r.url().endsWith('/mail/inbox/announce')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.goto(appUrl(5173, 'cerebro'));
  await page.getByRole('region', { name: 'Panel de inicio' }).waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector('.home-empty')?.textContent?.includes('Leyendo') || document.querySelectorAll('.home-block').length > 0, null, { timeout: 30_000 });
  await page.waitForFunction(() => ![...document.querySelectorAll('.home-empty')].some(p => p.textContent === 'Leyendo…'), null, { timeout: 30_000 });
  const blocks = await page.locator('.home-block').evaluateAll(all => all.map(b => `${b.querySelector('h3')?.childNodes[0]?.textContent}: ${b.querySelector('.home-count')?.textContent ?? (b.querySelector('.home-empty')?.textContent?.startsWith('Leyendo') ? 'leyendo' : '0')}`));
  console.log(`${viewport.width}px · ${blocks.join(' | ')}`);
  if (shots) await page.screenshot({ path: `${shots}/home-${viewport.width}.png` });
  await page.getByRole('button', { name: 'Grafo' }).click();
  await page.locator('.brain-stage canvas').waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Panel' }).click();
  await page.locator('.home-block').first().waitFor();
  assert.deepEqual(errors, [], 'sin errores en la página');
  assert.deepEqual(writes, [], 'el panel solo lee');
  await page.close();
}
await browser.close();
console.log('Panel de inicio verificado.');
