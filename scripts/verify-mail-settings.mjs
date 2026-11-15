import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { appUrl } from './verify-targets.mjs';
// Settings › mail accounts, read only: the card loads with its accounts and presets, the new-account form
// shows the IMAP fields only for «Otro servidor», and nothing is written. Prints counts, never addresses.
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: true });
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const page = await browser.newPage({ viewport });
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET' && !r.url().endsWith('/api/session')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.goto(appUrl(5173, 'ajustes&pestana=correo'));
  const card = page.locator('.settings-mail');
  await card.waitFor({ timeout: 60_000 });
  console.log(`${viewport.width}px · cuentas conectadas: ${await card.locator('.mail-accounts > li').count()}`);
  await card.getByRole('button', { name: 'Añadir cuenta' }).click();
  const form = card.getByRole('form', { name: 'Nueva cuenta de correo' });
  await form.waitFor();
  assert.equal(await form.getByLabel('Servidor IMAP').count(), 0, 'Gmail no pide servidor');
  await form.locator('.modern-select button').first().click();
  await page.getByRole('option', { name: /Otro servidor/ }).click();
  await form.getByLabel('Servidor IMAP').waitFor();
  // Inside a <label> a pick must not reopen the list (the click would be forwarded to the trigger).
  assert.equal(await page.getByRole('listbox').count(), 0, 'el desplegable se cierra al elegir');
  assert.equal(await page.getByRole('option').count(), 0);
  // Microsoft: no password field; the app registration's id and its steps instead.
  await form.locator('.modern-select button').first().click();
  await page.getByRole('option', { name: /Microsoft/ }).click();
  await form.getByText('Aplicación de Microsoft').waitFor();
  assert.equal(await form.getByLabel('Contraseña de aplicación').count(), 0, 'Microsoft no pide contraseña');
  assert.equal(await page.locator('.page select').count(), 0, 'ningún select nativo');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'sin desplazamiento horizontal');
  if (shots) await card.screenshot({ path: `${shots}/mail-settings-${viewport.width}.png` });
  await form.getByRole('button', { name: 'Cancelar' }).click();
  assert.deepEqual(writes, [], 'no se escribió nada');
  assert.deepEqual(errors, [], 'sin errores JS');
  await page.close();
}

// The tabs: one per area, with the keyboard, and the address names the open one (?pestana=…).
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(appUrl(5173, 'ajustes&pestana=general'));
const tabs = page.getByRole('tab');
await page.getByRole('tablist', { name: 'Apartados de Ajustes' }).waitFor({ timeout: 60_000 });
assert.deepEqual(await tabs.allInnerTexts(), ['General', 'Asistente', 'Correo', 'Agenda y avisos', 'Fiscal', 'Trabajos', 'Privacidad y copias']);
await page.getByRole('tab', { name: 'General' }).focus();
await page.keyboard.press('ArrowRight');
assert.equal(await page.getByRole('tab', { selected: true }).innerText(), 'Asistente', 'las flechas cambian de pestaña');
assert.match(page.url(), /pestana=asistente/);
await page.keyboard.press('End');
await page.getByRole('heading', { name: 'Copias de seguridad' }).or(page.getByRole('heading', { name: /Copias/ })).first().waitFor();
assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'las pestañas no desbordan la página en el móvil');
assert.deepEqual(errors, [], 'sin errores JS');
console.log('pestañas de Ajustes: correctas');
await browser.close();
console.log('verify-mail-settings correcto');
