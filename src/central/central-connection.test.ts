import assert from 'node:assert/strict';
import { test } from 'node:test';
import { centralConnection } from '../api/central';
import type { ConnectorState } from '../api/core';

const URL = 'https://central.example.com';
const of = (state: Partial<ConnectorState>, hint: string | null = URL) =>
  centralConnection({ hint, state: { status: 'not_configured', configured: {}, notice: null, storeProblem: null, ...state } });

test('con dirección y clave guardadas, Central está conectado', () => {
  assert.deepEqual(of({ status: 'saved', configured: { url: URL, hasKey: true } }),
    { url: URL, hasKey: true, storeProblem: null, legacy: false, transport: 'http', suggestedUrl: URL });
});

test('un estado comprobado más adelante sigue contando como conectado', () => {
  for (const status of ['responding', 'failing'] as const) {
    assert.equal(of({ status, configured: { url: URL, hasKey: true } }).transport, 'http', status);
  }
});

test('sin dirección o sin clave no hay conexión; la carpeta antigua se avisa', () => {
  assert.equal(of({ configured: { url: URL, hasKey: false } }).transport, null);
  assert.equal(of({ configured: { url: null, hasKey: true } }).transport, null);
  const legacy = of({ status: 'legacy', configured: { url: null, hasKey: false }, notice: 'Ahora Central se conecta…' });
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.transport, null);
  const empty = of({}, null);
  assert.deepEqual([empty.url, empty.hasKey, empty.legacy, empty.suggestedUrl], [null, false, false, 'https://central.example.com']);
  assert.equal(of({ storeProblem: 'Sin almacén' }).storeProblem, 'Sin almacén');
});
