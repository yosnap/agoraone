import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../api/client';
import { RETRY_DELAYS, transient, withRetries } from './piece-retry';

const noWait = async () => undefined;

test('un trozo que falla por la red o el núcleo se reintenta y la grabación sigue', async () => {
  let tries = 0;
  const sent = await withRetries(async () => { tries++; if (tries < 3) throw new ApiError('El núcleo de AgoraOne no está disponible.', 503); return 'ok'; }, noWait);
  assert.equal(sent, 'ok');
  assert.equal(tries, 3);
});

test('una respuesta definitiva del núcleo no se reintenta', async () => {
  let tries = 0;
  await assert.rejects(withRetries(async () => { tries++; throw new ApiError('Esta reunión ya no se está grabando.', 409); }, noWait), /ya no se está grabando/);
  assert.equal(tries, 1);
  assert.equal(transient(new ApiError('Demasiado grande.', 413)), false);
  assert.equal(transient(new TypeError('Failed to fetch')), true);
});

test('se rinde tras los reintentos, antes de que el núcleo pare la reunión por silencio', async () => {
  let tries = 0;
  const waited: number[] = [];
  await assert.rejects(withRetries(async () => { tries++; throw new TypeError('Failed to fetch'); }, async ms => { waited.push(ms); }));
  assert.equal(tries, RETRY_DELAYS.length + 1);
  assert.ok(waited.reduce((a, b) => a + b, 0) < 45_000);
});
