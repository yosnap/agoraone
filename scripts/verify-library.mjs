import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const live = process.argv.includes('--live');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  let inference = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/messages')) inference++;
  });
  await page.goto('http://127.0.0.1:4317');
  // Initial scene load only: headless Chromium renders WebGL in software (~2 fps), so allow it time.
  await page.getByRole('button', { name: 'Luma', exact: true }).click({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Entrar en la biblioteca' }).click();
  await page.getByRole('navigation', { name: 'Acciones de biblioteca' }).waitFor();
  await page.locator('#walk-button').click();
  await page.waitForFunction(() => !!document.pointerLockElement || document.activeElement?.tagName === 'CANVAS');
  const beforeMove = await page.locator('canvas').screenshot();
  await page.keyboard.down('KeyW'); await page.waitForTimeout(350); await page.keyboard.up('KeyW');
  const afterMove = await page.locator('canvas').screenshot();
  assert.ok(!beforeMove.equals(afterMove), 'WASD debe mover la cámara dentro de la biblioteca');
  await page.evaluate(() => document.exitPointerLock());
  await page.getByRole('button', { name: 'Abrir catálogo', exact: true }).click();
  await page.getByLabel('Buscar por título').fill('huerto');
  await page.getByRole('button', { name: 'Huerto orbital · ejemplo' }).click();
  await page.getByText('SEMILLA-582', { exact: false }).waitFor();
  assert.match(await page.locator('.document-preview').innerText(), /84 euros/);
  await page.getByRole('button', { name: 'Consultar este documento con Luma' }).click();
  await page.getByLabel('Quitar documento').waitFor();
  assert.equal(inference, 0, 'Abrir el edificio y leer documentos no debe llamar al modelo');
  if (live) {
    await page.getByLabel('Tu mensaje a Luma').fill('Según el documento adjunto, ¿cuál es el presupuesto total y la clave de referencia? Cita el título y el ID del documento.');
    await page.getByRole('button', { name: 'Enviar a Hermes' }).click();
    await page.waitForFunction(() => !document.querySelector('#message')?.disabled, null, { timeout: 125_000 });
    assert.equal(await page.locator('[role="alert"]').count(), 0);
    const answer = await page.locator('.message.assistant').innerText();
    assert.match(answer, /84/); assert.match(answer, /SEMILLA-582/); assert.match(answer, /orbital-garden/);
    await page.getByText('Documento enviado:', { exact: false }).waitFor();
    console.log('Hermes real: presupuesto, clave y fuente correctos.', answer);
  }
  mkdirSync('.agora', { recursive: true });
  await page.screenshot({ path: '.agora/library-chat.png' });
  await page.getByLabel('Quitar documento').click();
  assert.equal(await page.locator('.document-attached').count(), 0);
  await page.getByRole('button', { name: 'Cerrar espacio' }).click();
  await page.screenshot({ path: '.agora/library-interior.png' });
  await page.getByRole('button', { name: 'Salir de la biblioteca', exact: true }).click();
  await page.getByRole('button', { name: 'Luma', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /Biblioteca Luma/ }).click();
  await page.getByRole('button', { name: 'Documentos', exact: true }).click();
  await page.getByRole('button', { name: 'Bienvenida a la biblioteca' }).click();
  await page.getByText('FARO-274', { exact: false }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '.agora/library-mobile.png' });
  assert.equal(inference, live ? 1 : 0);
  assert.deepEqual(errors, []);
  console.log('Interior, movimiento WASD, catálogo, búsqueda, lectura, adjunto, salida y móvil: OK.');
} finally { await browser.close(); }
