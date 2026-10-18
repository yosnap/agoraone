import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { escape, target, appUrl } from './verify-targets.mjs';

// Approval card in a profile chat, without reaching the profile: the page's own fetch answers the
// message with a scripted stream (a read tool, then a write that waits for the user) and records the
// answer. Only creating the AgoraOne conversation reaches the server; no turn, inference or tool runs.
const profile = target('profile');
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
try {
  for (const choice of ['once', 'deny']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [], network = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/\/messages$|\/approvals\//.test(request.url())) network.push(request.url()); });
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      let created = null;
      window.fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith('/api/conversations') && init.method === 'POST') {
          const response = await original(input, init);
          created = await response.clone().json();
          return response;
        }
        if (url.endsWith('/messages') && init.method === 'POST') {
          const { message } = JSON.parse(init.body);
          let control;
          const stream = new ReadableStream({ start(c) { control = c; } });
          const send = event => control.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
          send({ type: 'status', stage: 'generating' });
          send({ type: 'tool', state: 'start', name: 'read_file' }); send({ type: 'tool', state: 'end', name: 'read_file' });
          send({ type: 'approval', requestId: 'a'.repeat(32), tool: 'write_file', description: 'AgoraOne pide confirmación', args: 'path:\nsalida.txt\n\ncontent:\nexport API_KEY=***\nrm -rf ~/x', redacted: true, truncated: false, length: 40, rewritable: false });
          window.__finish = answer => {
            const reply = answer === 'once' ? 'Fichero escrito.' : 'No lo he escrito porque lo denegaste.';
            send({ type: 'done', conversation: { ...created, messages: [{ role: 'user', content: message }, { role: 'assistant', content: reply, tools: ['read_file'] }] } });
            control.close();
          };
          return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
        }
        if (url.includes('/approvals/')) {
          window.__answered = JSON.parse(init.body).choice;
          setTimeout(() => window.__finish(window.__answered), 50);
          return new Response(JSON.stringify({ answered: 'a'.repeat(32) }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return original(input, init);
      };
    });
    await page.goto(appUrl());
    // Initial scene load only: headless Chromium renders WebGL in software, so allow it time.
    await page.locator('.directory').getByRole('button', { name: new RegExp(`Perfil · ${escape(profile)}`) }).click({ timeout: 120_000 });
    await page.getByRole('button', { name: new RegExp(`^Conversar con ${escape(profile)}$`) }).first().click();
    await page.getByLabel(/Tu mensaje/).fill('Guarda una nota de prueba');
    await page.getByRole('button', { name: /Enviar a Hermes/ }).click();
    const card = page.getByRole('group', { name: `${profile} quiere usar write_file` });
    await card.waitFor();
    await page.getByText('Herramientas usadas: read_file').first().waitFor();
    await page.getByText('Esperando tu confirmación', { exact: false }).waitFor();
    await card.getByText(/Se han ocultado fragmentos/).waitFor();
    await card.getByText(/rm -rf ~\/x/).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Denegar', 'el foco empieza en la opción segura');
    await card.getByRole('button', { name: choice === 'once' ? 'Permitir' : 'Denegar' }).click();
    await page.getByText(choice === 'once' ? 'Fichero escrito.' : 'No lo he escrito porque lo denegaste.').waitFor();
    await card.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.__answered), choice);
    assert.deepEqual(network, [], 'ni el turno ni la respuesta salen de la página');
    assert.deepEqual(errors, []);
    console.log(`Tarjeta de confirmación (${choice === 'once' ? 'permitir' : 'denegar'}) en el chat de ${profile}: OK, sin turno real.`);
    await page.close();
  }
} finally { await browser.close(); }
