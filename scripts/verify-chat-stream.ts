import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { HermesDiscovery } from '../server/hermes-catalog';

// Isolated test server. Requires port 4317 free; no model calls or real profiles.
const root = mkdtempSync(join(tmpdir(), 'agora-stream-ui-'));
let finish: (() => void) | undefined;
const server = createApp({ directory: join(root, 'conversations'),
  discovery: new HermesDiscovery({ root, installation: '/absent', python: '', source: 'test' }),
  adapter: async (_turn, progress) => {
    progress?.({ type: 'status', stage: 'generating' });
    progress?.({ type: 'delta', text: 'Fragmento de prueba visible' });
    await new Promise<void>(resolve => { finish = resolve; });
    return 'Respuesta completa de prueba';
  },
}).listen(4317, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4317');
  await page.getByRole('button', { name: 'Luma', exact: true }).click();
  await page.getByLabel('Tu mensaje a Luma').fill('Prueba de streaming');
  await page.getByRole('button', { name: 'Enviar a Hermes' }).click();
  await page.getByText('Fragmento de prueba visible', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Tu mensaje a Luma').isDisabled(), true);
  assert.ok(finish, 'El fragmento debe verse antes de completar la respuesta');
  finish();
  await page.getByText('Respuesta completa de prueba', { exact: true }).waitFor();
  assert.equal(await page.getByText('Fragmento de prueba visible', { exact: true }).count(), 0);
  await page.reload();
  await page.getByRole('button', { name: 'Luma', exact: true }).click();
  await page.getByText('Respuesta completa de prueba', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Streaming visible antes de terminar, sustitución final y recarga: OK (sin inferencia).');
} finally {
  finish?.(); await browser.close(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true });
}
