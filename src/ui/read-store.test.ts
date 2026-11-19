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
  assert.equal(store.has('alertas?'), false, 'sin datos viejos: la pantalla se pinta vacía');
  assert.equal(store.has('webs?'), false, 'lo que no se ve se olvida');
  assert.equal(store.peek('conexion')?.data, 'c');
  await settle();
  assert.deepEqual(calls, ['conexion', 'alertas', 'alertas'], 'tras pintar, la vista en pantalla se pide; la conexión no');
  await settle();
  assert.equal(store.peek('alertas?')?.data, 'a');
  stop();
});

test('«Volver a leer» conservando (CRMDev): pasa «fresco», da una lectura nueva y mantiene lo leído hasta la respuesta', async () => {
  const store = createReadStore('x');
  const fresh: boolean[] = [];
  let answer = 'vieja';
  let release = noop;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stop = store.watch('k', async (isFresh: boolean) => { fresh.push(isFresh); if (isFresh) await gate; return answer; }, noop);
  await settle();
  const before = store.peek('k');
  answer = 'nueva';
  store.forget({ keep: true, fresh: true });
  assert.equal(store.peek('k'), before, 'hasta el siguiente pintado sigue lo leído');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(fresh, [false, true]);
  const during = store.peek('k');
  assert.notEqual(during, before, 'otra lectura: la pantalla se vuelve a pintar');
  assert.deepEqual(during, { data: 'vieja', failure: null, loading: true });
  release();
  await settle();
  assert.equal(store.peek('k')?.data, 'nueva');
  stop();
});

test('la clave no depende del orden de los parámetros y omite los vacíos', () => {
  assert.equal(readKey('v', { b: '2', a: '1', c: undefined }), readKey('v', { a: '1', b: '2' }));
  assert.equal(readKey('v'), 'v?');
});

test('«Volver a leer» no vuelve a pedir una página que deja de verse con la nueva lectura («Cargar más»)', async () => {
  const store = createReadStore('x');
  const calls: string[] = [];
  const one = store.watch('proyectos?limite=50', async () => { calls.push('1'); return 'p1'; }, noop);
  const two = store.watch('proyectos?cursor=c2&limite=50', async () => { calls.push('2'); return 'p2'; }, noop);
  await settle();
  store.forget();
  two();  // the new reading starts at page one: the page of the cursor unmounts on the next paint
  await settle();
  assert.deepEqual(calls, ['1', '2', '1'], 'solo la primera página, que sigue en pantalla');
  assert.equal(store.has('proyectos?cursor=c2&limite=50'), false);
  one();
});

test('una lectura nueva antes del pintado no se pide dos veces', async () => {
  const store = createReadStore('x');
  let calls = 0;
  const fetcher = async () => { calls++; return 'd'; };
  const stop = store.watch('k', fetcher, noop);
  await settle();
  store.forget();
  store.watch('k', fetcher, noop)();  // something asked it again before the deferred step
  await settle();
  assert.equal(calls, 2);
  stop();
});
