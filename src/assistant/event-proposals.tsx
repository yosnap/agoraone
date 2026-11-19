import { useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { createEvent, dismissProposal, getCalendars, type CalendarInfo } from '../api/core';
import { ModernSelect } from '../ui/modern-select';

export type ProposedEvent = { title: string; start: string; end: string; allDay: boolean; location: string | null; notes: string | null; calendar: string | null };
type EventProposal = { id: string; event: ProposedEvent; state: 'open' | 'busy' | 'clash' | 'made' | 'dismissed'; result?: string };
const when = (iso: string, allDay: boolean) => new Date(iso).toLocaleString('es-ES', allDay ? { dateStyle: 'full' } : { dateStyle: 'full', timeStyle: 'short' });

/** Events Watson proposed (1.7): shown whole, created with «Crear el evento» through the calendar's own route,
 * which warns of clashes first. Nothing is written until then. */
export function useEventProposals() {
  const [list, setList] = useState<EventProposal[]>([]);
  const settle = (id: string, change: Partial<EventProposal>) => setList(all => all.map(p => p.id === id ? { ...p, ...change } : p));
  const create = async (proposal: EventProposal, calendarId: string | null, overlapOk = false) => {
    settle(proposal.id, { state: 'busy' });
    const { title, start, end, allDay, location, notes } = proposal.event;
    try {
      await createEvent({ calendarId, title, start, end, allDay, location, notes, overlapOk });
      void dismissProposal(proposal.id).catch(() => undefined);
      settle(proposal.id, { state: 'made', result: `Evento «${title}» creado.` });
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) settle(proposal.id, { state: 'clash', result: failure.message });
      else settle(proposal.id, { state: 'open', result: failure instanceof Error ? failure.message : 'No se pudo crear el evento.' });
    }
  };
  const dismiss = (proposal: EventProposal) => { settle(proposal.id, { state: 'dismissed', result: 'Evento descartado: no se ha creado nada.' }); void dismissProposal(proposal.id).catch(() => undefined); };
  return { list, create, dismiss, add: (id: string, event: ProposedEvent) => setList(all => all.some(p => p.id === id) ? all : [...all, { id, event, state: 'open' }]), clear: () => setList([]) };
}

function EventCard({ proposal, state, calendars }: { proposal: EventProposal; state: ReturnType<typeof useEventProposals>; calendars: CalendarInfo[] }) {
  const wanted = (proposal.event.calendar ?? '').toLowerCase();
  const [calendarId, setCalendarId] = useState(() => (calendars.find(c => wanted && (c.title.toLowerCase().includes(wanted) || c.account.toLowerCase().includes(wanted))) ?? calendars[0])?.id ?? '');
  const open = proposal.state === 'open' || proposal.state === 'busy' || proposal.state === 'clash';
  return <article className="card note-proposal" aria-label="Evento propuesto">
    <strong>Evento propuesto: {proposal.event.title}</strong>
    <small>{when(proposal.event.start, proposal.event.allDay)}{proposal.event.location ? ` · ${proposal.event.location}` : ''}</small>
    {proposal.event.notes && <small className="muted">{proposal.event.notes}</small>}
    {open && <>
      {calendars.length > 0 && <label className="field">Calendario<ModernSelect value={calendarId} onChange={setCalendarId} options={calendars.map(c => ({ value: c.id, label: `${c.title} · ${c.account}` }))}/></label>}
      <div className="inbox-actions">
        {proposal.state === 'clash'
          ? <button type="button" className="button primary" onClick={() => void state.create(proposal, calendarId || null, true)}>Crear igualmente</button>
          : <button type="button" className="button primary" disabled={proposal.state === 'busy'} onClick={() => void state.create(proposal, calendarId || null)}>{proposal.state === 'busy' ? 'Creando…' : 'Crear el evento'}</button>}
        <button type="button" className="button" onClick={() => state.dismiss(proposal)}>Descartar</button>
      </div>
    </>}
    {proposal.result && <small className={proposal.state === 'made' ? 'ok-note' : 'muted'} role="status">{proposal.result}</small>}
  </article>;
}

export function EventProposals({ state }: { state: ReturnType<typeof useEventProposals> }) {
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const asked = useRef(false);
  if (!asked.current && state.list.length) { asked.current = true; void getCalendars().then(found => setCalendars(found.calendars.filter(c => c.kind === 'event' && c.writable))).catch(() => undefined); }
  if (!state.list.length) return null;
  return <>{state.list.map(proposal => <EventCard key={proposal.id} proposal={proposal} state={state} calendars={calendars}/>)}</>;
}
