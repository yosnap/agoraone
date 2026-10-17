import { chromium } from '@playwright/test';
import { escape, target } from './verify-targets.mjs';
const profile = target('profile');
// Profile spaces: enter, open chat from the desk, MCP screen to integrations centre, exit. No inference.
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport });
  const errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET') posts.push(r.url()); });
  await page.goto('http://127.0.0.1:5173');
  await page.getByRole('button', { name: new RegExp(`Perfil · ${escape(profile)}`) }).first().click();
  await page.getByRole('button', { name: new RegExp(`Entrar en el espacio de ${escape(profile)}`) }).click();
  await page.getByText(`04 / ESPACIO DE ${profile.toUpperCase()}`).waitFor();
  await page.getByRole('button', { name: `Conversar con ${profile}` }).first().click();
  await page.getByLabel(/Tu mensaje/).waitFor();
  await page.getByRole('button', { name: 'Cerrar espacio' }).click();
  if (viewport.width > 800) await page.getByRole('button', { name: /^MCP · / }).first().click({ timeout: 15000 });
  else { await page.getByRole('button', { name: 'Ver ficha' }).click(); await page.locator('.catalog-link').filter({ hasText: /habilitado|deshabilitado/ }).first().click(); }
  await page.getByText('03 / CENTRO DE INTEGRACIONES').waitFor();
  if (await page.getByRole('button', { name: 'Cerrar espacio' }).isVisible()) await page.getByRole('button', { name: 'Cerrar espacio' }).click();
  await page.getByRole('button', { name: 'Salir del centro' }).click();
  await page.getByText('01 / TU CIUDAD DIGITAL').waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(posts.length, 0, 'sin peticiones mutadoras ni de inferencia');
  console.log(`${viewport.width}px: espacio, conversación, MCP → centro y salida OK · desbordamiento=${overflow}`);
  await page.close();
}
await browser.close();
