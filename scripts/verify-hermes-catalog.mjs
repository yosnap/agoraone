import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  let modelCalls = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/messages') && request.method() === 'POST') modelCalls++; });
  const response = page.waitForResponse(r => r.url().endsWith('/api/hermes/catalog'));
  await page.goto('http://127.0.0.1:4317');
  const catalog = await (await response).json();
  assert.ok(catalog.profiles.length > 0);
  await page.locator('.directory').getByRole('button', { name: `Perfil · ${catalog.profiles[0].label}`, exact: false }).click();
  await page.getByRole('heading', { name: 'Personalidad y memoria' }).waitFor();
  await page.locator('.hermes-details summary').filter({ hasText: 'SOUL.md' }).click();
  await page.locator('.hermes-details details[open] pre').waitFor();
  assert.equal(await page.locator('.chat:visible').count(), 0);
  await page.getByRole('button', { name: 'Cerrar espacio' }).click();
  if (catalog.spaces.length) {
    await page.locator('.directory').getByRole('button').filter({ hasText: catalog.spaces[0].label }).first().click();
    await page.getByRole('heading', { name: 'Perfiles relacionados' }).waitFor();
    await page.getByRole('button', { name: 'Cerrar espacio' }).click();
  }
  assert.equal(await page.getByRole('button', { name: 'Pixel', exact: true }).count(), 0);
  await page.screenshot({ path: '.agora/hermes-city.png' });
  // Exercise automatic refresh without modifying the user's Hermes installation.
  const originalCount = catalog.profiles.length;
  const changed = structuredClone(catalog);
  changed.profiles = changed.profiles.slice(1);
  changed.spaces = [];
  await page.route('**/api/hermes/catalog', route => route.fulfill({ json: changed }));
  await page.waitForFunction(count => document.querySelector('.directory .eyebrow')?.textContent?.includes(`${count - 1} perfiles`), originalCount, { timeout: 40000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.directory').getByRole('button', { name: /Biblioteca Luma/ }).click();
  await page.getByLabel('Tu mensaje a Luma').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []); assert.equal(modelCalls, 0);
  console.log(`Catálogo real: ${originalCount} perfiles y ${catalog.spaces.length} espacios. Fichas, memoria, refresco automático, móvil y Luma OK; sin inferencia.`);
} finally { await browser.close(); }
