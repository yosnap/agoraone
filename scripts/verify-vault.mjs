import { chromium } from '@playwright/test';
// Obsidian vault: list, read, search, enter the room, open a shelf and attach a note to Luma's chat.
// Read-only and without inference: no message is sent. Uses the first vault in Obsidian's registry.
import assert from 'node:assert/strict';
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport });
  const errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET') posts.push(r.url()); });
  await page.goto('http://127.0.0.1:5173');
  // Initial scene load only: headless Chromium renders WebGL in software (~2 fps), so allow it time.
  await page.locator('.directory').getByRole('button', { name: /^Obsidian · / }).first().click({ timeout: 120_000 });
  const notes = page.locator('.vault-panel .document-list button');
  await notes.first().waitFor();
  assert.ok(await notes.count() > 0);
  await notes.first().click();
  await page.locator('.vault-panel .document-preview pre').waitFor();
  await page.getByLabel('Buscar').fill('zz-no-existe-en-el-vault');
  await page.getByRole('button', { name: 'Buscar en el contenido' }).click();
  await page.getByText(/No hay notas que contengan/).waitFor();
  await page.getByLabel('Buscar').fill('');
  await page.getByRole('button', { name: 'Entrar en el vault →' }).click();
  await page.getByText(/^05 \/ VAULT /).waitFor();
  if (shots && viewport.width > 800) { await page.waitForTimeout(6000); await page.screenshot({ path: `${shots}/vault-room.png` }); }
  await page.getByRole('button', { name: 'Ver notas' }).click();
  await notes.first().click();
  await page.getByRole('button', { name: 'Consultar esta nota con Luma' }).click();
  await page.getByLabel(/Tu mensaje/).waitFor();
  await page.locator('.detail-panel').getByText(/·/).first().waitFor();
  if (await page.getByRole('button', { name: 'Cerrar espacio' }).isVisible()) await page.getByRole('button', { name: 'Cerrar espacio' }).click();
  await page.getByRole('button', { name: 'Salir del vault' }).click();
  await page.getByText('01 / TU CIUDAD DIGITAL').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(posts.length, 0, 'sin peticiones mutadoras ni de inferencia');
  console.log(`${viewport.width}px: vault, lectura, búsqueda, interior, estantería y consulta preparada OK`);
  await page.close();
}
await browser.close();
