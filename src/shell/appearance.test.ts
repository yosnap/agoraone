import test from 'node:test';
import assert from 'node:assert/strict';
import { shade } from './appearance';

test('las paletas cambian los verdes de la marca y respetan rojos, ámbar y grises', () => {
  assert.equal(shade('#173d3c', 'natural'), '#173d3c');
  assert.notEqual(shade('#173d3c', 'oceano'), '#173d3c');
  assert.equal(shade('#8e3d2a', 'oceano'), '#8e3d2a', 'el rojo de los errores no cambia');
  assert.equal(shade('#7a5717', 'ciruela'), '#7a5717', 'el ámbar de los avisos no cambia');
  assert.equal(shade('#ffffff', 'grafito'), '#ffffff');
  assert.equal(shade('#173d3c22', 'oceano').slice(-2), '22', 'la transparencia se conserva');
  const grey = shade('#244e42', 'grafito');
  const [r, g, b] = [1, 3, 5].map(i => parseInt(grey.slice(i, i + 2), 16));
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 12, 'grafito casi sin color');
});
