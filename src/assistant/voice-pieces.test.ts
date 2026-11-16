import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advance, fresh, MAX_SPOKEN, pieces, plainWords, settled } from './voice-pieces.ts';

test('palabras limpias, sin citas, enlaces ni código', () => {
  assert.equal(plainWords('Mira **esto** [2] y [la web](https://x.es).\n```js\ncode\n```'), 'Mira esto y la web.');
  assert.equal(plainWords('Hola. ```sin cerrar'), 'Hola.');
});

test('solo se dice lo que ya es frase entera', () => {
  const plain = 'Tienes dos reuniones. La primera es a las on';
  assert.equal(plain.slice(0, settled(plain, false)), 'Tienes dos reuniones. ');
  assert.equal(settled(plain, true), plain.length);
});

test('la primera frase va sola para que empiece pronto', () => {
  assert.deepEqual(pieces('Hola. Tienes dos reuniones. Y tres correos.', true), ['Hola.', 'Tienes dos reuniones. Y tres correos.']);
  assert.deepEqual(pieces('Uno. Dos.', false), ['Uno. Dos.']);
});

const said = (deltas: string[], final: string) => {
  let progress = fresh(); const out: string[] = []; let text = '';
  for (const delta of deltas) { text += delta; const step = advance(progress, text, false); progress = step.next; out.push(...step.add); }
  const end = advance(progress, final, true); out.push(...end.add);
  return out.join(' ');
};

test('mientras llega, se dice todo una vez y entero, también con citas a medio llegar', () => {
  const deltas = ['Según [Proyecto: Ac', 'me]: la reunión es el lunes. ', 'Lleva el contrato.'];
  assert.equal(said(deltas, deltas.join('')), 'Según : la reunión es el lunes. Lleva el contrato.');
  assert.equal(said(['Hola. Tienes dos ', 'reuniones. Y nada más.'], 'Hola. Tienes dos reuniones. Y nada más.'), 'Hola. Tienes dos reuniones. Y nada más.');
});

test('una respuesta larga sin puntos también se dice, hasta el límite', () => {
  const list = Array.from({ length: 120 }, (_, n) => `- tarea ${n}`).join('\n');
  const spoken = said([list.slice(0, 400), list.slice(400)], list);
  assert.ok(spoken.length > 300 && spoken.length <= MAX_SPOKEN, `dice ${spoken.length} caracteres`);
  assert.ok(pieces(spoken, false).every(piece => piece.length <= 330), 'ningún trozo se recorta luego en el núcleo');
});
