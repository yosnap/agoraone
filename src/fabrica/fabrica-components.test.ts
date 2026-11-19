import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../api/client';
import { centralNotice } from '../central/open-in-central';
import { WindowLinkNotice } from '../shell/window-link-notice';
import { FabricaPanel, OpenButtons, noWindow } from './fabrica-view';
import type { FabricaState } from './fabrica-state';

const panel = (state: FabricaState, discreet = false, mac = true, started: { ok: boolean; text: string } | null = null) =>
  renderToStaticMarkup(createElement(FabricaPanel, { state, discreet, mac, starting: false, started, onStart: () => {}, onOpen: () => {} }));

test('en modo discreto no hay nada que abrir', () => {
  for (const state of ['running', 'stopped'] as const) {
    const html = panel(state, true);
    assert.doesNotMatch(html, /Abrir la fábrica|Abrir en la ventana|Pantallas del panel/, state);
    assert.match(html, /En modo discreto no se abre la fábrica/);
  }
  const open = panel('running');
  assert.match(open, /Abrir la fábrica/);
  assert.equal(open.match(/Abrir en la ventana/g)?.length, 8, 'una por pantalla del panel');
});

test('parada: «Arrancar» solo en macOS y «Abrir la fábrica» por si arranca sola', () => {
  assert.match(panel('stopped', false, true), /Arrancar la fábrica/);
  assert.doesNotMatch(panel('stopped', false, false), /Arrancar la fábrica/);
  assert.match(panel('stopped', false, false), /Abrir la fábrica/);
  assert.doesNotMatch(panel('running'), /Arrancar la fábrica/);
  const missing = panel('missing');
  assert.match(missing, /Ir a Conectores/);
  assert.doesNotMatch(missing, /Abrir la fábrica|Arrancar/);
});

test('el resultado de «Arrancar» se ve aunque la fábrica ya esté en marcha', () => {
  const text = 'macOS la ha arrancado, pero su panel aún no responde. Mira sus registros en ~/Library/Logs/mi-fabrica.';
  assert.match(panel('running', false, true, { ok: true, text: 'La fábrica está en marcha.' }), /La fábrica está en marcha\./);
  assert.match(panel('stopped', false, true, { ok: false, text }), /Library\/Logs\/mi-fabrica/);
});

test('sin app de escritorio se ofrece «Abrir en el navegador»', () => {
  assert.equal(noWindow(new ApiError('Sin ventana', 409, { status: 'no_window' })), true);
  assert.equal(noWindow(new ApiError('Apagado', 404, { status: 'off' })), false);
  assert.equal(noWindow(new Error('x')), false);
  const render = (browser: boolean) => renderToStaticMarkup(createElement(OpenButtons, { label: 'Abrir la fábrica', busy: false, said: { ok: false, text: 'Sin ventana', browser }, onOpen: () => {} }));
  assert.match(render(true), /Abrir en el navegador/);
  assert.doesNotMatch(render(false), /Abrir en el navegador/);
});

test('el aviso de Central mantiene sus textos y oculta la dirección en modo discreto', () => {
  const render = (url: string, kind: 'oauth' | 'http' | 'https', discreet = false) => renderToStaticMarkup(createElement(WindowLinkNotice,
    { ...centralNotice({ url, kind }), discreet, onClose: () => {} }));
  const oauth = render('https://accounts.google.com/o/oauth2/auth?client_id=x', 'oauth');
  assert.match(oauth, /Conectar una cuenta se hace en tu navegador/);
  assert.match(oauth, /Abrir Ajustes de Central en el navegador/);
  assert.doesNotMatch(oauth, /accounts\.google\.com/, 'sin la dirección del inicio de sesión');
  const https = render('https://example.com/x', 'https');
  assert.match(https, /Esto se abre en tu navegador/);
  assert.match(https, /La ventana de Central solo carga páginas de Central\. Este enlace va a otro sitio:/);
  assert.match(https, /https:\/\/example\.com\/x/);
  assert.match(https, />Abrir en el navegador</);
  const http = render('http://example.com/x', 'http');
  assert.match(http, /y no va cifrado \(http\)/);
  assert.match(http, /Abrir igualmente en el navegador/);
  const hidden = render('https://cliente.example.com/secreto', 'https', true);
  assert.doesNotMatch(hidden, /cliente\.example\.com/);
  assert.match(hidden, /Dirección oculta en modo discreto/);
});
