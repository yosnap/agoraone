import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { escape, target, appUrl } from './verify-targets.mjs';

// A profile's skills: the listing, one skill read as Markdown, an editor opened and cancelled, and a
// new-skill form opened and cancelled. Read-only against the real Hermes installation: no skill is
// created or saved, and hidden lines stay hidden.
const profile = target('profile');
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], writes = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && !request.url().endsWith('/api/session')) writes.push(request.url()); });
await page.goto(appUrl());
// Initial scene load only: headless Chromium renders WebGL in software, so allow it time.
await page.locator('.directory').getByRole('button', { name: new RegExp(`Perfil · ${escape(profile)}`) }).click({ timeout: 120_000 });
await page.getByRole('button', { name: /^Skills de / }).click();
await page.getByLabel('Skills del perfil').waitFor();
const categories = page.locator('.skills-category');
assert.ok((await categories.count()) > 0 || (await page.getByText(/No hay skills que coincidan/).isVisible()), 'se ve el listado o el aviso de carpeta vacía');
const readable = page.locator('.skills-category div button:not([disabled])');
if (await readable.count() > 0) {
  await readable.first().click();
  const detail = page.locator('.skill-detail');
  await detail.locator('.skill-body, .hidden-lines').first().waitFor();
  // The editor opens on demand; closing it writes nothing.
  await detail.getByRole('button', { name: /^Editar esta skill/ }).click();
  await detail.locator('.profile-editor').waitFor();
  await detail.getByRole('button', { name: 'Cancelar' }).click();
  assert.equal(await detail.locator('.profile-editor').count(), 0, 'el editor se cerró');
  // A new skill only opens its form until the user cancels.
  await page.getByRole('button', { name: '+ Nueva skill' }).click();
  await page.locator('.skill-create').waitFor();
  await page.locator('.skill-create').getByRole('button', { name: 'Cancelar' }).click();
  assert.equal(await page.locator('.skill-create').count(), 0, 'el formulario se cerró');
}
assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
assert.equal(errors.length, 0, errors.join('\n'));
assert.equal(writes.length, 0, 'sin peticiones de escritura');
console.log('skills del perfil: listado, lectura, editor y nueva skill (sin escribir) OK');
await browser.close();
