import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CentralState } from '../api/core';
import { centralCardView, hasCentralData } from './central-card-state';

const snapshot: CentralState['snapshot'] = { clients: [], servers: [{ name: 'hetzner-1', status: 'green', provider: null, projects: [] }], fetchedAt: '2026-11-19T00:00:00Z' };

test('la instantánea guardada se ve aunque Central ya no esté conectado', () => {
  const legacy: CentralState = { configured: false, transport: null, snapshot, problem: null, notice: 'Ahora Central se conecta con su dirección y una clave de acceso' };
  assert.equal(centralCardView(legacy), 'snapshot');
  assert.equal(hasCentralData(legacy), true);
});

test('sin instantánea, la tarjeta dice si falta conectar o leer', () => {
  assert.equal(centralCardView(null), 'loading');
  assert.equal(centralCardView({ configured: false, snapshot: null, problem: null }), 'not_connected');
  assert.equal(centralCardView({ configured: true, transport: 'http', snapshot: null, problem: null }), 'not_read');
  assert.equal(hasCentralData({ configured: false, snapshot: null, problem: null }), false);
  assert.equal(hasCentralData({ configured: true, transport: 'http', snapshot: null, problem: null }), true);
  assert.equal(hasCentralData(null), false);
});
