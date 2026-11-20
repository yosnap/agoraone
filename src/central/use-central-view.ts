import type { CentralEvent, CentralLevel, CentralViewName } from '../api/central';
import { createReadStore, type Read, type ReadFailure } from '../ui/read-store';

// What the «Central» section (and Presupuestos) has read, shared by its tabs: each view (or record) is asked once, when
// it is first shown, and kept while the section lives, so going back to a tab does not ask Central again. «Volver a
// leer» forgets everything and the views on screen ask again. Only the latest answer for a view counts. The store is
// the shared one of src/ui/read-store.ts.

/** Why a read failed: `kind` is the core's (`not_connected`, `off`, `forbidden`, `unreachable`…). */
export type CentralFailure = ReadFailure;
export type CentralRead<T> = Read<T>;

/** The key of the connection's read, kept by «Volver a leer». */
export const CONNECTION = 'conexion';
const store = createReadStore('No se pudo leer Central.');

export const failureOf = store.failureOf;

/** Asks for `key` unless it is already read or being read. */
export function ensureCentral<T>(key: string, fetcher: () => Promise<T>, again = false) {
  store.ensure(key, fetcher, again);
}

/** The read of `key` (null: nothing to read), asked once it is on screen. */
export function useCentralRead<T>(key: string | null, fetcher: () => Promise<T>): CentralRead<T> & { reload: () => void } {
  return store.useRead(key, fetcher);
}

/** «Volver a leer»: forgets every view (not the connection, so the tabs stay); the ones on screen are asked again. */
export function forgetCentral() {
  store.forget({ except: [CONNECTION] });
}

/** How many times «Volver a leer» was pressed: what depends on earlier pages (the cursors) starts again with it. */
export const useCentralReadings = () => store.useReadings();

/** Whether a «Volver a leer» is still waiting for its answers. */
export const useCentralRereading = () => store.useRereading();

/** A key for a view and its parameters, the same whatever the order of the parameters. */
export const viewKey = (view: CentralViewName, params: Record<string, string | undefined> = {}) =>
  `${view}?${Object.entries(params).filter(([, v]) => v).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&')}`;

/** A tab of the section: one of Central's views, or «Por crear» (clients to create in Central, from AgoraOne). */
export type CentralTabName = CentralViewName | 'por-crear';
export type CentralTab = { id: CentralTabName; label: string };
/** The tabs of the section, in order; each one reads only its own view when opened. */
export const centralTabs: CentralTab[] = [
  { id: 'resumen', label: 'Resumen' }, { id: 'alertas', label: 'Alertas' }, { id: 'pendientes', label: 'Pendientes' },
  { id: 'clientes', label: 'Clientes' }, { id: 'proyectos', label: 'Proyectos' }, { id: 'webs', label: 'Webs' },
  { id: 'servidores', label: 'Servidores' }, { id: 'agenda', label: 'Agenda de Central' }, { id: 'por-crear', label: 'Por crear' },
];

// The tab another section asks Central to open with (the Resumen's «Crear en Central»), taken once.
let requestedTab: CentralTabName | null = null;
export const openCentralTab = (tab: CentralTabName) => { requestedTab = tab; };
export const takeCentralTab = (): CentralTabName => { const tab = requestedTab ?? 'resumen'; requestedTab = null; return tab; };

/** The badge of each of Central's levels. */
export const levelTone: Record<CentralLevel, string> = { green: 'good', amber: 'waiting', red: 'bad', grey: 'neutral' };

const clock = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
const day = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });

const dayOf = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Madrid' });

/** «leído a las 10:30» for a snapshot of today (Madrid's time), «leído el 15 nov 2026 a las 10:30» for an older
 * one, so an old copy never looks current; empty when the time is unknown. */
export function readAtLabel(iso: string | null | undefined, now = new Date()) {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  const today = dayOf.format(at) === dayOf.format(now);
  return today ? `leído a las ${clock.format(at)}` : `leído el ${dayOf.format(at)} a las ${clock.format(at)}`;
}

