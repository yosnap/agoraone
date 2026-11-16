import type { AlertItem, CalendarEvent, CentralServer, DoctorPiece, InboxItem, ModuleName, Receipt } from '../api/core';

/** What the home blocks show, derived from what the core already reads (no new data, nothing invented). Pure, so
 * the rules are tested apart from the screen. */

const DAY = 86_400_000;
const shownLevel = (discreet: boolean) => (item: { confidentiality: string }) => !discreet || item.confidentiality === 'normal';

/** The mail waiting for the user, newest first. */
export function latestMail(items: InboxItem[], discreet: boolean, limit = 8): InboxItem[] {
  return items.filter(shownLevel(discreet)).sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(0, limit);
}

/** Invoices still to file: invoice mails not yet archived in a fiscal folder, plus receipts from the phone. */
export function invoicesToFile(pending: InboxItem[], receipts: Receipt[], discreet: boolean): { mails: InboxItem[]; receipts: Receipt[] } {
  return { mails: pending.filter(shownLevel(discreet)).filter(item => item.kind === 'invoice' || item.proposal === 'archive_invoice'), receipts };
}

/** Mails received in the last two weeks and already marked done that still carry requests, or deadlines that
 * have not passed (dates come as YYYY-MM-DD): they may still need doing. */
export const openDates = (item: InboxItem, now = Date.now()) => (item.details.dates ?? []).filter(date => Date.parse(`${date}T23:59:59`) >= now);
export function doneButOpen(done: InboxItem[], discreet: boolean, now = Date.now()): InboxItem[] {
  return done.filter(shownLevel(discreet))
    .filter(item => now - new Date(item.sentAt).getTime() <= 14 * DAY)
    .filter(item => (item.details.asks?.length ?? 0) > 0 || openDates(item, now).length > 0)
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(0, 6);
}

/** The week's events still to come, in order; `soon` marks what starts within the hour. */
export function upcoming(events: CalendarEvent[], now = Date.now()): (CalendarEvent & { soon: boolean })[] {
  return events.filter(event => new Date(event.end).getTime() > now)
    .sort((a, b) => a.start.localeCompare(b.start)).slice(0, 6)
    .map(event => ({ ...event, soon: !event.allDay && new Date(event.start).getTime() - now <= 3_600_000 }));
}

const SERVER_ORDER: Record<string, number> = { red: 0, amber: 1, grey: 2, green: 3 };
/** Servers, the ones down first; `down` counts red and amber. */
export function serversByTrouble(servers: CentralServer[]): { servers: CentralServer[]; down: number } {
  const sorted = [...servers].sort((a, b) => (SERVER_ORDER[a.status ?? 'grey'] ?? 2) - (SERVER_ORDER[b.status ?? 'grey'] ?? 2) || a.name.localeCompare(b.name, 'es'));
  return { servers: sorted, down: sorted.filter(server => server.status === 'red' || server.status === 'amber').length };
}

export type SystemNote = { key: string; text: string; detail?: string; tone: 'warn' | 'info' };
const KIND_LABEL: Record<AlertItem['kind'], string> = { call: 'Llamada perdida', meeting: 'Reunión próxima', commitment: 'Plazo de un correo', summary: 'Tu día' };
// The doctor names the modules each piece serves in words; Watson and the brain are always on.
const MODULE_BY_NAME: Record<string, ModuleName> = { Correo: 'correo', Agenda: 'agenda', Fiscal: 'fiscal', Trabajos: 'trabajos', Reuniones: 'reuniones',
  Voz: 'voz', 'Música': 'musica', 'Oficina 3D': 'oficina', Conectores: 'conectores' };
/** The system's messages: what could not be read, the pieces missing for a module that is on, and the reminders due
 * now (meetings only with the agenda on, mail deadlines only with mail on). In discreet mode a reminder says only
 * what kind it is: calls, meetings and mail carry their own levels, often «solo en este Mac». */
export function systemNotes(alerts: AlertItem[], problems: (string | null | undefined)[], pieces: DoctorPiece[], on: (module: ModuleName) => boolean, discreet: boolean): SystemNote[] {
  const serves = (piece: DoctorPiece) => !piece.modules.length || piece.modules.some(name => !MODULE_BY_NAME[name] || on(MODULE_BY_NAME[name]));
  const wanted = (alert: AlertItem) => alert.kind === 'call' || (alert.kind === 'meeting' && on('agenda')) || (alert.kind === 'commitment' && on('correo'));
  return [
    ...problems.filter((problem): problem is string => !!problem).map((problem, index) => ({ key: `p${index}`, text: problem, tone: 'warn' as const })),
    ...pieces.filter(piece => piece.state === 'missing' && serves(piece)).map(piece => ({ key: `d-${piece.id}`, text: `Falta ${piece.name}`, detail: piece.detail ?? undefined, tone: 'warn' as const })),
    ...alerts.filter(alert => alert.kind !== 'summary' && wanted(alert)).map(alert => discreet
      ? { key: alert.key, text: KIND_LABEL[alert.kind], tone: 'info' as const }
      : { key: alert.key, text: alert.title, detail: alert.body, tone: 'info' as const }),
  ];
}
