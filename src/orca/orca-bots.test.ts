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
