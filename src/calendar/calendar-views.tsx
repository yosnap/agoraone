import type { Agenda, CalendarEvent, CalendarOrigin } from '../api/core';
import { hourMinute } from './event-form';

export type Scale = 'dia' | 'semana' | 'mes' | 'año';
const DAY = 86_400_000;
const WEEKDAYS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

/** A local day as YYYY-MM-DD (never through UTC, which would move it at midnight). */
export const ymd = (day: Date) => `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
const atNoon = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12);
export const addDays = (day: Date, n: number) => atNoon(new Date(atNoon(day).getTime() + n * DAY));
const monday = (day: Date) => addDays(day, -((day.getDay() + 6) % 7));

/** The days a view shows, from first to last (both included): a month grid runs from Monday to Sunday. */
export function period(scale: Scale, focus: Date): { first: Date; last: Date } {
  if (scale === 'dia') return { first: atNoon(focus), last: atNoon(focus) };
  if (scale === 'semana') return { first: monday(focus), last: addDays(monday(focus), 6) };
  if (scale === 'mes') {
    const first = monday(new Date(focus.getFullYear(), focus.getMonth(), 1, 12));
    const end = new Date(focus.getFullYear(), focus.getMonth() + 1, 0, 12);
    return { first, last: addDays(monday(end), 6) };
  }
  return { first: new Date(focus.getFullYear(), 0, 1, 12), last: new Date(focus.getFullYear(), 11, 31, 12) };
}

/** The next or previous period of the same scale. */
export function move(scale: Scale, focus: Date, step: 1 | -1): Date {
  if (scale === 'dia') return addDays(focus, step);
  if (scale === 'semana') return addDays(focus, 7 * step);
  if (scale === 'mes') return new Date(focus.getFullYear(), focus.getMonth() + step, 1, 12);
  return new Date(focus.getFullYear() + step, 0, 1, 12);
}

export function title(scale: Scale, focus: Date): string {
  if (scale === 'dia') return focus.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (scale === 'semana') {
    const { first, last } = period('semana', focus);
    return `${first.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} – ${last.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }
  if (scale === 'mes') return focus.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  return String(focus.getFullYear());
}

/** «Trabajo · iCloud · CodeIA»: whose calendar, which account and which scope. */
export const origin = (item: CalendarOrigin) => [item.calendar, item.account, item.scope?.name].filter(Boolean).join(' · ');

/** The events of each local day (an event of several days is on each of them). */
function byDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const days = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const start = new Date(event.start), end = new Date(Math.max(new Date(event.end).getTime() - 1, start.getTime()));
    for (let day = atNoon(start); ymd(day) <= ymd(end); day = addDays(day, 1)) days.set(ymd(day), [...(days.get(ymd(day)) ?? []), event]);
  }
  return days;
}

/** The time an event shows on a day: an event of several days says it goes on, or until when. */
export function timeOn(event: CalendarEvent, day: Date, long = false): string {
  if (event.allDay) return 'Todo el día';
  const starts = ymd(new Date(event.start)) === ymd(day), ends = ymd(new Date(Math.max(new Date(event.end).getTime() - 1, new Date(event.start).getTime()))) === ymd(day);
  if (starts && ends) return long ? `${hourMinute(event.start)}–${hourMinute(event.end)}` : hourMinute(event.start);
  if (starts) return long ? `desde ${hourMinute(event.start)}` : hourMinute(event.start);
  return ends ? `hasta ${hourMinute(event.end)}` : 'Continúa';
}

function Chip({ event, day, discreet, clash, onOpen }: { event: CalendarEvent; day: Date; discreet: boolean; clash: boolean; onOpen: (id: string) => void }) {
  const from = origin(event);
  return <button type="button" onClick={() => onOpen(event.id)} className={`cal-chip${clash ? ' clash' : ''}`} title={discreet ? undefined : `${event.title}${from ? ` · ${from}` : ''}`}
    style={event.scope?.color ? { borderColor: event.scope.color } : undefined}>
    <small>{timeOn(event, day)}</small> {discreet ? '•••' : event.title}
  </button>;
}

