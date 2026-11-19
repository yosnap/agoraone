import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../api/client';
import { windowExternalLink } from '../api/connector-window';
import { TicketsTable } from '../crmdev/crmdev-tickets';
import { closeConnectorWindows, setModule } from '../shell/modules';
import { crmdevDownloadNotice, crmdevNotice, OpenInConnector, openPage, refusedDownload } from './open-in-connector';

type Sent = { path: string; body: unknown };
/** Every call to the core answered with `answer`, and what was sent. */
async function capture(answer: (path: string) => { status: number; body: unknown }, run: () => Promise<unknown>): Promise<Sent[]> {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    sent.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const { status, body } = answer(path);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
  return sent;
}

test('«Abrir en CRMDev» manda la ruta de la página a la ventana de CRMDev', async () => {
  let said: Awaited<ReturnType<typeof openPage>> | null = null;
  const sent = await capture(() => ({ status: 200, body: { seq: 1 } }), async () => { said = await openPage('crmdev', 'proyectos/p1', false); });
  assert.deepEqual(sent, [{ path: '/api/core/crmdev/window', body: { ruta: 'proyectos/p1' } }]);
  assert.equal(said!.ok, true);
  assert.match(said!.text, /ventana de CRMDev/);
});

test('sin la app de escritorio se ofrece abrir en el navegador, y el navegador abre la misma página', async () => {
  const failing = { window: async () => { throw new ApiError('La ventana de CRMDev solo existe en la app de escritorio.', 409, { status: 'no_window' }); },
    browser: async () => ({ done: true as const }) };
  const said = await openPage('crmdev', 'tickets/k1', false, failing);
  assert.equal(said.ok, false);
  assert.equal(said.browser, true, 'se ofrece «Abrir en el navegador»');
  const sent = await capture(() => ({ status: 200, body: { done: true } }), () => openPage('crmdev', 'tickets/k1', true));
  assert.deepEqual(sent, [{ path: '/api/core/crmdev/window/browser', body: { ruta: 'tickets/k1' } }]);
  const other = await openPage('crmdev', 'panel', false, { ...failing, window: async () => { throw new ApiError('Apagado', 404, { status: 'off' }); } });
  assert.equal(other.browser, false, 'otro error no ofrece el navegador');
});

test('Central sigue usando sus rutas de siempre a través del botón común', async () => {
  const sent = await capture(() => ({ status: 200, body: { seq: 1 } }), () => openPage('central', 'clientes/c1', false));
  assert.deepEqual(sent, [{ path: '/api/core/central/window', body: { ruta: 'clientes/c1' } }]);
});

test('el botón no se pinta en modo discreto y lleva el nombre del conector', () => {
  assert.equal(renderToStaticMarkup(createElement(OpenInConnector, { connector: 'crmdev', page: 'panel', discreet: true })), '');
  const html = renderToStaticMarkup(createElement(OpenInConnector, { connector: 'crmdev', page: 'panel' }));
  assert.match(html, /Abrir en CRMDev/);
  assert.doesNotMatch(html, /Abrir en el navegador/, 'el navegador solo se ofrece si hace falta');
  const ticket = { id: 'k1', title: 'T', description: null, status: 'OPEN', priority: 'LOW', category: 'BUG', requester: null, client: null, project: null,
    createdAt: null, updatedAt: null };
  assert.match(renderToStaticMarkup(createElement(TicketsTable, { tickets: [ticket], discreet: false })), /Abrir en CRMDev/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(TicketsTable, { tickets: [ticket], discreet: true })), /Abrir en CRMDev/);
});

test('un enlace de CRMDev a otro sitio se ofrece en el navegador, y entrar con GitHub abre CRMDev en el navegador', async () => {
  const calls: string[] = [];
  const deps = { link: async (label: string, url: string) => { calls.push(`link ${label} ${url}`); return { done: true as const }; },
    browser: async (label: string, page: string) => { calls.push(`browser ${label} ${page}`); return { done: true as const }; } };
  const plain = crmdevNotice(windowExternalLink({ url: 'https://example.com/docs' })!, deps);
  assert.equal(plain.url, 'https://example.com/docs');
  await plain.onAction();
  const github = crmdevNotice(windowExternalLink({ url: 'https://github.com/login/oauth/authorize?client_id=x&redirect_uri=y' })!, deps);
  assert.equal(github.url, undefined, 'la dirección de la vuelta no se enseña');
  await github.onAction();
  assert.deepEqual(calls, ['link crmdev https://example.com/docs', 'browser crmdev panel']);
  assert.match(crmdevNotice(windowExternalLink({ url: 'http://example.com/' })!, deps).action, /igualmente/);
});

