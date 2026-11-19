import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatSummary, InboxItem } from '../api/core';
import { createEvent, createReminder } from '../api/core';
import { eventRequest, reminderRequest } from '../calendar/event-form';
import { chatOrigin, mailOrigin } from './inbox-cards';
import { decideOrigin, repoNoteRequest } from './project-note';

// A conversation and a mail with the same id: every action must reach its own card, never the other one.
const chat = { id: 7, kind: 'client', source: 'model', ruleId: null, ruleName: null, label: null, confidentiality: 'normal', state: 'pending',
  summary: 'Pide un cambio.', details: {}, participant: { name: 'Ana', phone: '+34 600 111 222' }, account: { id: 1, phone: null, label: null },
  client: { name: 'Acme', projects: ['Web'] }, attachments: {}, scope: null, lastIncomingAt: '2026-11-19T08:00:00Z', updatedAt: '2026-11-19T08:00:00Z' } as ChatSummary;
const mail = { id: 7, kind: 'client', source: 'model', ruleId: null, ruleName: null, confidentiality: 'normal', summary: null, details: {}, state: 'pending',
  proposal: null, suggestion: null, from: { name: 'Bea', address: 'bea@acme.com' }, subject: 'Hola', sentAt: '2026-11-19T08:00:00Z',
  account: { id: 1, address: 'yo@ejemplo.com' }, scope: null, attachments: 0, announcedAt: null, moved: null, client: null } as InboxItem;

function capture() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, id: 'x', clashes: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

test('la nota de una conversación marca la conversación, no el correo con el mismo número', async () => {
  const calls = capture();
  await decideOrigin(chatOrigin(chat), 'done');
  await decideOrigin(mailOrigin(mail), 'done');
  assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), ['PUT /api/core/chat/summaries/7', 'PUT /api/core/mail/inbox/7']);
  assert.deepEqual(calls[0].body, { state: 'done' });
  const note = repoNoteRequest(chatOrigin(chat), { client: 'Acme', project: 'Web', folder: 'docs/notas', title: 'T', content: 'C' });
  assert.deepEqual(note.source, { kind: 'chat', id: 7 });
  assert.equal('inboxId' in note, false, 'nunca como id de correo');
});

test('el evento y el recordatorio de una conversación van con chatId y sin inboxId', async () => {
  const calls = capture();
  const form = { title: ' Cita con Ana ', start: '2030-01-10T09:00', end: '2030-01-10T10:00', allDay: false, location: '', notes: '' };
  await createEvent(eventRequest(form, null, false, { chatId: 7 }));
  await createReminder(reminderRequest(form, null, { chatId: 7 }));
  await createEvent(eventRequest(form, null, false, { inboxId: 7 }));
  const [event, reminder, fromMail] = calls.map(c => c.body as Record<string, unknown>);
  assert.equal(calls[0].url, '/api/core/calendar/events');
  assert.equal(calls[1].url, '/api/core/calendar/reminders');
  assert.deepEqual([event.chatId, event.inboxId, event.title], [7, null, 'Cita con Ana']);
  assert.deepEqual([reminder.chatId, reminder.inboxId], [7, null]);
  assert.deepEqual([fromMail.chatId, fromMail.inboxId], [null, 7]);
});
