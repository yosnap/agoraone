import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shadowLine } from './jev-shadow';

test('el recuento en sombra suma correo y WhatsApp y calcula la coincidencia sobre lo comparable', () => {
  assert.equal(shadowLine({ mail: { decisions: 30, compared: 20, agree: 17, advertisingAsOther: 2, withdrawn: 1 }, chat: { decisions: 10, compared: 10, agree: 8, advertisingAsOther: 0, withdrawn: 0 } }),
    'En sombra: 40 decisiones, coincidencia con lo actual 83 %');
  assert.equal(shadowLine({ mail: { decisions: 1, compared: 0, agree: 0, advertisingAsOther: 0, withdrawn: 0 } }), 'En sombra: 1 decisión, aún sin nada que comparar');
  assert.equal(shadowLine(undefined), 'En sombra: 0 decisiones, aún sin nada que comparar');
  assert.equal(shadowLine({ mail: { decisions: 1200, compared: 1000, agree: 1000, advertisingAsOther: 0, withdrawn: 0 } }), 'En sombra: 1200 decisiones, coincidencia con lo actual 100 %');
});
