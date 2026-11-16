import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pieces, plainWords, settled } from './voice-pieces.ts';

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
