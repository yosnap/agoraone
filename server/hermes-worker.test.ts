import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerRequest, closeHermesWorkers } from './hermes-worker';

test('worker exclusivo por sesión: reutilización, concurrencia y descarte tras fallo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agora-worker-'));
  const script = join(root, 'fixture.cjs');
  writeFileSync(script, `const readline = require('node:readline');
    readline.createInterface({input:process.stdin}).on('line', line => {
      const data = JSON.parse(line);
      console.log(JSON.stringify({type:'delta',text:'fragmento'}));
      setTimeout(() => console.log(JSON.stringify({type:'done',ok:!data.fail,pid:process.pid})), 25);
    });`);
  const call = (key: string, payload = {}) => workerRequest(key, process.execPath, script, root, {}, payload);
  try {
    const first = await call('a');
    assert.equal((await call('a')).pid, first.pid);
    assert.notEqual((await call('b')).pid, first.pid);
    const pending = call('a');
    await assert.rejects(call('a'), /en curso/);
    await pending;
    await assert.rejects(call('a', { fail: true }), /no completó/);
    assert.notEqual((await call('a')).pid, first.pid);
    assert.equal((await call('b')).ok, true);
  } finally { closeHermesWorkers(); rmSync(root, { recursive: true }); }
});
