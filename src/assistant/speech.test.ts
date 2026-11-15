import assert from 'node:assert/strict';
import { test } from 'node:test';
import { speakable } from './speech.ts';

test('se dice el texto sin formato ni citas', () => {
  assert.equal(speakable('Falta **enviar** el presupuesto [Reunión 12/11] y ver [[Acme|la nota]].'), 'Falta enviar el presupuesto y ver la nota.');
  const long = 'Una frase corta. '.repeat(80);
  assert.ok(speakable(long).length <= 700 && speakable(long).endsWith('.'));
});
