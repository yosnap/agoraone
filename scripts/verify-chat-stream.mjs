import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { appUrl } from './verify-targets.mjs';

// Luma's chat streaming in the browser, with no model and nothing written: only this conversation is
// intercepted. Creating and reading it are answered here, and sending is diverted to a local server that
// streams the NDJSON in two parts, so the partial text must show before the answer ends, then give way to
// the final answer, which must still be there after a reload.
const id = '00000000-0000-4000-8000-0000000000aa';
const question = 'Prueba de streaming';
const final = { id, messages: [{ role: 'user', content: question }, { role: 'assistant', content: 'Respuesta completa de prueba' }], source: 'hermes' };
let finish, finished = false;
const stream = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  res.write(`${JSON.stringify({ type: 'status', stage: 'starting' })}\n${JSON.stringify({ type: 'status', stage: 'generating' })}\n${JSON.stringify({ type: 'delta', text: 'Fragmento de prueba visible' })}\n`);
  finish = () => { finished = true; res.end(`${JSON.stringify({ type: 'done', conversation: final })}\n`); };
});
await new Promise(resolve => stream.listen(0, '127.0.0.1', resolve));
const port = stream.address().port;
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/api\/conversations(\/[^/]+)?(\/messages)?$/, route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/api/conversations') return route.fulfill({ status: 201, json: { id, messages: [] } });
    if (request.method() === 'POST' && url.pathname.endsWith(`/${id}/messages`)) return route.continue({ url: `http://127.0.0.1:${port}/stream` });
    if (request.method() === 'GET' && url.pathname.endsWith(`/${id}`)) return route.fulfill({ json: finished ? final : { id, messages: [] } });
    return route.continue();
  });
  await page.goto(appUrl());
  // Initial scene load only: headless Chromium renders WebGL in software, so allow it time.
  await page.getByRole('button', { name: 'Luma', exact: true }).click({ timeout: 120_000 });
  await page.getByLabel('Tu mensaje a Luma').fill(question);
  await page.getByRole('button', { name: 'Enviar a Hermes' }).click();
  await page.getByText('Fragmento de prueba visible', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Tu mensaje a Luma').isDisabled(), true);
  assert.ok(finish && !finished, 'El fragmento debe verse antes de completar la respuesta');
  finish();
  await page.getByText('Respuesta completa de prueba', { exact: true }).waitFor();
  assert.equal(await page.getByText('Fragmento de prueba visible', { exact: true }).count(), 0);
  await page.reload();
  await page.getByRole('button', { name: 'Luma', exact: true }).click({ timeout: 120_000 });
  await page.getByText('Respuesta completa de prueba', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Streaming visible antes de terminar, sustitución final y recarga: OK (interceptado, sin inferencia ni escrituras).');
} finally {
  if (!finished) finish?.();
  await browser.close();
  stream.closeAllConnections();
  await new Promise(resolve => stream.close(() => resolve()));
}
