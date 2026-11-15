import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { appUrl } from './verify-targets.mjs';
// Voice. Settings › Voz read live (what whisper.cpp, ffmpeg and model were found; prints only whether it is
// ready). Then dictation in Watson's chat with a generated tone instead of the microphone and the
// transcription served by the test: recording, stopping, and the words landing in the text box, unsent.
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
await page.getByRole('button', { name: /Parar/ }).waitFor();
await page.waitForTimeout(1500);
await page.getByRole('button', { name: /Parar/ }).click();
await page.getByRole('button', { name: /Dictar/ }).waitFor({ timeout: 20_000 });
assert.equal(await input.inputValue(), 'Oye, ¿Qué tengo mañana?', 'lo dictado se añade a lo escrito');
assert.equal(uploads.length, 1, 'se transcribe una vez');
assert.match(uploads[0], /^audio\//, 'se sube el audio grabado');
assert.equal(sent.length, 0, 'dictar no envía nada');
if (shots) await page.screenshot({ path: `${shots}/voice-dictation.png` });
assert.deepEqual(errors, [], 'sin errores JS');
console.log('dictado en el chat: correcto');
await browser.close();
