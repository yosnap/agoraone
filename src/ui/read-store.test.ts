import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReadStore, readKey } from './read-store';

const settle = () => new Promise(resolve => setTimeout(resolve, 5));
const noop = () => {};

test('una lectura se pide al verse, una sola vez aunque la vean dos pantallas', async () => {
  const store = createReadStore('x');
  let calls = 0;
  const fetcher = async () => { calls++; return 'datos'; };
  const a = store.watch('k', fetcher, noop);
  const b = store.watch('k', fetcher, noop);
  await settle();
  assert.equal(calls, 1);
  a(); b();
});

test('«Volver a leer» sin conservar (Central): lo que se ve se pide ya y sin datos viejos; lo excluido se queda', async () => {
  const store = createReadStore('x');
  const calls: string[] = [];
  store.ensure('conexion', async () => { calls.push('conexion'); return 'c'; });
  const stop = store.watch('alertas?', async () => { calls.push('alertas'); return 'a'; }, noop);
  store.ensure('webs?', async () => 'w');  // read, not on screen
  await settle();
  store.forget({ except: ['conexion'] });
  assert.deepEqual(calls, ['conexion', 'alertas', 'alertas'], 'la vista en pantalla se pide en el acto; la conexión no');
  assert.deepEqual(store.peek('alertas?'), { data: null, failure: null, loading: true }, 'sin datos viejos mientras se lee');
  assert.equal(store.has('webs?'), false, 'lo que no se ve se olvida');
  assert.equal(store.peek('conexion')?.data, 'c');
  await settle();
  assert.equal(store.peek('alertas?')?.data, 'a');
  stop();
});

test('«Volver a leer» conservando (CRMDev): pasa «fresco», da una lectura nueva y mantiene lo leído hasta la respuesta', async () => {
  const store = createReadStore('x');
  const fresh: boolean[] = [];
  let answer = 'vieja';
  const stop = store.watch('k', async (isFresh: boolean) => { fresh.push(isFresh); return answer; }, noop);
  await settle();
  const before = store.peek('k');
  answer = 'nueva';
  store.forget({ keep: true, fresh: true });
  assert.deepEqual(fresh, [false, true]);
  const during = store.peek('k');
  assert.notEqual(during, before, 'otra lectura: la pantalla se vuelve a pintar');
  assert.deepEqual(during, { data: 'vieja', failure: null, loading: true });
  await settle();
  assert.equal(store.peek('k')?.data, 'nueva');
  stop();
});

test('la clave no depende del orden de los parámetros y omite los vacíos', () => {
  assert.equal(readKey('v', { b: '2', a: '1', c: undefined }), readKey('v', { a: '1', b: '2' }));
  assert.equal(readKey('v'), 'v?');
});
