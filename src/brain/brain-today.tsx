import { useRef, useState } from 'react';
import { getAgenda, getInbox, type Agenda, type InboxCounts, type InboxItem } from '../api/core';

const time = (stamp: string) => new Date(stamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

/** «Hoy» at the brain's side (1.4, after gbrain's day view): what comes next in the agenda, today's reminders
 * and what waits in the Inbox. Read-only, real data; discreet mode leaves out what is not normal. A part
 * that cannot be read (no calendar permission, no mail) simply does not show. */
export function BrainToday({ discreet }: { discreet: boolean }) {
  const [agenda, setAgenda] = useState<Agenda | null>(null);
  const [inbox, setInbox] = useState<{ items: InboxItem[]; counts: InboxCounts } | null>(null);
  const asked = useRef<boolean | null>(null);
  if (asked.current !== discreet) {
    asked.current = discreet;
    void getAgenda('hoy').then(setAgenda).catch(() => setAgenda(null));
    void getInbox('pending').then(setInbox).catch(() => setInbox(null));
  }
  const now = Date.now();
  const next = (agenda?.events ?? []).filter(event => event.allDay || new Date(event.end).getTime() > now).slice(0, 3);
  const reminders = agenda?.reminders ?? [];
  const waiting = (inbox?.items ?? []).filter(item => !discreet || item.confidentiality === 'normal');
  if (!next.length && !reminders.length && !waiting.length) return null;
  return <div className="brain-today">
    <h2>Hoy</h2>
    {next.length > 0 && <ul className="today-list" aria-label="Agenda de hoy">{next.map(event => <li key={event.id}>
      <span className="today-time">{event.allDay ? 'todo el día' : time(event.start)}</span><span>{event.title}</span>
    </li>)}</ul>}
    {reminders.length > 0 && <p className="today-line"><span className="lately-tag">recordatorios</span> {reminders.length} para hoy · {reminders.slice(0, 2).map(r => r.title).join(', ')}{reminders.length > 2 ? '…' : ''}</p>}
    {waiting.length > 0 && <>
      <p className="today-line"><span className="lately-tag">bandeja</span> {waiting.length} {waiting.length === 1 ? 'correo pide' : 'correos piden'} atención</p>
      <ul className="today-list today-mail">{waiting.slice(0, 3).map(item => <li key={item.id}><span>{item.summary ?? 'Correo sin resumen'}</span></li>)}</ul>
    </>}
  </div>;
}
