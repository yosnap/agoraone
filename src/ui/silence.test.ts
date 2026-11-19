import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hear, silence, type Silence } from './silence.ts';

const run = (levels: number[], step = 100) => {
  let s: Silence = silence(0);
  for (let i = 0; i < levels.length; i++) {
    const { next, stop } = hear(s, levels[i], (i + 1) * step);
    s = next;
    if (stop) return { stop, at: (i + 1) * step };
  }
  return { stop: null, at: levels.length * step };
};
const quiet = (n: number) => Array(n).fill(0.01);
const loud = (n: number) => Array(n).fill(0.2);

test('para tras hablar y quedarse callado un momento', () => {
  const { stop, at } = run([...quiet(8), ...loud(20), ...quiet(25)]);
  assert.equal(stop, 'done');
  assert.ok(at >= 2800 + 1800 && at <= 2800 + 2000, `paró a los ${at} ms`);
});

test('el final de «Oye Watson» y una pausa para pensar no cortan antes de hablar', () => {
  // the call's tail at the start, then the user waits a second and a half before speaking, with pauses
  assert.equal(run([...loud(4), ...quiet(4), ...quiet(15), ...loud(10), ...quiet(12), ...loud(10)]).stop, null);
});

test('un golpe o un clic no cuentan como hablar', () => {
  const { stop } = run([...quiet(8), ...loud(2), ...quiet(30)]);
  assert.equal(stop, null, 'sigue esperando a que hable');
});

test('si no se dice nada, se rinde a los diez segundos', () => {
  const { stop, at } = run(quiet(150));
  assert.equal(stop, 'nothing');
  assert.equal(at, 10000);
});

test('en una sala ruidosa la voz tiene que destacar sobre el ruido', () => {
  assert.equal(run([...Array(8).fill(0.08), ...Array(30).fill(0.1)]).stop, null);
  assert.equal(run([...Array(8).fill(0.08), ...Array(10).fill(0.4), ...Array(20).fill(0.08)]).stop, 'done');
});
