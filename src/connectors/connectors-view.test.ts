import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Connector, ModuleName } from '../api/core';
import { menu, sectionModule } from '../shell/shell-state';
import { ConnectorCard, ForgetAction, switchModule } from './connector-card';
import { canSave, changesFor, hasSaved, initialFields, typedFor } from './connector-forms';
import { ConnectorsPage } from './connectors-view';
import { connectorFromLink } from './open-connector';
import { ModulesList, connectorModules, joinNames } from '../settings/settings-modules';
import { movedTabs, resolveTab } from '../settings/settings-view';

const MOVED = 'Ahora Central se conecta con su dirección y una clave de acceso: créala en Ajustes › Apps conectadas de Central.';
const base = { views: [], window: null, scopes: [], hint: null };
const central = (configured: Connector['state']['configured'] = { url: null, hasKey: false }, status: Connector['state']['status'] = 'not_configured',
  notice: string | null = null): Connector => ({
  ...base, id: 'central', name: 'Central', description: 'Clientes y presupuestos de Central.', kind: 'web_api', window: 'central',
  modules: { central: true, presupuestos: false }, hint: 'https://central.example.com', scopes: ['lectura'], state: { status, configured, notice, storeProblem: null },
});
const fabrica: Connector = { ...base, id: 'fabrica', name: 'Mi fábrica', description: 'Fábrica de contenido.', kind: 'local_port', modules: { fabrica: true },
  state: { status: 'not_configured', configured: { path: null, port: 8742 }, notice: null, storeProblem: null } };
const costguard: Connector = { ...base, id: 'costguard', name: 'CostGuard', description: 'Gasto de tokens.', kind: 'local_file', modules: {},
  state: { status: 'not_configured', configured: { dataPath: null }, notice: null, storeProblem: null } };
const guide: Connector = { ...base, id: 'cerebro-mcp', name: 'MCP del cerebro', description: 'Herramientas del cerebro.', kind: 'guide', modules: {},
  state: { status: 'guide', configured: {}, notice: null, storeProblem: null } };
const all = [central(), fabrica, costguard, guide];
const labels: Partial<Record<ModuleName, string>> = { central: 'Central', presupuestos: 'Presupuestos', fabrica: 'Mi fábrica', correo: 'Correo y Bandeja' };
const noop = () => {};
const page = (found: Connector[]) => renderToStaticMarkup(createElement(ConnectorsPage,
  { found, error: '', focused: null, modules: {}, labels, onReload: noop, onSaved: noop, onOpen: noop }));
const card = (connector: Connector, modules: Partial<Record<ModuleName, boolean>> = {}) =>
  renderToStaticMarkup(createElement(ConnectorCard, { connector, modules, labels, onSaved: noop, onOpen: noop }));
const cardOf = (html: string, id: string) => html.slice(html.indexOf(`data-connector="${id}"`), html.indexOf('</article>', html.indexOf(`data-connector="${id}"`)));

