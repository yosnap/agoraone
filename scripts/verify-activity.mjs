import { chromium } from '@playwright/test';
import { escape, target } from './verify-targets.mjs';
const profile = target('profile');
// Real Hermes activity: status bar, profile card section and room boards. Read-only, no inference.
import assert from 'node:assert/strict';
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport });
  const errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET') posts.push(r.url()); });
  await page.goto('http://127.0.0.1:5173');
  await page.getByText(/Gateway Hermes · (en marcha|detenido|sin datos|sin estado)/).waitFor({ timeout: 120_000 });
  if (shots) { await page.waitForTimeout(8000); await page.screenshot({ path: `${shots}/city-${viewport.width}.png` }); }
  await page.getByRole('button', { name: new RegExp(`Perfil · ${escape(profile)}`) }).first().click();
  const section = page.getByLabel('Actividad real registrada por Hermes');
  await section.getByText('Conexiones del gateway').waitFor();
  await section.getByText(/Última actividad|Actividad registrada/).first().waitFor();
  await section.getByText('Herramientas usadas').waitFor();
  if (shots) await page.screenshot({ path: `${shots}/card-${viewport.width}.png` });
  await page.getByRole('button', { name: new RegExp(`Entrar en el espacio de ${escape(profile)}`) }).click();
  await page.getByText(`04 / ESPACIO DE ${profile.toUpperCase()}`).waitFor();
  await page.locator('.room-board').first().waitFor({ state: 'attached' });
  assert.equal(await page.locator('.room-board').count(), 2);
  // MCP screens carry the recorded use (or its absence), never a guessed state.
  if (await page.locator('.place-label', { hasText: /^MCP · / }).count()) await page.locator('.place-label', { hasText: /usado hace|sin uso registrado/ }).first().waitFor({ state: 'attached' });
  if (shots) { await page.waitForTimeout(6000); await page.screenshot({ path: `${shots}/room-${viewport.width}.png` }); }
  await page.getByRole('button', { name: 'Salir del espacio' }).click();
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(posts.length, 0, 'sin peticiones mutadoras ni de inferencia');
  console.log(`${viewport.width}px: barra de estado, ficha y paneles del espacio OK`);
  await page.close();
}
await browser.close();
