import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app';
import { HermesDiscovery } from '../server/hermes-catalog';
import { hermesLocation } from '../server/hermes-location';
import { closeHermesWorkers } from '../server/hermes-worker';

// Requires port 4317 free. Real Hermes/provider, fabricated profiles only.
const root = mkdtempSync(resolve('.agora/profile-chat-test-'));
const sourceFiles: [string, string][] = [];
const markers: Record<string, string[]> = {};
for (const name of ['alpha', 'beta']) {
  const home = join(root, 'profiles', name);
  mkdirSync(join(home, 'memories'), { recursive: true });
  markers[name] = [`SOUL-${name}-${Date.now()}`, `MEM-${name}-${Date.now()}`, `USER-${name}-${Date.now()}`];
  for (const [i, file] of ['SOUL.md', 'memories/MEMORY.md', 'memories/USER.md'].entries()) {
    const content = `Documento ficticio de verificación. La clave ${i} de ${name} es ${markers[name][i]}.`;
    const path = join(home, file); writeFileSync(path, content); sourceFiles.push([path, content]);
  }
}
const discovery = new HermesDiscovery({ ...hermesLocation(), root, source: 'Fixtures de verificación' });
const server = createApp({ discovery, directory: join(root, 'conversations'), privateLibraryRoot: join(root, 'imports') }).listen(4317, '127.0.0.1');
await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4317');
  for (const name of ['alpha', 'beta']) {
    await page.locator('.directory').getByRole('button', { name: `Perfil · ${name}`, exact: false }).click();
    await page.getByRole('button', { name: `Conversar con ${name}`, exact: true }).click();
    await page.getByLabel(`Tu mensaje a ${name}`).fill('Indica las tres claves exactas de SOUL, MEMORY y USER que tienes en tu contexto, y solo esas claves.');
    const reply = page.waitForResponse(response => response.url().endsWith('/messages'), { timeout: 125000 });
    await page.getByRole('button', { name: 'Enviar a Hermes' }).click();
    const response = await reply; assert.equal(response.status(), 200);
    const event = (await response.text()).trim().split('\n').map(line => JSON.parse(line)).at(-1);
    assert.equal(event.type, 'done');
    const text = event.conversation.messages.at(-1).content;
    for (const marker of markers[name]) assert.ok(text.includes(marker), `Falta clave de ${name}`);
    for (const marker of markers[name === 'alpha' ? 'beta' : 'alpha']) assert.ok(!text.includes(marker));
    await page.getByRole('button', { name: 'Cerrar espacio' }).click();
  }
  await page.reload();
  await page.locator('.directory').getByRole('button', { name: /Perfil · alpha/ }).click();
  await page.getByRole('button', { name: 'Conversar con alpha', exact: true }).click();
  await page.locator('.message.assistant').waitFor();
  assert.ok((await page.locator('.message.assistant').innerText()).includes(markers.alpha[0]));
  // A manually transplanted history id must not render under another profile.
  const profiles = discovery.scan().profiles;
  await page.evaluate(([alpha, beta]) => {
    localStorage.setItem(`agora-profile-conversation-${beta}`, localStorage.getItem(`agora-profile-conversation-${alpha}`)!);
  }, [profiles[0].id, profiles[1].id]);
  await page.reload();
  await page.locator('.directory').getByRole('button', { name: /Perfil · beta/ }).click();
  await page.getByRole('button', { name: 'Conversar con beta', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>('#message')?.disabled);
  assert.equal(await page.locator('.message').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '.agora/profile-chat-mobile.png' });
  for (const [path, content] of sourceFiles) assert.equal(readFileSync(path, 'utf8'), content);
  assert.deepEqual(errors, []);
  console.log('Dos perfiles ficticios, dos respuestas reales: SOUL/MEMORY/USER, aislamiento, recarga, rechazo de historial cruzado y móvil OK. Fuentes sin cambios.');
} finally {
  closeHermesWorkers();
  await browser.close(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
