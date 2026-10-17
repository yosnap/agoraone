import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

// --live explicitly authorizes two billable inference requests. Default checks only the UI.
const live = process.argv.includes('--live');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const modelRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/messages')) modelRequests.push(request.url());
  });
  await page.goto('http://127.0.0.1:4317');
  // Initial scene load only: headless Chromium renders WebGL in software (~2 fps), so allow it time.
  await page.getByRole('button', { name: 'Luma', exact: true }).waitFor({ timeout: 120_000 });
  assert.equal(await page.locator('canvas').count(), 1);
  await page.getByRole('button', { name: 'Luma', exact: true }).click();
  await page.getByLabel('Tu mensaje a Luma').waitFor();
  if (live) {
    const marker = `olivo-${Date.now()}`;
    await page.getByLabel('Tu mensaje a Luma').fill(`Recuerda esta palabra para nuestro siguiente turno: ${marker}. Confirma brevemente.`);
    await page.getByRole('button', { name: 'Enviar a Hermes' }).click();
    await page.locator('.message.assistant').first().waitFor({ timeout: 125_000 });
    await page.waitForFunction(() => !document.querySelector('#message')?.disabled, null, { timeout: 125_000 });
    await page.getByLabel('Tu mensaje a Luma').fill('¿Qué palabra te pedí recordar? Responde solo la palabra.');
    await page.getByRole('button', { name: 'Enviar a Hermes' }).click();
    await page.locator('.message.assistant').nth(1).waitFor({ timeout: 125_000 });
    await page.waitForFunction(() => !document.querySelector('#message')?.disabled, null, { timeout: 125_000 });
    assert.ok((await page.locator('.message.assistant').nth(1).innerText()).includes(marker));
    await page.reload();
    await page.getByRole('button', { name: 'Luma', exact: true }).click();
    await page.locator('.message.assistant').nth(1).waitFor();
    console.log('Hermes real: dos turnos, memoria conversacional y recarga correctos.');
  }
  await page.getByRole('button', { name: 'Cerrar espacio' }).click();
  await page.getByRole('button', { name: 'Primera persona' }).click();
  await page.locator('#walk-button').click();
  await page.waitForFunction(() => !!document.pointerLockElement || document.activeElement?.tagName === 'CANVAS');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(350);
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.exitPointerLock());
  await page.getByRole('button', { name: 'Vista ciudad' }).click();
  assert.equal(await page.getByRole('button', { name: 'Pixel', exact: true }).count(), 0);
  assert.equal(modelRequests.length, live ? 2 : 0, 'La navegación no debe llamar al modelo');
  mkdirSync('.agora', { recursive: true });
  await page.screenshot({ path: '.agora/city-verified.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /Biblioteca Luma/ }).click();
  await page.getByLabel('Tu mensaje a Luma').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '.agora/mobile-verified.png' });
  assert.deepEqual(errors, []);
  console.log('Navegación, selección, chat, vista móvil y ausencia de errores JS: OK.');
} finally { await browser.close(); }