/** A date of Central in Madrid's time, or «—». */
export function dateLabel(iso: string | null | undefined) {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) ? day.format(at) : '—';
}

/** A fresh start each time the section opens: whatever was read on a previous visit (or before connecting) is
 * forgotten without notifying, since nothing of the section is on screen yet. */
export function startCentral() {
  store.start();
}

const madridParts = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Europe/Madrid' });
const heading = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' });

/** The day (AAAA-MM-DD) of an instant in Madrid, whatever the zone of this computer. */
export function madridDay(at: Date) {
  const part = (type: string) => madridParts.formatToParts(at).find(p => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** `day` moved by some days (calendar days, no hours involved). */
export function addDays(day: string, days: number) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Central's agenda reads at most 62 days, both included. */
export const AGENDA_DAYS = 62;

const wall = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** How far Madrid's clock is ahead of UTC at an instant (one hour in winter, two in summer). */
function madridOffset(at: number) {
  const p = Object.fromEntries(wall.formatToParts(new Date(at)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at / 1000) * 1000;
}

/** The instant of 00:00 of a day AAAA-MM-DD in Madrid (the changes of hour are after midnight: no ambiguity). */
function madridMidnight(day: string) {
  const utc = Date.parse(`${day}T00:00:00Z`);
  return utc - madridOffset(utc - madridOffset(utc));
}

/** Why a range of the agenda cannot be asked, measured like Central: from 00:00 of «desde» to the end of «hasta» in
 * Madrid, in real time, so 62 days that cross the autumn change of hour (a day of 25 hours) do not fit. */
export function agendaRangeProblem(from: string, to: string): string | null {
  const valid = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && addDays(day, 0) === day && +day.slice(0, 4) >= 2000 && +day.slice(0, 4) <= 2100;
  if (!valid(from) || !valid(to)) return 'Elige dos días que existan, entre 2000 y 2100.';
  if (to < from) return '«Hasta» es anterior a «desde».';
  const span = madridMidnight(addDays(to, 1)) - 1 - madridMidnight(from);
  return span > AGENDA_DAYS * 864e5
    ? `La agenda de Central abarca como mucho ${AGENDA_DAYS} días (61 si el rango cruza el cambio de hora de octubre).` : null;
}

const shortDay = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'Europe/Madrid' });

/** An event in the agenda: under which day it goes and, when it ends another day, «hasta el 20 nov.» (with the
 * time when it is not all day). */
export type AgendaItem = { event: CentralEvent; until: string | null };

/** The events grouped by their day in Madrid, in Central's order. One that began before «desde» goes under «desde». */
export function agendaDays(events: CentralEvent[], from: string): [string, AgendaItem[]][] {
  const days = new Map<string, AgendaItem[]>();
  for (const event of events) {
    const start = event.start ? new Date(event.start) : null;
    if (!start || Number.isNaN(start.getTime())) continue;
    const startDay = madridDay(start);
    const day = startDay < from ? from : startDay;
    const end = event.end ? new Date(event.end) : null;
    let until: string | null = null;
    if (end && !Number.isNaN(end.getTime())) {
      // an all-day event ends at 00:00 of the day after its last one, in Central's zone (UTC on a server, Madrid on a
      // Mac): twelve hours earlier is its last day in Madrid either way
      const last = event.allDay ? new Date(end.getTime() - 12 * 3600e3) : end;
      if (madridDay(last) !== startDay) until = event.allDay ? `hasta el ${shortDay.format(last)}` : `hasta el ${shortDay.format(last)}, ${clock.format(last)}`;
    }
    days.set(day, [...(days.get(day) ?? []), { event, until }]);
  }
  return [...days.entries()];
}

/** «miércoles, 18 de noviembre de 2026» for a day AAAA-MM-DD of Madrid. */
export const dayHeading = (day: string) => heading.format(new Date(`${day}T12:00:00Z`));

/** «10:30» in Madrid's time, or «». */
export function timeLabel(iso: string | null | undefined) {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) ? clock.format(at) : '';
}