/** The calendar views of the agenda: a day (each event with where it comes from), a week, a month or a year
 * (the number of events of each day). Pressing a day opens it. */
export function CalendarViews({ scale, focus, agenda, discreet, onDay, onMonth, onOpen }: {
  scale: Scale; focus: Date; agenda: Agenda; discreet: boolean; onDay: (day: Date) => void; onMonth: (month: Date) => void; onOpen: (id: string) => void;
}) {
  const clashing = new Set(agenda.overlaps.flat());
  const days = byDay(agenda.events);
  const today = ymd(new Date());
  if (scale === 'dia') {
    const events = days.get(ymd(focus)) ?? [];
    return events.length ? <ul className="agenda-list">{events.map(event => <li key={event.id} className={clashing.has(event.id) ? 'agenda-clash' : undefined}>
      <span className="agenda-time">{timeOn(event, focus, true)}</span>
      <span className="agenda-what"><button type="button" className="agenda-open" onClick={() => onOpen(event.id)}><span>{discreet ? '•••' : event.title}</span>{!discreet && event.location && <small className="muted"> · {event.location}</small>}</button>
        {!discreet && origin(event) && <small className="agenda-origin"><i style={{ background: event.scope?.color ?? undefined }}/>{origin(event)}</small>}</span>
      {clashing.has(event.id) && <span className="chip warn">Solape</span>}</li>)}</ul> : <p className="muted">Nada en el calendario este día.</p>;
  }
  if (scale === 'año') {
    return <div className="cal-year">{Array.from({ length: 12 }, (_, month) => {
      const first = new Date(focus.getFullYear(), month, 1, 12);
      const { first: from, last } = period('mes', first);
      const cells: Date[] = [];
      for (let day = from; ymd(day) <= ymd(last); day = addDays(day, 1)) cells.push(day);
      return <div key={month} className="cal-mini">
        <button type="button" className="cal-mini-title" onClick={() => onMonth(first)}>{first.toLocaleDateString('es-ES', { month: 'long' })}</button>
        <div className="cal-mini-grid">{WEEKDAYS.map(w => <small key={w}>{w[0]}</small>)}
          {cells.map(day => {
            const count = days.get(ymd(day))?.length ?? 0;
            return <button type="button" key={ymd(day)} disabled={day.getMonth() !== month} onClick={() => onDay(day)}
              className={`${count ? 'busy' : ''}${ymd(day) === today ? ' today' : ''}`} title={count ? `${count} ${count === 1 ? 'evento' : 'eventos'}` : undefined}
              aria-label={`${day.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })}${count ? `, ${count} ${count === 1 ? 'evento' : 'eventos'}` : ''}`}>
              {day.getMonth() === month ? day.getDate() : ''}</button>;
          })}</div>
      </div>;
    })}</div>;
  }
  const { first, last } = period(scale, focus);
  const cells: Date[] = [];
  for (let day = first; ymd(day) <= ymd(last); day = addDays(day, 1)) cells.push(day);
  return <div className={`cal-grid ${scale}`}>
    {WEEKDAYS.map(w => <div key={w} className="cal-head">{w}</div>)}
    {cells.map(day => {
      const events = days.get(ymd(day)) ?? [];
      const outside = scale === 'mes' && day.getMonth() !== focus.getMonth();
      const shown = scale === 'mes' ? events.slice(0, 3) : events;
      return <div key={ymd(day)} className={`cal-cell${outside ? ' outside' : ''}${ymd(day) === today ? ' today' : ''}`}>
        <button type="button" className="cal-day" onClick={() => onDay(day)}
          aria-label={`${day.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}${events.length ? `, ${events.length} ${events.length === 1 ? 'evento' : 'eventos'}` : ''}`}>{day.getDate()}</button>
        {shown.map(event => <Chip key={event.id} event={event} day={day} discreet={discreet} clash={clashing.has(event.id)} onOpen={onOpen}/>)}
        {events.length > shown.length && <button type="button" className="cal-more" onClick={() => onDay(day)}>+{events.length - shown.length} más</button>}
      </div>;
    })}
  </div>;
}
