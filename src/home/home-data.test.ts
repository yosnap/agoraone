import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doneButOpen, invoicesToFile, latestMail, latestReceived, serversByTrouble, systemNotes, upcoming } from './home-data.ts';

const mail = (id: number, extra: Record<string, unknown> = {}) => ({ id, kind: 'other', confidentiality: 'normal', sentAt: `2026-11-1${id}T10:00:00Z`, details: {}, proposal: null, ...extra }) as never;

test('el correo más reciente primero y, en modo discreto, solo lo normal', () => {
  const items = [mail(1), mail(3), mail(2, { confidentiality: 'private' })];
  assert.deepEqual(latestMail(items, false).map((m: { id: number }) => m.id), [3, 2, 1]);
  assert.deepEqual(latestMail(items, true).map((m: { id: number }) => m.id), [3, 1]);
});

test('facturas por añadir y archivados que aún piden algo', () => {
  assert.equal(invoicesToFile([mail(1, { kind: 'invoice' }), mail(2)], [], false).mails.length, 1);
  const now = Date.parse('2026-11-16T00:00:00Z');
  const done = [mail(5, { details: { asks: ['Enviar el contrato'] } }), mail(4), mail(1, { sentAt: '2026-10-01T00:00:00Z', details: { dates: ['2026-10-01'] } })];
  assert.deepEqual(doneButOpen(done, false, now).map((m: { id: number }) => m.id), [5], 'solo las dos últimas semanas y con peticiones o plazos');
  assert.deepEqual(doneButOpen([mail(4, { details: { dates: ['2026-11-15'] } }), mail(3, { details: { dates: ['2026-11-20'] } })], false, now).map((m: { id: number }) => m.id), [3], 'un plazo vencido ya no cuenta');
});

test('agenda por venir, servidores caídos primero y avisos del sistema', () => {
  const now = Date.parse('2026-11-16T10:00:00Z');
  const ev = (id: string, start: string, end: string) => ({ id, calendarId: 'c', title: id, start, end, allDay: false, location: null });
  const next = upcoming([ev('b', '2026-11-16T12:00:00Z', '2026-11-16T13:00:00Z'), ev('a', '2026-11-16T10:30:00Z', '2026-11-16T11:00:00Z'), ev('x', '2026-11-16T08:00:00Z', '2026-11-16T09:00:00Z')], now);
  assert.deepEqual(next.map(e => [e.id, e.soon]), [['a', true], ['b', false]]);
  const { servers, down } = serversByTrouble([{ name: 'web', status: 'green', provider: null, projects: [] }, { name: 'db', status: 'red', provider: null, projects: [] }]);
  assert.equal(servers[0].name, 'db'); assert.equal(down, 1);
  const alerts = [{ key: 'k', kind: 'call' as const, title: 'Llamada perdida de Ana', body: 'Ana', at: '' }, { key: 'm', kind: 'meeting' as const, title: 'Reunión con X', body: '', at: '' },
    { key: 's', kind: 'summary' as const, title: 'Resumen', body: '', at: '' }];
  const pieces = [{ id: 'w', name: 'Whisper', state: 'missing' as const, modules: ['Voz', 'Reuniones'], detail: null, how: null as never }];
  const all = () => true;
  assert.deepEqual(systemNotes(alerts, ['Sin permiso de calendario', null], pieces, all, false).map(n => n.text), ['Sin permiso de calendario', 'Falta Whisper', 'Llamada perdida de Ana', 'Reunión con X']);
  const noAgendaNoVoice = (m: string) => !['agenda', 'voz', 'reuniones'].includes(m);
  assert.deepEqual(systemNotes(alerts, [], pieces, noAgendaNoVoice, true).map(n => [n.text, n.detail]), [['Llamada perdida', undefined]], 'módulos apagados fuera y, en discreto, solo el tipo');
});

const chat = (id: number, extra: Record<string, unknown> = {}) => ({ id, kind: 'client', confidentiality: 'normal', lastIncomingAt: `2026-11-1${id}T11:00:00Z`,
  updatedAt: '2026-11-01T00:00:00Z', details: {}, summary: 'Pide algo', participant: { name: 'Ana', phone: '+34 600 000 001' }, ...extra }) as never;

test('mensajes recibidos: correo y WhatsApp mezclados por fecha, con el mismo tope y sin lo no normal en discreto', () => {
  const received = latestReceived([mail(1), mail(3)], [chat(2), chat(4, { confidentiality: 'local_only' }), chat(5, { lastIncomingAt: null, updatedAt: '2026-11-10T00:00:00Z' })], false);
  assert.deepEqual(received.map(card => `${card.source}${card.item.id}`), ['chat4', 'mail3', 'chat2', 'mail1', 'chat5'], 'sin mensaje recibido cuenta su última clasificación');
  assert.deepEqual(latestReceived([mail(1), mail(3, { confidentiality: 'private' })], [chat(2), chat(4, { confidentiality: 'local_only' })], true)
    .map(card => `${card.source}${card.item.id}`), ['chat2', 'mail1']);
  assert.equal(latestReceived(Array.from({ length: 6 }, (_, i) => mail(i)), Array.from({ length: 6 }, (_, i) => chat(i)), false).length, 8);
});
