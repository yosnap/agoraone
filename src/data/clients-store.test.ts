import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentClients, invalidateClients, readClients } from './clients-store';

test('una lista de clientes ya leída se vuelve a leer tras cambiar un cliente', async () => {
  let calls = 0;
  const names = [['Acme'], ['Acme', 'Café Web']];
  globalThis.fetch = (async () => {
    const clients = names[Math.min(calls++, 1)].map(name => ({ name, projects: [] }));
    return new Response(JSON.stringify({ clients, suggestions: [], central: { on: false, read: false } }), { status: 200 });
  }) as typeof fetch;
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  invalidateClients();
  assert.equal(calls, 0, 'sin nadie que la haya leído no se pide nada');
  readClients(false); await settle();
  readClients(false); await settle();
  assert.equal(calls, 1, 'leída una vez para todas las pantallas');
  invalidateClients(); await settle();
  assert.equal(calls, 2);
  assert.deepEqual(currentClients().clients?.map(c => c.name), ['Acme', 'Café Web']);
});
