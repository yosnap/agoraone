import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doneButOpen, invoicesToFile, latestMail, serversByTrouble, systemNotes, upcoming } from './home-data.ts';

const mail = (id: number, extra: Record<string, unknown> = {}) => ({ id, kind: 'other', confidentiality: 'normal', sentAt: `2026-11-1${id}T10:00:00Z`, details: {}, proposal: null, ...extra }) as never;

test('el correo más reciente primero y, en modo discreto, solo lo normal', () => {
  const items = [mail(1), mail(3), mail(2, { confidentiality: 'private' })];
  assert.deepEqual(latestMail(items, false).map((m: { id: number }) => m.id), [3, 2, 1]);
  assert.deepEqual(latestMail(items, true).map((m: { id: number }) => m.id), [3, 1]);
});

test('facturas por añadir y archivados que aún piden algo', () => {
  assert.equal(invoicesToFile([mail(1, { kind: 'invoice' }), mail(2)], [], false).mails.length, 1);
  const now = Date.parse('2026-11-16T00:00:00Z');
  const done = [mail(5, { details: { asks: ['Enviar el contrato'] } }), mail(4), mail(1, { sentAt: '2026-10-01T00:00:00Z', details: { dates: ['1/10'] } })];
  assert.deepEqual(doneButOpen(done, false, now).map((m: { id: number }) => m.id), [5], 'solo las dos últimas semanas y con peticiones o plazos');
});

test('agenda por venir, servidores caídos primero y avisos del sistema', () => {
  const now = Date.parse('2026-11-16T10:00:00Z');
  const ev = (id: string, start: string, end: string) => ({ id, calendarId: 'c', title: id, start, end, allDay: false, location: null });
  const next = upcoming([ev('b', '2026-11-16T12:00:00Z', '2026-11-16T13:00:00Z'), ev('a', '2026-11-16T10:30:00Z', '2026-11-16T11:00:00Z'), ev('x', '2026-11-16T08:00:00Z', '2026-11-16T09:00:00Z')], now);
  assert.deepEqual(next.map(e => [e.id, e.soon]), [['a', true], ['b', false]]);
  const { servers, down } = serversByTrouble([{ name: 'web', status: 'green', provider: null, projects: [] }, { name: 'db', status: 'red', provider: null, projects: [] }]);
  assert.equal(servers[0].name, 'db'); assert.equal(down, 1);
  const notes = systemNotes([{ key: 'k', kind: 'call', title: 'Llamada perdida', body: 'Ana', at: '' }, { key: 's', kind: 'summary', title: 'Resumen', body: '', at: '' }],
    ['Sin permiso de calendario', null], [{ id: 'w', name: 'Whisper', state: 'missing', modules: [], detail: null, how: null as never }]);
  assert.deepEqual(notes.map(n => n.text), ['Sin permiso de calendario', 'Falta Whisper', 'Llamada perdida']);
});
