import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatPreview, ChatReplyDraft, ChatWindow } from '../api/core';
import { ChatReplyForm, ChatReplyPreview } from './chat-reply';
import { CLOSED_REASON, closedReason, counter, META_COST_NOTICE, READ_NOTICE, windowText } from './chat-reply-text';

const now = new Date('2026-11-19T12:00:00Z');
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const open: ChatWindow = { open: true, until: hoursFromNow(5), lastIncomingAt: hoursFromNow(-19) };
const closed: ChatWindow = { open: false, until: hoursFromNow(-2), lastIncomingAt: hoursFromNow(-26) };
const people = { to: { name: 'Ana', phone: '+34 600 111 222' }, from: { phone: '+34 600 999 888', label: null } };
const reply = (extra: Partial<ChatReplyDraft> = {}): ChatReplyDraft => ({ conversationId: 4, accountId: 1, text: '', confidentiality: 'normal',
  window: open, maxLength: 4096, ...people, ...extra });
const noop = () => {};
const form = (draft: ChatReplyDraft, text = 'Te confirmo el lunes.') => renderToStaticMarkup(createElement(ChatReplyForm, {
  reply: draft, text, instructions: '', busy: '', error: '', assistant: 'Watson', onText: noop, onInstructions: noop, onCompose: noop, onPreview: noop, onCancel: noop }));
const preview = (window: ChatWindow, extra: Partial<ChatPreview> = {}, locked = false) => renderToStaticMarkup(createElement(ChatReplyPreview, {
  preview: { draft: { conversationId: 4, text: 'Te confirmo el lunes.' }, digest: 'a'.repeat(64), confidentiality: 'normal', attachments: [], window, ...people, ...extra },
  busy: '', error: '', locked, onSend: noop, onBack: noop }));

test('la ventana se describe abierta, cerrada, a punto de cerrarse o sin mensajes suyos', () => {
  assert.equal(windowText({ open: true, until: '2026-11-19T14:32:00Z', lastIncomingAt: null }, now, 'UTC'), 'Abierta hasta las 14:32');
  assert.equal(windowText({ open: true, until: '2026-11-20T09:05:00Z', lastIncomingAt: null }, now, 'UTC'), 'Abierta hasta el 20/11 a las 09:05');
  assert.equal(windowText({ open: false, until: '2026-11-18T10:00:00Z', lastIncomingAt: null }, now, 'UTC'), 'Cerrada desde el 18/11 a las 10:00');
  assert.match(windowText({ open: false, until: null, lastIncomingAt: null }, now), /^Cerrada: no hay ningún mensaje suyo/);
  assert.equal(closedReason({ open: false, until: '2026-11-18T10:00:00Z', lastIncomingAt: null }, now), CLOSED_REASON);
  assert.match(closedReason({ open: false, until: '2026-11-19T12:00:30Z', lastIncomingAt: null }, now) ?? '', /menos de un minuto/);
  assert.equal(closedReason({ open: true, until: '2026-11-19T14:00:00Z', lastIncomingAt: null }, now), null);
});

test('el contador cuenta caracteres y avisa por encima del límite de WhatsApp', () => {
  assert.deepEqual(counter('  hola 👋 ', 4096), { label: '6 / 4096', over: false });
  assert.deepEqual(counter('a'.repeat(4097), 4096), { label: '4097 / 4096', over: true });
  const long = form(reply(), 'a'.repeat(4097));
  assert.match(long, /4097 \/ 4096 · demasiado largo para WhatsApp/);
  assert.match(long, /<button type="submit" class="button primary" disabled="">Vista previa/);
});

test('con la ventana cerrada la vista previa y el envío están desactivados con su motivo', () => {
  const shut = form(reply({ window: closed }));
  assert.match(shut, /Han pasado más de 24 h desde su último mensaje/);
  assert.match(shut, /<button type="submit" class="button primary" disabled="" title="Han pasado más de 24 h[^"]*">Vista previa/);
  const ready = form(reply());
  assert.match(ready, /<button type="submit" class="button primary">Vista previa/);
  assert.match(ready, /Abierta hasta/);
  const sent = preview(closed);
  assert.match(sent, /<button type="button" class="button primary" disabled="" title="Han pasado más de 24 h[^"]*">Enviar/);
  assert.match(preview(open), /<button type="button" class="button primary">Enviar/);
  assert.match(preview(open, {}, true), /<button type="button" class="button primary" disabled="">Enviar/, 'un envío que no se puede repetir');
});

test('la vista previa dice a quién, desde dónde, sin adjuntos y con los avisos de leído y de coste', () => {
  const shown = preview(open);
  for (const text of ['Ana · +34 600 111 222', '+34 600 999 888', 'Ninguno', 'Te confirmo el lunes.', READ_NOTICE, META_COST_NOTICE]) assert.ok(shown.includes(text), text);
  const secret = preview(open, { to: null, confidentiality: 'private' });
  assert.match(secret, /Conversación privada/);
  assert.doesNotMatch(secret, /Ana|600 111 222/);
});

test('Watson solo redacta en lo normal', () => {
  assert.match(form(reply()), /Redactar con Watson/);
  for (const level of ['private', 'local_only'] as const) {
    const html = form(reply({ confidentiality: level, to: level === 'private' ? null : people.to }));
    assert.doesNotMatch(html, /Redactar con Watson|Indicaciones para/);
    assert.match(html, /Watson no la lee, escribe la respuesta tú/);
  }
});
