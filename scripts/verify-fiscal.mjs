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
  await quarters.or(fiscal.locator('.muted, .load-error').first()).first().waitFor({ timeout: 60_000 });
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
await browser.close();