test('una tarjeta por conector, con el formulario de su tipo', () => {
  const html = page(all);
  assert.equal(html.match(/data-connector="/g)?.length, all.length);
  const web = cardOf(html, 'central');
  assert.match(web, /Dirección de Central/);
  assert.match(web, /type="password"/);
  assert.match(web, /Cómo se conecta/);
  assert.match(cardOf(html, 'fabrica'), /Puerto/);
  assert.match(cardOf(html, 'fabrica'), /Carpeta del proyecto/);
  assert.match(cardOf(html, 'costguard'), /Archivo de datos/);
  const manual = cardOf(html, 'cerebro-mcp');
  assert.doesNotMatch(manual, /<form|Guardar|Probar|Olvidar/, 'una guía no tiene nada que guardar');
  for (const id of ['central', 'fabrica', 'costguard']) assert.match(cardOf(html, id), /Probar[\s\S]*Guardar/, id);
});

test('ningún desplegable nativo ni borde de acento a la izquierda', () => {
  assert.doesNotMatch(page(all), /<select|border-l/);
  const dir = new URL('.', import.meta.url);
  for (const name of readdirSync(dir).filter(file => /\.(tsx|css)$/.test(file))) {
    const source = readFileSync(new URL(name, dir), 'utf8');
    assert.doesNotMatch(source, /<select|border-l\b|border-left/, name);
  }
});

test('después de guardar no queda ninguna clave en la pantalla', () => {
  const key = 'cen_secreta_1234567890';
  const typed = { ...initialFields(central()), url: 'https://central.example.com', key };
  assert.deepEqual(changesFor('web_api', typed), { url: 'https://central.example.com', key });
  const after = central({ url: 'https://central.example.com', hasKey: true }, 'saved');
  assert.equal(initialFields(after).key, '', 'el campo de la clave vuelve vacío');
  assert.deepEqual(changesFor('web_api', initialFields(after)), { url: 'https://central.example.com' }, 'vacía, se conserva la guardada');
  const html = card(after);
  assert.doesNotMatch(html, /cen_secreta/);
  assert.match(html, /type="password"[^>]*value=""/);
  assert.match(html, /Hay una clave guardada/);
  assert.equal(canSave(after, initialFields(after)), true, 'con una clave guardada basta la dirección');
  assert.equal(canSave(central(), { ...initialFields(central()), url: 'https://central.example.com' }), false, 'sin clave no se guarda');
  assert.deepEqual(typedFor('web_api', initialFields(after)), { url: 'https://central.example.com' });
});

test('«Olvidar» pide confirmación y solo aparece si hay algo guardado', () => {
  const ask = renderToStaticMarkup(createElement(ForgetAction, { confirming: false, busy: false, text: 'Se borra la clave.', onAsk: noop, onConfirm: noop, onCancel: noop }));
  assert.match(ask, /Olvidar…/);
  assert.doesNotMatch(ask, /Olvidar de verdad/);
  const confirm = renderToStaticMarkup(createElement(ForgetAction, { confirming: true, busy: false, text: 'Se borra la clave.', onAsk: noop, onConfirm: noop, onCancel: noop }));
  assert.match(confirm, /Se borra la clave\.[\s\S]*Olvidar de verdad[\s\S]*Cancelar/);
  assert.doesNotMatch(card(central()), /Olvidar/);
  assert.match(card(central({ url: 'https://central.example.com', hasKey: true }, 'saved')), /Olvidar…/);
  assert.equal(hasSaved(fabrica), false);
  assert.equal(hasSaved({ ...fabrica, state: { ...fabrica.state, configured: { path: '/x', port: 8742 } } }), true);
});

test('los interruptores de sus módulos están en la tarjeta y llaman a setModule', async () => {
  const html = card(central(), { central: true, presupuestos: false });
  assert.match(html, /Central<\/label>/);
  assert.match(html, /Presupuestos<\/label>/);
  assert.match(html, /Watson no propone presupuestos/);
  assert.equal(html.match(/type="checkbox"/g)?.length, 2);
  assert.doesNotMatch(card(costguard), /type="checkbox"/);
  const calls: [ModuleName, boolean][] = [];
  await switchModule('presupuestos', true, async (name, value) => { calls.push([name, value]); });
  assert.deepEqual(calls, [['presupuestos', true]]);
});

test('el texto que llega de un conector se pinta como texto y el aviso de la carpeta antigua se ve', () => {
  const hostile = { ...central({ url: null, hasKey: false }, 'legacy', MOVED), description: '<img src=x onerror=alert(1)>' };
  const html = card(hostile);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /Hay que volver a conectarlo/);
  assert.match(html, /Ahora Central se conecta con su dirección y una clave/);
  assert.doesNotMatch(MOVED, /carpeta|bun|stdio/i);
});

test('un enlace ?conector= abre esa tarjeta y nada más', () => {
  assert.equal(connectorFromLink('?conector=central'), 'central');
  assert.equal(connectorFromLink('?seccion=conectores&conector=cerebro-mcp'), 'cerebro-mcp');
  for (const wrong of ['', '?conector=', '?conector=../x', '?conector=<b>', `?conector=${'a'.repeat(41)}`]) assert.equal(connectorFromLink(wrong), null, wrong);
});

test('Ajustes ya no tiene la pestaña Central: ?pestana=central lleva a Conectores', () => {
  assert.deepEqual(movedTabs, { central: 'central' });
  assert.deepEqual(resolveTab('central', null), { tab: 'general', connector: 'central' });
  assert.deepEqual(resolveTab(null, 'central'), { tab: 'general', connector: 'central' }, 'también la pestaña guardada');
  assert.deepEqual(resolveTab('correo', 'central'), { tab: 'correo', connector: null }, 'el enlace manda');
  assert.deepEqual(resolveTab('inventada', 'fiscal'), { tab: 'fiscal', connector: null });
  assert.deepEqual(resolveTab(null, null), { tab: 'general', connector: null });
});

test('Ajustes › Módulos solo tiene los internos y lleva a Conectores para el resto', () => {
  const external = connectorModules([central(), fabrica, { modules: { crmdev: true } }]);
  assert.deepEqual([...external], ['central', 'presupuestos', 'fabrica', 'crmdev']);
  const html = renderToStaticMarkup(createElement(ModulesList, { modules: {}, labels: { ...labels, crmdev: 'CRMDev' } as typeof labels, external, onChange: noop, onConnectors: noop }));
  for (const name of ['Central', 'Presupuestos', 'Mi fábrica', 'CRMDev']) assert.doesNotMatch(html, new RegExp(`> ${name}</label>`), name);
  assert.match(html, /Correo y Bandeja<\/label>/);
  assert.match(html, /Central, Presupuestos, Mi fábrica y CRMDev se encienden y apagan en su tarjeta de Conectores\./);
  assert.match(html, /Ir a Conectores/);
  assert.doesNotMatch(html, /conectores<\/label>|Conectores<\/label>/);
  assert.equal(joinNames(['Central']), 'Central');
  assert.equal(joinNames(['Central', 'Presupuestos']), 'Central y Presupuestos');
});

test('Conectores sigue en el menú aunque un estado antiguo traiga «conectores: false»', () => {
  assert.ok(menu.some(item => item.id === 'connectors'));
  assert.equal(sectionModule.connectors, undefined, 'Conectores no depende de ningún módulo');
});
