import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CentralWebsiteRow } from '../api/central';
import { filterWebsites } from './central-websites';

const web = (id: string, client: string | null, status: string | null, code: number | null, url = `https://${id}.es`): CentralWebsiteRow =>
  ({ id, url, kind: 'CLIENT', client, status, code, ms: 120, checkedAt: null });
const webs = [web('a', 'Acme', 'up', 200), web('b', 'Acme', 'down', null), web('c', 'Beta', 'up', 503), web('d', null, null, null, 'https://tienda.beta.com')];
const ids = (list: CentralWebsiteRow[]) => list.map(w => w.id);
const none = { client: '', status: 'all' as const, text: '' };

test('sin filtros quedan todas las webs, en el orden de Central', () => {
  assert.deepEqual(ids(filterWebsites(webs, none)), ['a', 'b', 'c', 'd']);
});

test('el filtro de cliente deja solo las de ese cliente', () => {
  assert.deepEqual(ids(filterWebsites(webs, { ...none, client: 'Acme' })), ['a', 'b']);
});

test('estado: en línea, caídas y con avisos (caída, sin datos o código de error)', () => {
  assert.deepEqual(ids(filterWebsites(webs, { ...none, status: 'up' })), ['a', 'c']);
  assert.deepEqual(ids(filterWebsites(webs, { ...none, status: 'down' })), ['b']);
  assert.deepEqual(ids(filterWebsites(webs, { ...none, status: 'alert' })), ['b', 'c', 'd']);
});

test('la búsqueda mira dirección y cliente, sin mayúsculas, con todas las palabras', () => {
  assert.deepEqual(ids(filterWebsites(webs, { ...none, text: 'BETA' })), ['c', 'd']);
  assert.deepEqual(ids(filterWebsites(webs, { ...none, text: 'tienda beta' })), ['d']);
  assert.deepEqual(ids(filterWebsites(webs, { ...none, text: 'acme', status: 'down' })), ['b']);
});
