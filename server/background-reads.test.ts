import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { BackgroundReads } from './background-reads';

test('hilo de lectura: responde en otro hilo, limita la cola y rechaza lo pendiente al cerrarse', async () => {
  const root = realpathSync(mkdtempSync(join(process.cwd(), '.agora-reads-test-')));
  const reads = new BackgroundReads(null);
  try {
    const activity = await reads.activity(root, []);
    assert.equal(activity.gateway.state, 'missing');
    // Eight requests may wait at once; the ninth is refused immediately instead of queuing without bound.
    const burst = Array.from({ length: 9 }, () => reads.activity(root, []).then(() => 'ok', error => (error as Error).message));
    const results = await Promise.all(burst);
    assert.equal(results.filter(result => result === 'ok').length, 8);
    assert.match(results[8], /Lectura local no disponible/);
    await assert.rejects(reads.vaultList('vault-desconocido'), /Nota no disponible/);
    const pending = assert.rejects(reads.activity(root, []), /Lectura local no disponible/);
    await reads.close();
    await pending;
    assert.equal((await reads.activity(root, [])).gateway.state, 'missing', 'un hilo nuevo sustituye al cerrado');
  } finally { await reads.close(); rmSync(root, { recursive: true, force: true }); }
});
