import { chromium } from '@playwright/test';
import { escape, target } from './verify-targets.mjs';
import assert from 'node:assert/strict';

// Checks the user's local catalog read-only. Does not start MCPs or invoke models.
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  let mutations = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET') mutations++; });
  await page.goto('http://127.0.0.1:4317');
  // Initial scene load only: headless Chromium renders WebGL in software (~2 fps), so allow it time.
  await page.locator('.directory').getByRole('button', { name: /Centro de integraciones/ }).click({ timeout: 120_000 });
  assert.equal(await page.locator('.directory').getByRole('button', { name: /^MCP ·/ }).count(), 0);
  await page.getByRole('button', { name: 'Entrar al centro de integraciones' }).click();
  await page.getByRole('navigation', { name: 'Acciones del centro de integraciones' }).waitFor();
  await page.screenshot({ path: '.agora/integrations-interior.png' });
  // Terminal in the actual 3D room, not the alternative directory.
  await page.getByRole('button', { name: `MCP · ${target('mcp')}`, exact: true }).click();
  await page.getByLabel('Buscar herramienta').waitFor();
  const count = await page.locator('.mcp-tools details').count();
  assert.ok(count > 0);
  await page.locator('.mcp-tools summary').first().click();
  await page.locator('.mcp-tools h4').first().waitFor();
  await page.getByLabel('Buscar herramienta').fill('no-such-tool-test');
  assert.equal(await page.locator('.mcp-tools details').count(), 0);
  await page.getByLabel('Buscar herramienta').fill('');
  await page.getByLabel('Perfil de Hermes').selectOption({ label: target('uncachedProfile') });
  await page.getByText('Hermes no tiene un catálogo guardado para este servidor y perfil.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cerrar espacio' }).click();
  await page.getByRole('button', { name: 'Ver MCPs', exact: true }).click();
  await page.locator('.detail-panel').getByRole('button', { name: new RegExp(`^${escape(target('secondaryMcp'))} ·`) }).click();
  await page.getByLabel('Buscar herramienta').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '.agora/integrations-tools-mobile.png' });
  await page.getByRole('button', { name: 'Cerrar espacio' }).click();
  await page.getByRole('button', { name: 'Salir del centro' }).click();
  await page.locator('.directory').waitFor();
  assert.deepEqual(errors, []); assert.equal(mutations, 0);
  console.log({ toolsInFirstCatalog: count, interior: true, profileIsolation: true, search: true, mobile: true, mutations });
} finally { await browser.close(); }
