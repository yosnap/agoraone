import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CentralWebsiteRow } from '../api/central';
import { filterWebsites } from './central-websites';

const web = (id: string, client: string | null, status: string | null, code: number | null, url = `https://${id}.es`): CentralWebsiteRow =>
  ({ id, url, kind: 'CLIENT', client, status, code, ms: 120, checkedAt: null });
const webs = [web('a', 'Acme', 'up', 200), web('b', 'Acme', 'down', null), web('c', 'Beta', 'up', 503), web('d', null, null, null, 'https://tienda.beta.com')];
const ids = (list: CentralWebsiteRow[]) => list.map(w => w.id);
const none = { client: '', status: 'all' as const, code: 'all' as const, text: '' };

test('sin filtros quedan todas las webs, en el orden de Central', () => {
  assert.deepEqual(ids(filterWebsites(webs, none)), ['a', 'b', 'c', 'd']);
});

test('el filtro de cliente deja solo las de ese cliente', () => {
  assert.deepEqual(ids(filterWebsites(webs, { ...none, client: 'Acme' })), ['a', 'b']);
});

test('estado: en línea, caídas y sin datos', () => {
  assert.deepEqual(ids(filterWebsites(webs, { ...none, status: 'up' })), ['a', 'c']);
  assert.deepEqual(ids(filterWebsites(webs, { ...none, status: 'down' })), ['b']);
  assert.deepEqual(ids(filterWebsites(webs, { ...none, status: 'none' })), ['d']);
});

test('código HTTP por familias (2xx, 5xx) y sin código', () => {
  assert.deepEqual(ids(filterWebsites(webs, { ...none, code: '2' })), ['a']);
  assert.deepEqual(ids(filterWebsites(webs, { ...none, code: '5' })), ['c']);
  assert.deepEqual(ids(filterWebsites(webs, { ...none, code: 'none' })), ['b', 'd']);
  assert.deepEqual(ids(filterWebsites(webs, { ...none, code: '4' })), []);
});

test('la búsqueda mira dirección y cliente, sin mayúsculas, con todas las palabras', () => {
  assert.deepEqual(ids(filterWebsites(webs, { ...none, text: 'BETA' })), ['c', 'd']);
  assert.deepEqual(ids(filterWebsites(webs, { ...none, text: 'tienda beta' })), ['d']);
  assert.deepEqual(ids(filterWebsites(webs, { ...none, text: 'acme', status: 'down' })), ['b']);
});
