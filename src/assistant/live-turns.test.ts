import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetTurn, startTurn, takeEvents } from './live-turns.ts';

// The core as the browser sees it: the answer as Server-Sent Events, then the stored conversation.
function core(events: string, stored: unknown) {
  globalThis.fetch = (async (url: string) => String(url).endsWith('/messages')
    ? new Response(events, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    : new Response(JSON.stringify(stored), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
}

test('la respuesta sigue sin ningún chat en pantalla y sus propuestas se entregan una sola vez', async () => {
  const proposal = { profile: 'codeia', task: 'Revisa la web' };
  core([
    `event: stage\ndata: ${JSON.stringify({ stage: 'piensa' })}\n\n`,
    `event: tool\ndata: ${JSON.stringify({ tool: 'hermes_proposal', proposal })}\n\n`,
    `event: delta\ndata: ${JSON.stringify({ text: 'Hecho.' })}\n\n`,
    `event: done\ndata: ${JSON.stringify({ engine: 'claude-code', model: 'sonnet' })}\n\n`,
  ].join(''), { messages: [{ role: 'user', content: 'Hola' }, { role: 'assistant', content: 'Hecho.', failed: false }] });
  // Nobody is watching while it answers (the user went to another section).
  assert.equal(await startTurn(7, 'Hola'), true);
  const taken = takeEvents(7);
  assert.deepEqual(taken.filter(e => e.kind === 'tool').map(e => e.kind === 'tool' && e.tool), ['hermes_proposal']);
  assert.deepEqual(takeEvents(7), [], 'una tarjeta no se abre dos veces');
  forgetTurn(7);
  assert.deepEqual(takeEvents(7), []);
});

test('un fallo del núcleo queda en el turno para enseñarlo al volver', async () => {
  core(`event: error\ndata: ${JSON.stringify({ error: 'Motor caído' })}\n\n`, { messages: [] });
  assert.equal(await startTurn(8, 'Hola'), false);
});
