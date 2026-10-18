import { chromium } from '@playwright/test';
import { appUrl } from './verify-targets.mjs';
// Obsidian vault as a library: browse folders, open a note as a book, search, enter the room and
// attach a note to Luma's chat.
// Read-only and without inference: no message is sent. Uses the first vault in Obsidian's registry.
import assert from 'node:assert/strict';
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport });
  const errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET' && !r.url().endsWith('/api/session')) posts.push(r.url()); });
  await page.goto(appUrl());
  // Initial scene load only: headless Chromium renders WebGL in software (~2 fps), so allow it time.
  await page.locator('.directory').getByRole('button', { name: /^Obsidian · / }).first().click({ timeout: 120_000 });
  const shelves = page.locator('.vault-panel .vault-shelves button'), notes = page.locator('.vault-panel .vault-books button:not([disabled])');
  await shelves.or(notes).first().waitFor();
  // Folders are walked down until one holds readable notes; the breadcrumb tracks the path.
  for (let depth = 0; !(await notes.count()) && depth < 12; depth++) { await shelves.first().click(); await page.locator('.vault-crumbs [aria-current]').waitFor(); }
  assert.ok(await notes.count() > 0);
  const opened = await notes.first().textContent();
  await notes.first().click();
  const book = page.getByRole('dialog', { name: /^Libro: / });
  await book.locator('.markdown, .book-empty').first().waitFor();
  assert.ok(opened?.startsWith((await book.locator('.book-left h2').textContent()) ?? '-'), 'el libro abierto es la nota elegida');
  await book.getByRole('button', { name: 'Cerrar libro' }).click();
  await book.waitFor({ state: 'detached' });
  await page.locator('.vault-crumbs button').first().click();
  await page.getByLabel('Buscar').fill('zz-no-existe-en-el-vault');
  await page.getByRole('button', { name: 'Buscar en el contenido' }).click();
  await page.getByText(/No hay notas que contengan/).waitFor();
  await page.getByLabel('Buscar').fill('');
  await page.getByRole('button', { name: 'Entrar en el vault →' }).click();
  await page.getByText(/^05 \/ VAULT /).waitFor();
  if (shots && viewport.width > 800) { await page.waitForTimeout(6000); await page.screenshot({ path: `${shots}/vault-room.png` }); }
  await page.getByRole('button', { name: 'Ver notas' }).click();
  for (let depth = 0; !(await notes.count()) && depth < 12; depth++) { await shelves.first().click(); await page.locator('.vault-crumbs [aria-current]').waitFor(); }
  await notes.first().click();
  if (shots) { await book.locator('.markdown, .book-empty').first().waitFor(); }
  await page.getByRole('button', { name: 'Consultar esta nota con Luma' }).click();
  await book.waitFor({ state: 'detached' });
  await page.getByLabel(/Tu mensaje/).waitFor();
  await page.locator('.detail-panel').getByText(/·/).first().waitFor();
  if (await page.getByRole('button', { name: 'Cerrar espacio' }).isVisible()) await page.getByRole('button', { name: 'Cerrar espacio' }).click();
  await page.getByRole('button', { name: 'Salir del vault' }).click();
  await page.getByText('01 / TU CIUDAD DIGITAL').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(posts.length, 0, 'sin peticiones mutadoras ni de inferencia');
  console.log(`${viewport.width}px: vault por carpetas, libro abierto, búsqueda, interior y consulta preparada OK`);
  await page.close();
}
await browser.close();
