import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatSummary, ProposedChatReply } from '../api/core';
import { ChatReplyProposals, type useChatReplyProposals } from '../assistant/chat-reply-proposals';
import { announceNote } from '../assistant/announce-note';
import { chatAnnouncement } from '../inbox/inbox-labels';
import { ReceivedSlide } from './home-parts';

const chat = (extra: Partial<ChatSummary> = {}) => ({
  id: 7, kind: 'client', source: 'model', ruleId: null, ruleName: null, label: null, confidentiality: 'normal', state: 'pending',
  summary: 'Quiere el presupuesto de la web', details: { asks: ['Enviar el presupuesto'], amounts: ['1.200 €'] },
  participant: { name: 'Ana Prueba', phone: '+34 600 000 001' }, account: { id: 1, phone: '+34 600 999 888', label: null },
  client: null, attachments: {}, scope: null, lastIncomingAt: '2026-11-19T10:00:00Z', updatedAt: '2026-11-19T10:00:00Z', ...extra,
}) as ChatSummary;

test('el aviso de un WhatsApp lo escribe la pantalla: con nombre y cliente, y lo privado sin nombre', () => {
  assert.equal(chatAnnouncement(chat({ client: { name: 'Café Web', projects: [] } })),
    'Tienes una petición de cliente por WhatsApp de Ana Prueba, de Café Web (1.200 €). ¿Lo marco como hecho?');
  const hidden = chatAnnouncement(chat({ confidentiality: 'private', participant: null, kind: 'incident' }));
  assert.equal(hidden, 'Tienes un WhatsApp privado pendiente en la Bandeja.');
  assert.doesNotMatch(chatAnnouncement(chat()), /600/, 'nunca el número');
});

test('en la portada un WhatsApp lleva su distintivo y el nombre, nunca el número, y en discreto sin resumen', () => {
  const card = { source: 'chat' as const, item: chat() };
  const open = renderToStaticMarkup(createElement(ReceivedSlide, { card, discreet: false }));
  assert.match(open, /WhatsApp/); assert.match(open, /Ana Prueba/); assert.match(open, /Quiere el presupuesto/); assert.match(open, /Pide: Enviar el presupuesto/);
  assert.doesNotMatch(open, /600/);
  const hidden = renderToStaticMarkup(createElement(ReceivedSlide, { card, discreet: true }));
  assert.doesNotMatch(hidden, /Quiere el presupuesto|Pide:/);
});

test('la respuesta propuesta solo ofrece revisarla o descartarla, y en discreto no enseña nada', () => {
  const reply: ProposedChatReply = { conversationId: 7, contact: 'Ana Prueba', summary: 'Quiere el presupuesto', text: 'Te lo mando esta tarde.',
    window: { open: true, until: '2026-11-20T10:00:00Z', lastIncomingAt: '2026-11-19T10:00:00Z' } };
  const state = { list: [{ id: 'p1', reply, state: 'open' }], review: async () => undefined, dismiss: () => undefined, finish: () => undefined,
    add: () => undefined, clear: () => undefined } as unknown as ReturnType<typeof useChatReplyProposals>;
  const open = renderToStaticMarkup(createElement(ChatReplyProposals, { state }));
  assert.match(open, /Respuesta de WhatsApp propuesta para Ana Prueba/); assert.match(open, /Te lo mando esta tarde\./);
  assert.match(open, /Revisar y enviar…/); assert.match(open, /Descartar/); assert.match(open, /No se ha enviado nada/);
  assert.doesNotMatch(open, />Enviar</, 'desde la tarjeta no se envía: solo se abre la revisión');
  const hidden = renderToStaticMarkup(createElement(ChatReplyProposals, { state, discreet: true }));
  assert.doesNotMatch(hidden, /Ana Prueba|Te lo mando/);
  assert.match(hidden, /<button[^>]*disabled=""[^>]*>Revisar y enviar…/, 'en discreto no se abre la revisión');
});

test('la nota tras responder a un aviso no nombra a nadie en discreto, y lo privado nunca', () => {
  const normal = { ...chat(), channel: 'chat' as const };
  const hidden = { ...chat({ confidentiality: 'private', participant: null }), channel: 'chat' as const };
  const mail = { id: 1, subject: 'Factura de Hostinger', channel: 'mail' as const } as never;
  assert.equal(announceNote(normal, 'done', false), 'El WhatsApp de Ana Prueba: marcado como hecho en la Bandeja.');
  assert.equal(announceNote(normal, 'done', true), 'Un WhatsApp: marcado como hecho en la Bandeja.');
  assert.equal(announceNote(hidden, 'dismissed', false), 'Un WhatsApp privado: descartado en la Bandeja.');
  assert.doesNotMatch(announceNote(hidden, null, false), /Conversación privada/);
  assert.equal(announceNote(mail, null, true), 'Un correo: lo dejo en la Bandeja.');
  assert.equal(announceNote(mail, 'done', false), '«Factura de Hostinger»: marcado como hecho en la Bandeja.');
});