/** The modules as a core answers them, with each module's window label (`Connector.window`). */
const modulesAnswer = (modules: Record<string, boolean>, windows?: Record<string, string>) => (path: string) =>
  ({ status: 200, body: path.endsWith('/modules') ? { modules, labels: {}, ...(windows ? { windows } : {}) } : { done: true } });
const later = () => new Promise(resolve => setTimeout(resolve, 5));

test('apagar un módulo mira la ventana que el núcleo dice para él (Connector.window), aunque no se llame como el conector', async () => {
  const windows = { crmdev: 'crmdev', presupuestos: 'central', seo: 'seo-web' };
  const crmdev = await capture(modulesAnswer({ crmdev: false }, windows), async () => { await setModule('crmdev', false); await later(); });
  assert.deepEqual(crmdev.map(s => s.path), ['/api/core/modules', '/api/core/crmdev/window/check']);
  const quotes = await capture(modulesAnswer({ presupuestos: false }, windows), async () => { await setModule('presupuestos', false); await later(); });
  assert.deepEqual(quotes.map(s => s.path), ['/api/core/modules', '/api/core/central/window/check'], 'Presupuestos sigue cerrando la de Central');
  const other = await capture(modulesAnswer({ seo: false } as Record<string, boolean>, windows),
    async () => { await setModule('seo' as never, false); await later(); });
  assert.deepEqual(other.map(s => s.path), ['/api/core/modules', '/api/core/seo-web/window/check'], 'la etiqueta de la ventana, no el id');
  const old = await capture(modulesAnswer({ crmdev: false }), async () => { await setModule('crmdev', false); await later(); });
  assert.deepEqual(old.map(s => s.path), ['/api/core/modules'], 'un núcleo que no dice la ventana no inventa ninguna');
});

test('activar el modo discreto cierra la ventana de CRMDev con las de los demás conectores', async () => {
  await capture(modulesAnswer({ crmdev: true }, { central: 'central', presupuestos: 'central', crmdev: 'crmdev', fabrica: 'fabrica' }),
    async () => { await setModule('crmdev', true); });
  const closed: string[] = [];
  await closeConnectorWindows(async label => { closed.push(label); });
  assert.deepEqual(closed.sort(), ['central', 'crmdev', 'fabrica']);
  const sent = await capture(() => ({ status: 200, body: { done: true } }), () => closeConnectorWindows());
  assert.ok(sent.some(s => s.path === '/api/core/crmdev/window/close'));
});

test('en un ticket o en Soporte se avisa de que, tras entrar, CRMDev puede llevar a su panel', async () => {
  const ok = { window: async () => ({ seq: 1 }), browser: async () => ({ done: true as const }) };
  assert.match((await openPage('crmdev', 'tickets/k1', false, ok)).text, /vuelve a pulsar/);
  assert.match((await openPage('crmdev', 'soporte', false, ok)).text, /vuelve a pulsar/);
  assert.doesNotMatch((await openPage('crmdev', 'proyectos/p1', false, ok)).text, /vuelve a pulsar/);
  assert.doesNotMatch((await openPage('central', 'ajustes', false, ok)).text, /vuelve a pulsar/);
});

test('una descarga en la ventana de CRMDev se ofrece en el navegador: la misma página, o el panel si no se sabe', async () => {
  const calls: string[] = [];
  const deps = { link: async (label: string, url: string) => { calls.push(`link ${label} ${url}`); return { done: true as const }; },
    browser: async (label: string, page: string) => { calls.push(`browser ${label} ${page}`); return { done: true as const }; } };
  const page = refusedDownload({ url: 'https://crm.example.com/es/soporte' })!;
  assert.equal(crmdevDownloadNotice(page, deps).url, 'https://crm.example.com/es/soporte');
  await crmdevDownloadNotice(page, deps).onAction();
  await crmdevDownloadNotice(refusedDownload({ url: null })!, deps).onAction();
  assert.deepEqual(refusedDownload({ url: 'blob:https://crm.example.com/1' }), { url: null }, 'un blob no se puede abrir: el panel');
  assert.equal(refusedDownload(null), null);
  assert.deepEqual(calls, ['link crmdev https://crm.example.com/es/soporte', 'browser crmdev panel']);
});
