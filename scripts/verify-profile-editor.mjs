import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { escape, target, appUrl } from './verify-targets.mjs';

// Profile editor in the browser, without touching the real Hermes profile: every save request is
// intercepted and answered here, so nothing reaches the server or the profile's files.
const profile = target('profile');
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], saves = [];
  let inference = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/messages')) inference++; });
  let conflict = false;
  await page.route('**/api/hermes/profiles/*/files/*', route => {
    if (conflict) return route.fulfill({ status: 409, json: { error: 'El archivo cambió en Hermes mientras lo editabas. Vuelve a cargarlo para ver la versión actual.' } });
    saves.push({ url: route.request().url(), method: route.request().method(), body: route.request().postDataJSON() });
    return route.fulfill({ json: { revision: 'f'.repeat(24), backup: 'MEMORY.md.prueba.bak' } });
  });
  await page.goto(appUrl());
  // Initial scene load only: headless Chromium renders WebGL in software (~2 fps), so allow it time.
  await page.locator('.directory').getByRole('button', { name: new RegExp(`Perfil · ${escape(profile)}`) }).click({ timeout: 120_000 });
  await page.getByRole('heading', { name: 'Personalidad y memoria' }).waitFor();
  await page.locator('.hermes-details summary').filter({ hasText: 'Recuerdos' }).click();
  await page.getByRole('button', { name: 'Editar recuerdos' }).click();
  const editor = page.getByLabel('Editar Recuerdos');
  await editor.getByText(/caracteres, el límite de Hermes/).waitFor();
  const before = await editor.locator('.memory-card').count();
  await editor.getByRole('button', { name: '+ Añadir entrada' }).click();
  await editor.getByLabel(`Recuerdos: entrada ${before + 1}`).fill('Entrada de verificación');
  // Cancelling discards the draft without saving.
  await editor.getByRole('button', { name: 'Cancelar' }).click();
  assert.equal(saves.length, 0);
  await page.getByRole('button', { name: 'Editar recuerdos' }).click();
  // Removing an entry always stays under Hermes' limit, whatever the profile's memory holds.
  await editor.getByRole('button', { name: `Quitar entrada ${before}` }).click();
  await editor.getByRole('button', { name: 'Guardar en Hermes' }).click();
  await page.getByRole('alertdialog', { name: 'Confirmar guardado' }).waitFor();
  assert.equal(saves.length, 0, 'no se guarda antes de confirmar');
  await page.getByRole('button', { name: 'Confirmar y guardar' }).click();
  await page.getByText('Recuerdos guardado en Hermes').waitFor();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].method, 'PUT'); assert.match(saves[0].url, /\/files\/MEMORY\.md$/);
  assert.equal(saves[0].body.entries.length, Math.max(before - 1, 1));
  assert.match(String(saves[0].body.revision), /^[a-f0-9]{24}$|^null$/);
  // A change made by Hermes meanwhile is reported and the draft can be discarded to reload.
  conflict = true;
  await page.locator('.hermes-details summary').filter({ hasText: 'Recuerdos' }).click();
  await page.locator('.hermes-details summary').filter({ hasText: 'Recuerdos' }).click();
  await page.getByRole('button', { name: 'Editar recuerdos' }).click();
  await editor.getByRole('button', { name: 'Guardar en Hermes' }).click();
  await page.getByRole('button', { name: 'Confirmar y guardar' }).click();
  await editor.getByRole('button', { name: 'Descartar y recargar' }).click();
  await page.getByRole('button', { name: 'Editar recuerdos' }).waitFor();
  assert.equal(inference, 0); assert.deepEqual(errors, []);
  console.log(`Editor de ${profile}: cancelar, confirmar, guardar y conflicto (interceptado, sin tocar Hermes); sin inferencia.`);
} finally { await browser.close(); }
