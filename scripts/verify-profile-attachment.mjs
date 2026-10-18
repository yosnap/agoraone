import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { escape, target } from './verify-targets.mjs';

// A library document attached to a profile's chat (not Luma's): it shows in that chat only,
// Luma's chat stays empty, and it can be removed. Nothing is sent, so no inference runs.
const profile = target('profile');
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  let inference = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/messages')) inference++; });
  await page.goto('http://127.0.0.1:5173');
  // Initial scene load only: headless Chromium renders WebGL in software (~2 fps), so allow it time.
  await page.getByRole('button', { name: 'Luma', exact: true }).click({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Documentos', exact: true }).click();
  await page.getByLabel('Buscar por título').fill('huerto');
  await page.getByRole('button', { name: 'Huerto orbital · ejemplo' }).click();
  await page.getByText('SEMILLA-582', { exact: false }).waitFor();
  await page.getByLabel('Consultar con').selectOption({ label: profile });
  await page.getByRole('button', { name: `Consultar este documento con ${profile}` }).click();
  const chat = page.getByRole('region', { name: `Conversación con ${profile}` });
  await chat.getByText(/Solo lectura: Huerto orbital/).waitFor();
  assert.match(await chat.innerText(), /y el texto del documento adjunto/);
  await page.getByRole('button', { name: 'Cerrar espacio' }).click().catch(() => {});
  await page.getByRole('button', { name: 'Luma', exact: true }).first().click();
  assert.equal(await page.getByRole('region', { name: 'Conversación con Luma' }).locator('.document-attached').count(), 0, 'el adjunto es solo del chat elegido');
  await page.getByRole('button', { name: 'Cerrar espacio' }).click();
  await page.getByRole('button', { name: new RegExp(`^Perfil · ${escape(profile)}`) }).first().click();
  await page.getByRole('button', { name: `Conversar con ${profile}` }).first().click();
  await chat.getByLabel('Quitar documento').click();
  assert.equal(await chat.locator('.document-attached').count(), 0);
  assert.equal(inference, 0, 'Adjuntar no debe llamar al modelo');
  assert.deepEqual(errors, []);
  console.log(`Documento adjuntado al chat de ${profile}, ausente en Luma y retirado; sin inferencia.`);
} finally { await browser.close(); }
