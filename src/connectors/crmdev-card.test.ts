import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Connector } from '../api/core';
import { getCrmdevHours, getCrmdevView, isCrmdevProbe } from '../api/crmdev';
import { ConnectorCard } from './connector-card';
import { CrmdevTools } from './connector-extras';

const crmdev = (configured: Connector['state']['configured'] = { url: null, hasKey: false }): Connector => ({
  id: 'crmdev', name: 'CRMDev', description: 'CRM de proyectos, tareas, tickets y clientes de tu organización.', kind: 'web_api',
  modules: { crmdev: true }, views: ['crmdev'], window: 'crmdev', scopes: ['organizacion'], hint: 'https://crm.example.com',
  state: { status: configured.url && configured.hasKey ? 'saved' : 'not_configured', configured, notice: null, storeProblem: null },
});
const noop = () => {};

test('la tarjeta de CRMDev pide su dirección y una clave crm_ y tiene su interruptor', () => {
  const html = renderToStaticMarkup(createElement(ConnectorCard, { connector: crmdev(), modules: { crmdev: true }, labels: { crmdev: 'CRMDev' }, onSaved: noop, onOpen: noop }));
  assert.match(html, /Dirección de CRMDev/);
  assert.match(html, /placeholder="crm_…"/);
  assert.match(html, /placeholder="https:\/\/crm.example.com"/);
  assert.match(html, /API Keys/);
  assert.match(html, /nunca borra nada en CRMDev/);
  assert.match(html, /compartidas con cualquier otra app que use la misma clave/);
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /<select|border-l/);
});

test('tras «Probar» se ve «Conectado: organización» con lo que se usa, y lo raro como texto', () => {
  const tested = { version: null, scopes: ['organizacion'], tools: ['list_projects', '<img src=x onerror=alert(1)>'], unverified: ['list_tickets'] };
  assert.ok(isCrmdevProbe(tested));
  const html = renderToStaticMarkup(createElement(CrmdevTools, { connector: crmdev({ url: 'https://crm.example.com', hasKey: true }), tested, onOpen: noop }));
  assert.match(html, /Conectado: organización/);
  assert.match(html, /Proyectos/);
  assert.match(html, /Al abrirlos<\/span> Tickets/);
  assert.doesNotMatch(html, /Sí<\/span> Tickets/, 'los tickets no se dan por disponibles');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const none = renderToStaticMarkup(createElement(CrmdevTools, { connector: crmdev(), tested: { version: null, scopes: ['organizacion'], tools: [] }, onOpen: noop }));
  assert.match(none, /no ofrece ninguna/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(CrmdevTools, { connector: crmdev(), tested: { version: '1.0', scopes: [] }, onOpen: noop })), /Conectado/);
});

test('las vistas de CRMDev piden solo rutas del núcleo con sus filtros', async () => {
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return new Response(JSON.stringify({ items: [], limit: 100, more: false }), { status: 200 });
  }) as typeof fetch;
  try {
    await getCrmdevView('tareas', { estado: 'TODO', proyecto: 'p1' });
    await getCrmdevView('proyectos');
    await getCrmdevView('tickets', { estado: '', cliente: 'c 1' });
    await getCrmdevHours('a/b');
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(asked, ['/api/core/crmdev/views/tareas?estado=TODO&proyecto=p1', '/api/core/crmdev/views/proyectos',
    '/api/core/crmdev/views/tickets?cliente=c+1', '/api/core/crmdev/proyectos/a%2Fb/horas']);
});
