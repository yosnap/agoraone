import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createOrcaMailbox, getOrcaBots } from '../api/orca-bots';

test('los bots se leen y el buzón solo se crea con su botón', async () => {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response(JSON.stringify({ on: true, bots: [], mailbox: null, problem: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try { await getOrcaBots(); await createOrcaMailbox(); } finally { globalThis.fetch = original; }
  assert.deepEqual(seen, ['GET /api/core/orca/bots', 'POST /api/core/orca/mailbox']);
  const panel = readFileSync(new URL('./orca-bots.tsx', import.meta.url), 'utf8');
  assert.equal(panel.match(/createOrcaMailbox\(\)/g)?.length, 1);  // only from «Crear el buzón de AgoraOne»
  assert.match(panel, /label="Crear el buzón de AgoraOne"/);
});

test('la vista previa del envío a un bot enseña el bot, el chat nuevo y el texto exacto', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { BotErrandFacts } = await import('./orca-bot-errand');
  const preview = { id: 'x'.repeat(22), bot: { id: 'b1', name: 'Seguridad', agent: 'claude' }, kind: 'question' as const, kindLabel: 'Preguntar',
    client: 'Acme', project: 'Web', repo: 'acme/web', orcaName: 'Web de Acme', source: null, subject: 'Web: ¿hay fallos?', body: 'Texto <b>exacto</b>' };
  const html = renderToStaticMarkup(createElement(BotErrandFacts, { preview }));
  assert.match(html, /Seguridad/);
  assert.match(html, /nunca su chat principal/);
  assert.match(html, /Texto &lt;b&gt;exacto&lt;\/b&gt;/);  // shown as text, never as HTML
  const card = readFileSync(new URL('./orca-launch.tsx', import.meta.url), 'utf8');
  assert.equal(card.match(/sendBotErrand\(/g)?.length, 1);  // only from «Enviar a <bot>»
});
