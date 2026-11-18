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

test('para tras hablar y quedarse callado un momento', () => {
  const said = [...Array(4).fill(0.01), ...Array(20).fill(0.2), ...Array(20).fill(0.01)];
  const { stop, at } = run(said);
  assert.equal(stop, 'done');
  assert.ok(at >= 2400 + 1300 && at <= 2400 + 1500, `paró a los ${at} ms`);
});

test('una pausa corta entre palabras no corta el mensaje', () => {
  const said = [...Array(4).fill(0.01), ...Array(10).fill(0.2), ...Array(8).fill(0.01), ...Array(10).fill(0.2)];
  assert.equal(run(said).stop, null);
});

test('si no se dice nada, se rinde a los ocho segundos', () => {
  const { stop, at } = run(Array(100).fill(0.01));
  assert.equal(stop, 'nothing');
  assert.equal(at, 8000);
});

test('en una sala ruidosa la voz tiene que destacar sobre el ruido', () => {
  const noisy = [...Array(4).fill(0.08), ...Array(30).fill(0.1)];
  assert.equal(run(noisy).stop, null, 'el ruido de fondo no cuenta como voz ni como silencio tras hablar');
  assert.equal(run([...Array(4).fill(0.08), ...Array(10).fill(0.4), ...Array(14).fill(0.08)]).stop, 'done');
});
