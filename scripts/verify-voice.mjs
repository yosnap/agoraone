import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { appUrl } from './verify-targets.mjs';
// Voice. Settings › Voz read live (what whisper.cpp, ffmpeg and model were found; prints only whether it is
// ready). Then dictation in Watson's chat with a generated tone instead of the microphone and the
// transcription served by the test: recording, stopping, and the words landing in the text box, unsent.
// Last, a meeting recorded for real against the core with the generated microphone (system audio off, so
// nothing of the Mac is recorded): the rail's indicator, the pieces reaching the core, stopping and deleting.
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
const page = await context.newPage();
const errors = [], uploads = [], sent = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/api/core/alerts/due', route => route.fulfill({ json: { notifications: [] } }));
await page.goto(appUrl(5173, 'ajustes&pestana=voz'));
const card = page.locator('article', { has: page.getByRole('heading', { name: 'Voz', exact: true }) });
await card.locator('.status-badge').waitFor({ timeout: 60_000 });
console.log(`voz: ${await card.locator('.status-badge').innerText()}`);
assert.equal(await page.locator('.page select').count(), 0, 'ningún select nativo');
if (shots) await card.screenshot({ path: `${shots}/voice-settings.png` });

await page.route('**/api/core/voice/transcribe', route => { uploads.push(route.request().headers()['content-type']); return route.fulfill({ json: { text: '¿Qué tengo mañana?', language: 'es', seconds: 2 } }); });
await page.route('**/api/core/assistant/conversations/*/messages', route => { sent.push(1); return route.abort(); });
await page.goto(appUrl(5173, 'asistente'));
const input = page.locator('#assistant-input');
await input.waitFor({ timeout: 60_000 });
await input.fill('Oye,');
const dictate = page.getByRole('button', { name: /Dictar/ });
await dictate.click();
const recording = page.locator('.dictation-button[aria-pressed="true"]');
await recording.waitFor();
await page.waitForTimeout(1500);
await recording.click();
await page.locator('.dictation-button[aria-pressed="false"]:not([aria-busy="true"])').waitFor({ timeout: 20_000 });
await page.waitForFunction(() => document.querySelector('#assistant-input')?.value.includes('mañana'), null, { timeout: 20_000 });
assert.equal(await input.inputValue(), 'Oye, ¿Qué tengo mañana?', 'lo dictado se añade a lo escrito');
assert.equal(uploads.length, 1, 'se transcribe una vez');
assert.match(uploads[0], /^audio\//, 'se sube el audio grabado');
assert.equal(sent.length, 0, 'dictar no envía nada');
if (shots) await page.screenshot({ path: `${shots}/voice-dictation.png` });
assert.deepEqual(errors, [], 'sin errores JS');
console.log('dictado en el chat: correcto');

await page.unroute('**/api/core/voice/transcribe');
await page.goto(appUrl(5173, 'reuniones'));
await page.getByRole('heading', { name: 'Reuniones', level: 1 }).waitFor({ timeout: 60_000 });
await page.getByLabel('Título').fill('Prueba automática de grabación');
const system = page.getByLabel(/audio del sistema/);
if (await system.isChecked()) await system.uncheck();
await page.getByRole('button', { name: 'Empezar a grabar' }).click();
await page.getByRole('button', { name: 'Parar la grabación' }).waitFor({ timeout: 20_000 });
assert.equal(await page.locator('.rail-recording').count(), 1, 'la barra lateral avisa de que graba');
await page.waitForTimeout(6500); // more than one 5 s piece
await page.getByRole('button', { name: 'Parar la grabación' }).click();
await page.getByRole('button', { name: 'Empezar a grabar' }).waitFor({ timeout: 20_000 });
assert.equal(await page.locator('.rail-recording').count(), 0, 'el aviso desaparece al parar');
const row = page.locator('.meeting-row', { hasText: 'Prueba automática de grabación' }).first();
await row.waitFor({ timeout: 20_000 });
const text = await row.innerText();
assert.match(text, /Grabada/, 'queda grabada');
assert.doesNotMatch(text, /Tu micrófono: vacío/, 'el micrófono llegó al núcleo');
if (shots) await page.screenshot({ path: `${shots}/meetings.png` });
await row.getByRole('button', { name: 'Borrar' }).click();
await row.getByRole('button', { name: 'Borrar' }).last().click();
await page.locator('.meeting-row', { hasText: 'Prueba automática de grabación' }).waitFor({ state: 'detached', timeout: 20_000 });
assert.equal(await page.locator('.page select').count(), 0, 'ningún select nativo');
assert.deepEqual(errors, [], 'sin errores JS');
console.log('reunión grabada, parada y borrada: correcto');
await browser.close();
