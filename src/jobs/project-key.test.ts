import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectKey } from './project-key';

test('a project and a folder match only by the same name, accents, case and punctuation aside', () => {
  assert.equal(projectKey('Café-Web'), projectKey('cafe_web'));
  assert.equal(projectKey('Tienda Online'), 'tiendaonline');
  assert.notEqual(projectKey('Tienda'), projectKey('Tienda Online'));
  assert.equal(projectKey(null), '');
});
