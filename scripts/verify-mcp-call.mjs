import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { escape, target, appUrl } from './verify-targets.mjs';

// Calling an MCP tool by hand without reaching any service: the tool catalogue is answered with one
// fictitious tool and the call itself is intercepted and recorded here, so nothing connects or runs.
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/mcp\/[^/]+\/tools$/, route => route.fulfill({ json: { source: 'hermes-cache', state: 'cached', recordedAt: new Date().toISOString(), truncated: false, tools: [
    { name: 'eco_prueba', description: 'Herramienta ficticia de verificación.', parameters: [
      { name: 'texto', type: 'string', required: true, description: 'Lo que se repite.' },
      { name: 'veces', type: 'integer', required: false },
      { name: 'modo', type: 'string', required: false, options: ['normal', 'grito'] },
      { name: 'extra', type: 'object', required: false }] }] } }));
  await page.route(/\/tools\/[^/]+\/call$/, route => {
    calls.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({ json: { result: 'hola hola', hidden: 1, truncated: false } });
  });
  await page.goto(appUrl());
  // Initial scene load only: headless Chromium renders WebGL in software, so allow it time.
  await page.locator('.directory').getByRole('button', { name: /Centro de integraciones/ }).click({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Entrar al centro de integraciones' }).click();
  await page.getByRole('button', { name: new RegExp(`^MCP · ${escape(target('mcp'))}( |$)`) }).click();
  await page.locator('.mcp-tools summary').filter({ hasText: 'eco_prueba' }).first().click();
  await page.getByRole('button', { name: 'Usar esta herramienta' }).first().click();
  const form = page.getByRole('form', { name: 'Usar eco_prueba' }).first();
  // Required field and number validation happen before anything is sent.
  await form.getByRole('button', { name: 'Revisar antes de ejecutar' }).click();
  await form.getByText('Falta «texto», que es obligatorio.').waitFor();
  await form.getByLabel(/^texto/).fill('hola');
  await form.getByLabel(/^veces/).fill('2');
  await form.getByLabel(/^modo/).click();
  await form.locator('.modern-select-list [role=option]').filter({ hasText: 'grito' }).click();
  await form.getByLabel(/^extra/).fill('{"a": 1');
  await form.getByRole('button', { name: 'Revisar antes de ejecutar' }).click();
  await form.getByText(/debe escribirse en JSON/).waitFor();
  await form.getByLabel(/^extra/).fill('{"a": 1}');
  await form.getByRole('button', { name: 'Revisar antes de ejecutar' }).click();
  const review = form.getByRole('group', { name: 'Confirmar ejecución' });
  await review.getByText(/con las credenciales de/).waitFor();
  assert.equal(calls.length, 0, 'nada se envía antes de pulsar Ejecutar');
  await review.getByRole('button', { name: 'Ejecutar' }).click();
  await form.getByText('hola hola').waitFor();
  await form.getByText('Una línea que parece una clave está oculta.').waitFor();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { args: { texto: 'hola', veces: 2, modo: 'grito', extra: { a: 1 } } });
  assert.match(calls[0].url, /\/tools\/eco_prueba\/call$/);
  assert.deepEqual(errors, []);
  console.log('MCP a mano: validación, revisión, confirmación, envío exacto y resultado (interceptado, sin conectar con ningún servicio).');
} finally { await browser.close(); }
