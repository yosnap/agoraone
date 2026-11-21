import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { appUrl } from './verify-targets.mjs';
// Version under the logo, Ajustes tabs in one scrollable row, Novedades, Hoja de ruta and Registro. Read only,
// except that the Registro page reads the log. Saves screenshots to $SHOTS if set. Prints what it saw.
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: true });
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/core/alerts/due', route => route.fulfill({ json: { notifications: [] } }));
  await page.goto(appUrl(5173, 'ajustes'));
  const tabs = page.getByRole('tablist', { name: 'Apartados de Ajustes' });
  await tabs.waitFor({ timeout: 60_000 });
  const wide = viewport.width > 850;
  if (wide) {
    assert.ok(await page.locator('.rail-version').isVisible(), 'la versión se ve bajo el logo');
    console.log(`versión en la barra: ${await page.locator('.rail-version').innerText()}`);
  }
  const row = await tabs.evaluate(el => ({ wraps: getComputedStyle(el).flexWrap, scrolls: el.scrollWidth > el.clientWidth, height: el.clientHeight }));
  console.log(`${viewport.width}px · pestañas: ${JSON.stringify(row)}`);
  assert.equal(row.wraps, 'nowrap');
  for (const [name, check] of [['Novedades', '.about-release'], ['Hoja de ruta', '.roadmap-column'], ['Registro', '.log-table, .muted, .load-error']]) {
    await tabs.getByRole('tab', { name }).click();
    await page.locator(check).first().waitFor({ timeout: 30_000 });
    const visible = await tabs.getByRole('tab', { name }).evaluate(el => { const a = el.getBoundingClientRect(), b = el.parentElement.getBoundingClientRect(); return a.left >= b.left - 1 && a.right <= b.right + 1; });
    console.log(`  ${name}: pestaña visible=${visible}`);
    if (name === 'Novedades') console.log(`    versiones=${await page.locator('.about-release').count()} abierta=${await page.locator('.about-release[open] .about-version').allInnerTexts()}`);
    if (name === 'Registro') console.log(`    entradas=${await page.locator('.log-table tbody tr').count()} primera=${(await page.locator('.log-table tbody tr').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 90)}`);
    if (shots) await page.screenshot({ path: `${shots}/${viewport.width}-${name.replace(/ /g, '-')}.png` });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, `${name}: sin scroll horizontal de página`);
  }
  assert.equal(await page.locator('.page select, .settings-panel select').count(), 0, 'ningún select nativo');
  assert.deepEqual(errors, []);
  await page.close();
}
await browser.close();
console.log('ok');
