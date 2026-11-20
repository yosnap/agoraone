import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { answeringIn, forgetTurn, startTurn, turnOf } from './live-turns.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// The core as the browser sees it: the answer as Server-Sent Events, then the stored conversation.
function core(events: string, stored: unknown, wait?: Promise<void>) {
  globalThis.fetch = (async (url: string) => {
    if (!String(url).endsWith('/messages')) return new Response(JSON.stringify(stored), { status: 200, headers: { 'Content-Type': 'application/json' } });
    await wait;
    return new Response(events, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
}
const sse = (kind: string, data: unknown) => `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;

test('la respuesta sigue sin ningún chat en pantalla y guarda sus propuestas para quien la abra', async () => {
  const proposal = { profile: 'codeia', task: 'Revisa la web' };
  core(sse('stage', { stage: 'piensa' }) + sse('tool', { tool: 'hermes_proposal', proposal }) + sse('delta', { text: 'Hecho.' }) + sse('done', { engine: 'claude-code', model: 'sonnet' }),
    { messages: [{ role: 'user', content: 'Hola' }, { role: 'assistant', content: 'Hecho.', failed: false }] });
  // Nobody is watching while it answers (the user went to another section).
  assert.equal(await startTurn(7, 'Hola'), true);
  const turn = turnOf(7)!;
  assert.equal(turn.done, true);
  assert.equal(turn.live.text, 'Hecho.');
  assert.deepEqual(turn.events.map(event => event.kind), ['stage', 'tool', 'done'], 'el texto va en live, no como eventos');
  assert.equal(turn.messages?.at(-1)?.content, 'Hecho.');
  forgetTurn(7);
  assert.equal(turnOf(7), undefined);
});

test('un fallo del núcleo queda en el turno para enseñarlo al volver', async () => {
  core(sse('error', { error: 'Motor caído' }), { messages: [] });
  assert.equal(await startTurn(8, 'Hola'), false);
  assert.equal(turnOf(8)?.error, 'Motor caído');
  forgetTurn(8);
});

test('una sola respuesta a la vez: la segunda pregunta no se manda mientras la primera sigue', async () => {
  let release!: () => void;
  core(sse('done', { engine: 'claude-code', model: 'sonnet' }), { messages: [] }, new Promise<void>(resolve => { release = resolve; }));
  const first = startTurn(9, 'Primera');
  assert.equal(answeringIn(), 9);
  assert.equal(await startTurn(10, 'Segunda'), false);
  assert.equal(turnOf(10), undefined);
  release();
  assert.equal(await first, true);
  assert.equal(answeringIn(), null);
  forgetTurn(9);
});
