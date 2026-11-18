import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Addon, AddonStatus } from '../api/core';
import { fabricaDownload, fabricaExternalLink } from '../api/fabrica';
import { menu, sectionModule } from '../shell/shell-state';
import { PANEL_PAGES, canStart, fabricaState, freshFabrica, readFabrica, stateLabels, stateText, waitUntilRunning } from './fabrica-state';

const addon = (status: AddonStatus): Addon => ({ id: 'fabrica', name: 'Mi fábrica', description: '', offers: [], status, configured: { path: '/x', port: 8742 } });

test('«Mi fábrica» va en el menú justo antes de Presupuestos y sigue a su módulo', () => {
  const ids = menu.map(item => item.id);
  assert.equal(ids[ids.indexOf('quotes') - 1], 'fabrica');
  assert.equal(menu.find(item => item.id === 'fabrica')?.label, 'Mi fábrica');
  assert.equal(menu.at(-1)?.id, 'central', 'Central sigue la última');
  assert.equal(sectionModule.fabrica, 'fabrica');
});

test('cada estado de la fábrica dice cuál es el caso y solo parada en macOS se ofrece arrancarla', () => {
  assert.equal(fabricaState('responding'), 'running');
  assert.equal(fabricaState('detected'), 'stopped');
  assert.equal(fabricaState('not_configured'), 'missing');
  assert.equal(fabricaState('not_found'), 'wrong');
  assert.equal(fabricaState('unreadable'), 'unreadable');
  assert.equal(stateLabels.running, 'En marcha');
  assert.equal(stateLabels.stopped, 'Parada');
  assert.match(stateText('stopped', true), /servicio de macOS.*fabrica servicio instalar/);
  assert.doesNotMatch(stateText('stopped', false), /macOS|servicio instalar/, 'fuera de macOS solo hay «fabrica servir»');
  assert.match(stateText('stopped', false), /fabrica servir/);
  assert.match(stateText('running', true), /ventana/);
  assert.doesNotMatch(stateText('running', true, true), /se abre en una ventana/, 'en modo discreto no promete abrir nada');
  assert.match(stateText('missing', true), /Conectores/);
  assert.match(stateText('wrong', true), /no es la de tu fábrica/);
  assert.equal(canStart('stopped', true), true);
  assert.equal(canStart('stopped', false), false, 'fuera de macOS no hay servicio que arrancar');
  for (const state of ['running', 'missing', 'wrong', 'unreadable'] as const) assert.equal(canStart(state, true), false, state);
});

test('una entrada por pantalla del panel, en su orden y con lo que se hace allí', () => {
  assert.deepEqual(PANEL_PAGES.map(p => p.page), ['', 'corridas', 'publicaciones', 'competidores', 'piezas', 'ideas', 'senales', 'ajustes']);
  assert.match(PANEL_PAGES[1].what, /aprobar.*rechazar/);
  assert.ok(PANEL_PAGES.every(p => p.label && p.what));
});

test('los avisos de la ventana solo aceptan direcciones web y nombres sin ruta', () => {
  assert.deepEqual(fabricaExternalLink({ url: 'https://www.youtube.com/watch?v=x' }), { url: 'https://www.youtube.com/watch?v=x', kind: 'https' });
  assert.equal(fabricaExternalLink({ url: 'http://example.com/' })?.kind, 'http');
  for (const wrong of [{ url: 'javascript:alert(1)' }, { url: 'file:///etc/passwd' }, { url: 'x'.repeat(2001) }, { url: 3 }, null, 'https://a.b']) {
    assert.equal(fabricaExternalLink(wrong), null, JSON.stringify(wrong));
  }
  assert.deepEqual(fabricaDownload({ name: 'guia (2).pdf', ok: true }), { name: 'guia (2).pdf', ok: true });
  assert.deepEqual(fabricaDownload({ name: '', ok: true }), { name: 'fabrica.pdf', ok: true }, 'sin nombre, el de reserva de la app');
  for (const wrong of [{ name: '/Users/x/Downloads/guia.pdf', ok: true }, { name: 'a\\b.pdf', ok: true }, { name: 'guia.pdf' }, { ok: true }, null]) {
    assert.equal(fabricaDownload(wrong), null, JSON.stringify(wrong));
  }
});

test('el estado se lee una vez por visita y «Volver a comprobar» lo lee de nuevo', async () => {
  let asked = 0;
  const fetcher = async () => { asked++; return { addons: [addon('detected')] }; };
  freshFabrica();
  await readFabrica(false, fetcher);
  await readFabrica(false, fetcher);
  assert.equal(asked, 1);
  const again = await readFabrica(true, fetcher);
  assert.equal(asked, 2);
  assert.equal(again.addon?.status, 'detected');
  freshFabrica();
  const failed = await readFabrica(false, async () => { throw new Error('sin núcleo'); });
  assert.equal(failed.failure, 'sin núcleo');
  freshFabrica();
});

test('tras «Arrancar» se comprueba unas pocas veces y dice si respondió', async () => {
  const answers: AddonStatus[] = ['detected', 'detected', 'responding'];
  let asked = 0;
  assert.equal(await waitUntilRunning(5, 1, async () => ({ addons: [addon(answers[Math.min(asked++, 2)])] })), true);
  assert.equal(asked, 3, 'para en cuanto responde');
  let tries = 0;
  assert.equal(await waitUntilRunning(3, 1, async () => { tries++; return { addons: [addon('detected')] }; }), false);
  assert.equal(tries, 3, 'un número acotado de comprobaciones');
  freshFabrica();
});
