import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientHue } from './client-hue';

test('cada cliente de Central tiene su tono y los vecinos no se parecen', () => {
  const known = Array.from({ length: 20 }, (_, n) => `Cliente ${String(n).padStart(2, '0')}`);
  const hues = known.map(name => clientHue(name, known));
  assert.equal(new Set(hues).size, known.length);
  hues.slice(1).forEach((hue, n) => { const gap = Math.abs(hue - hues[n]); assert.ok(Math.min(gap, 360 - gap) > 60, `${known[n]} y el siguiente`); });
});

test('un cliente fuera de Central conserva siempre el mismo tono', () => {
  assert.equal(clientHue('Antiguo', ['Otro']), clientHue('  antiguo '));
  assert.ok(clientHue('Antiguo') >= 0 && clientHue('Antiguo') < 360);
});
