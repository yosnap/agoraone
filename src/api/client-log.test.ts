import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './client';
import { describe, makeReporter, place } from './client-log';

test('the reporter limits repeats and volume, and survives a failed send', async () => {
  let clock = 0;
  const sent: string[] = [];
  const report = makeReporter(async entry => { sent.push(entry.message); throw new Error('sin núcleo'); }, () => clock);
  assert.equal(report('error', 'a'), true);
  assert.equal(report('error', 'a'), false);  // same text within 30 s
  clock = 31_000;
  assert.equal(report('error', 'a'), true);
  for (let n = 0; n < 30; n++) report('error', `e${n}`);
  assert.equal(sent.length, 20);  // 20 a minute
  clock = 100_000;
  assert.equal(report('error', 'nuevo'), true);
});

test('only the file name and line are kept, never the address', () => {
  assert.equal(place('http://127.0.0.1:5173/src/inbox/inbox.tsx?t=123#acceso=secreto', 12), ' (inbox.tsx:12)');
  assert.equal(place(undefined, 3), '');
});

test('an API error keeps only its status, never the backend text', () => {
  assert.equal(describe(new ApiError('No existe el cliente Pérez y Asociados', 404)), 'ApiError: respuesta 404 del backend');
  assert.equal(describe(new TypeError('x is undefined')), 'TypeError: x is undefined');
});
