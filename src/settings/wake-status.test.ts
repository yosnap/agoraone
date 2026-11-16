import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wakeStatus } from './wake-status.ts';

test('«Oye Watson» dice cuándo escucha y por qué no, con el arreglo', () => {
  assert.equal(wakeStatus('listening').ok, true);
  assert.match(wakeStatus('no_offline').text, /Dictado en español/);
  assert.equal(wakeStatus('no_mic_permission').retry, true);
  assert.match(wakeStatus(null).text, /solo funciona en AgoraOne para Mac/);
});
