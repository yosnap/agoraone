import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatSummary, InboxItem } from '../api/core';
import { ChatCard } from './chat-card';
import { arrange, attachmentName, attachmentsText, cardKey, chatOrigin, type Card, type View } from './inbox-cards';
import { attachmentsSection, noteContent } from './project-note-text';

const mail = (id: number, name: string, sentAt: string, summary = 'Pide la factura.'): Card => ({ source: 'mail', item: {
  id, kind: 'invoice', source: 'model', ruleId: null, ruleName: null, confidentiality: 'normal', summary, details: {}, state: 'pending', proposal: null,
  suggestion: null, from: { name, address: `${name.toLowerCase()}@ejemplo.com` }, subject: 'Factura', sentAt, account: { id: 1, address: 'yo@ejemplo.com' },
  scope: null, attachments: 0, announcedAt: null, moved: null, client: null } as InboxItem });
const conversation = (id: number, name: string, at: string, extra: Partial<ChatSummary> = {}): ChatSummary => ({
  id, kind: 'client', source: 'model', ruleId: null, ruleName: null, label: null, confidentiality: 'normal', state: 'pending',
  summary: 'Quiere cambiar la cita.', details: { asks: ['Mover la cita al lunes'] }, participant: { name, phone: '+34 600 111 222' },
  account: { id: 1, phone: '+34 600 999 888', label: null }, client: { name: 'Acme', projects: ['Web'] }, attachments: {}, scope: null,
  lastIncomingAt: at, updatedAt: at, ...extra });
const chat = (id: number, name: string, at: string, extra: Partial<ChatSummary> = {}): Card => ({ source: 'chat', item: conversation(id, name, at, extra) });
const view = (change: Partial<View> = {}): View => ({ text: '', kind: 'all', source: 'all', sort: 'recent', perRow: 4, ...change });

test('las dos fuentes se mezclan por fecha y se filtran por fuente', () => {
  const cards = [mail(1, 'Bea', '2026-11-18T09:00:00Z'), chat(1, 'Ana', '2026-11-19T09:00:00Z'), mail(2, 'Carlos', '2026-11-17T09:00:00Z')];
  assert.deepEqual(arrange(cards, view()).map(cardKey), ['chat:1', 'mail:1', 'mail:2'], 'mismo id, claves distintas');
  assert.deepEqual(arrange(cards, view({ sort: 'oldest' })).map(cardKey), ['mail:2', 'mail:1', 'chat:1']);
  assert.deepEqual(arrange(cards, view({ sort: 'sender' })).map(cardKey), ['chat:1', 'mail:1', 'mail:2']);
  assert.deepEqual(arrange(cards, view({ source: 'chat' })).map(cardKey), ['chat:1']);
  assert.deepEqual(arrange(cards, view({ source: 'mail' })).map(cardKey), ['mail:1', 'mail:2']);
});

test('el buscador mira nombre, etiqueta y resumen, nunca el número; lo privado sin nombre', () => {
  const cards = [chat(1, 'Ana', '2026-11-19T09:00:00Z', { label: 'Instinct' }), chat(2, 'Luis', '2026-11-19T08:00:00Z', { confidentiality: 'private', participant: null, summary: null })];
  assert.deepEqual(arrange(cards, view({ text: 'ana' })).map(cardKey), ['chat:1']);
  assert.deepEqual(arrange(cards, view({ text: 'instinct' })).map(cardKey), ['chat:1']);
  assert.deepEqual(arrange(cards, view({ text: 'cita' })).map(cardKey), ['chat:1']);
  assert.deepEqual(arrange(cards, view({ text: '600 111' })), [], 'nunca por número');
  assert.deepEqual(arrange(cards, view({ text: 'luis' })), [], 'lo privado no se encuentra por su nombre');
});

test('los adjuntos solo se listan por tipo y número', () => {
  assert.equal(attachmentsText({ image: 2, audio: 1, raro: 1 }), '2 imágenes, 1 audio, 1 adjunto');
  const origin = chatOrigin(conversation(3, 'Ana', '2026-11-19T09:00:00Z', { attachments: { image: 2 } }));
  assert.equal(origin.kind, 'chat');
  assert.equal(origin.from.address, null, 'sin el número');
  const section = attachmentsSection(origin.attachments, attachmentName);
  assert.match(section, /## Adjuntos/);
  assert.match(section, /- 2 imágenes/);
  assert.doesNotMatch(section, /http/);
  const content = noteContent(origin, 'Web');
  assert.match(content, /- De: Ana \(WhatsApp\)/);
  assert.match(content, /- Conversación de WhatsApp/);
  assert.doesNotMatch(content, /600/);
});

const render = (item: ChatSummary, discreet = false) => renderToStaticMarkup(createElement(ChatCard, {
  item, discreet, isOpen: () => false, show: () => {}, orcaProjects: [{ client: 'Acme', project: 'Web', repo: 'Acme/Web' }], onDecide: () => {}, onNote: () => {} }));

test('la tarjeta lleva su distintivo y su nivel; el discreto oculta resumen y número', () => {
  const open = render(conversation(4, 'Ana', '2026-11-19T09:00:00Z', { label: 'Instinct' }));
  assert.match(open, /WhatsApp/);
  assert.match(open, /Instinct/);
  assert.match(open, /\+34 600 111 222/);
  assert.match(open, /Quiere cambiar la cita/);
  assert.match(open, /Crear issue…/);
  assert.match(open, /Llevar a Orca…/);
  assert.doesNotMatch(open, /Eliminar/, 'en WhatsApp no se borra nada');
  assert.match(open, /Responder…/);
  const hidden = render(conversation(4, 'Ana', '2026-11-19T09:00:00Z'), true);
  assert.match(hidden, /Ana/);
  assert.match(hidden, /Cliente de Central/);
  assert.doesNotMatch(hidden, /600 111 222|Quiere cambiar|Mover la cita|Cliente: Acme/);
  assert.match(hidden, /disabled="" title="Sal del modo discreto para responder">Responder…/, 'en discreto no se responde');
  const local = render(conversation(5, 'Ana', '2026-11-19T09:00:00Z', { confidentiality: 'local_only', summary: null }));
  assert.match(local, /Solo en este Mac: sin resumen de modelo/);
  assert.doesNotMatch(local, /Crear issue|Llevar a Orca/, 'lo que no es normal no ofrece issue ni Orca');
  const secret = render(conversation(6, 'Ana', '2026-11-19T09:00:00Z', { confidentiality: 'private', participant: null, summary: null, client: null }));
  assert.match(secret, /Conversación privada/);
  assert.match(secret, /Privado: sin resumen de modelo/);
  assert.doesNotMatch(secret, /Ana|600|Crear issue|Llevar a Orca/);
});
