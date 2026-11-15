import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cost, count, duration, tokens } from './work-format';

test('durations read naturally', () => {
  assert.equal(duration(null), '—');
  assert.equal(duration(45), '45 s');
  assert.equal(duration(90), '2 min');
  assert.equal(duration(3600), '1 h');
  assert.equal(duration(4800), '1 h 20 min');
  assert.equal(duration(3 * 86400 + 3600), '3 d 1 h');
});

test('token counts and costs', () => {
  assert.equal(count(850), '850');
  assert.equal(count(12_400), '12,4 mil');
  assert.equal(count(3_100_000), '3,1 M');
  assert.equal(cost(null), null);
  assert.equal(cost(0.004), '< 0,01 $');
  assert.equal(cost(1.5), '1,50 $');
  assert.equal(tokens(null), 'sin medir');
  assert.equal(tokens({ input: 1000, output: 200, costUsd: 0.05 }), '1,2 mil tokens · 0,05 $');
  assert.equal(tokens({ input: 10, output: 5, costUsd: null }), '15 tokens');
});
