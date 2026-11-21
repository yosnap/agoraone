import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getCrmdevView, setCrmdevOrg, type CrmdevOrg } from '../api/crmdev';
import { createReadStore } from '../ui/read-store';
import { CrmdevOrgPicker, pickOrg } from './crmdev-org-picker';

const org = (id: string, name: string, hasKey = true): CrmdevOrg => ({ id, name, hasKey, clients: null, projects: null, fetchedAt: null });

test('se muestra la organización elegida si tiene clave; si no, la primera con clave', () => {
  const orgs = [org('o1', 'Primera'), org('o2', 'Segunda'), org('o3', 'Sin clave', false)];
  assert.equal(pickOrg(orgs, 'o2')?.id, 'o2');
  assert.equal(pickOrg(orgs, 'o3')?.id, 'o1');
  assert.equal(pickOrg(orgs, 'o9')?.id, 'o1');
  assert.equal(pickOrg([], 'o1'), undefined);
});

test('el selector solo aparece con varias organizaciones y dice cuáles no tienen clave', () => {
  const render = (orgs: CrmdevOrg[]) => renderToStaticMarkup(createElement(CrmdevOrgPicker, { orgs, org: orgs[0], onChange: () => undefined }));
  assert.equal(render([org('o1', 'Primera')]), '');
  assert.match(render([org('o1', 'Primera'), org('o2', 'Segunda')]), /Organización de CRMDev/);
  const keyless = render([org('o1', 'Primera'), org('o2', 'Segunda', false)]);
  assert.match(keyless, /Sin clave: «Segunda»/);
  assert.doesNotMatch(keyless, /Organización de CRMDev/);
});

test('las lecturas de la sección llevan la organización elegida', async () => {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ items: [], limit: 100, more: false, order: 'recientes', readAt: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    setCrmdevOrg('o2');
    await getCrmdevView('tareas', { proyecto: 'p1' }, true);
  } finally {
    setCrmdevOrg(null);
    globalThis.fetch = original;
  }
  assert.deepEqual(seen, ['/api/core/crmdev/views/tareas?proyecto=p1&org=o2&fresco=1']);
});

test('al cambiar de organización, una respuesta que llega tarde de la anterior no se muestra', async () => {
  const store = createReadStore('x');
  let answer: (value: string) => void = () => undefined;
  void store.ensure('clientes?', () => new Promise<string>(resolve => { answer = resolve; }));
  store.start(['orgs']);
  answer('de la otra organización');
  await new Promise(resolve => setTimeout(resolve, 0));
  let asked = 0;
  await store.ensure('clientes?', async () => { asked++; return 'de esta'; });
  assert.equal(asked, 1);
});
