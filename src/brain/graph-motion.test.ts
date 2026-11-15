import test from 'node:test';
import assert from 'node:assert/strict';
import { gather } from './graph-motion';

const base = new Float32Array([0, 0, 0, 10, 0, 0, -10, 0, 0, 0, 10, 0, 0, -10, 0, 0, 0, 10]);
const distance = (array: Float32Array, node: number, to: number[]) => Math.hypot(array[node * 3] - to[0], array[node * 3 + 1] - to[1], array[node * 3 + 2] - to[2]);

test('sin nada encendido, cada esfera se queda donde estaba', () => {
  const motion = gather(base, [], []);
  assert.equal(motion.target, base);
  assert.deepEqual(motion.synapses, []);
});

test('la mejor coincidencia va al centro, las demás alrededor y el resto se aparta', () => {
  const motion = gather(base, [1, 3, 5], [[1, 3], [2, 4]]);
  assert.ok(distance(motion.target, 1, motion.focus) < 1e-6, 'la primera, en el foco');
  for (const node of [3, 5]) assert.ok(distance(motion.target, node, motion.focus) <= motion.reach + 1e-6, 'las encontradas, dentro de la constelación');
  for (const node of [0, 2, 4]) assert.ok(distance(motion.target, node, motion.focus) > motion.reach, 'las demás, fuera de ella');
  // Real links between found notes, plus each found note joined to the best one; links outside are ignored.
  assert.deepEqual(motion.synapses, [[1, 3], [1, 5]]);
});
