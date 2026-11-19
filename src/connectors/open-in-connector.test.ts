import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../api/client';
import { windowExternalLink } from '../api/connector-window';
import { TicketsTable } from '../crmdev/crmdev-tickets';
import { setModule, windowChecks } from '../shell/modules';
import { crmdevNotice, OpenInConnector, openPage } from './open-in-connector';

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

test('apagar el módulo CRMDev hace que la app mire si su ventana puede seguir abierta', async () => {
  assert.deepEqual(Object.keys(windowChecks).sort(), ['central', 'crmdev', 'fabrica']);
  const sent = await capture(path => ({ status: 200, body: path.endsWith('/modules') ? { modules: { crmdev: false }, labels: {} } : { done: true } }),
    async () => { await setModule('crmdev', false); await new Promise(resolve => setTimeout(resolve, 5)); });
  assert.deepEqual(sent.map(s => s.path), ['/api/core/modules', '/api/core/crmdev/window/check']);
  const quotes = await capture(path => ({ status: 200, body: path.endsWith('/modules') ? { modules: { presupuestos: false }, labels: {} } : { done: true } }),
    async () => { await setModule('presupuestos', false); await new Promise(resolve => setTimeout(resolve, 5)); });
  assert.deepEqual(quotes.map(s => s.path), ['/api/core/modules', '/api/core/central/window/check'], 'Presupuestos sigue cerrando la de Central');
});

test('sin selects nativos ni bordes de acento en el botón común', () => {
  const source = readFileSync(new URL('./open-in-connector.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /<select|border-l|border-left|innerHTML/);
});
