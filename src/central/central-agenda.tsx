import { useState, type FormEvent } from 'react';
import { getCentralView, type CentralEvent } from '../api/central';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { CentralProblem } from './central-connect';
import { addDays, agendaRangeProblem, dayHeading, madridDay, timeLabel, useCentralRead, viewKey } from './use-central-view';

const HIDDEN = 'Lugar oculto en modo discreto';

/** The events of the range grouped by their day in Madrid, in Central's order. */
function byDay(events: CentralEvent[]) {
  const days = new Map<string, CentralEvent[]>();
  for (const event of events) {
    const at = event.start ? new Date(event.start) : null;
    if (!at || Number.isNaN(at.getTime())) continue;
    const day = madridDay(at);
    days.set(day, [...(days.get(day) ?? []), event]);
  }
  return [...days.entries()];
}

/** «Agenda de Central»: the events of the Google calendars chosen in Central, between two days of Madrid (at most 62),
 * with the client or project each one is linked to. It is not AgoraOne's own Agenda, which stays as it is. */
export function CentralAgenda({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  const [range, setRange] = useState(() => { const today = madridDay(new Date()); return { desde: today, hasta: addDays(today, 13) }; });
  const [typed, setTyped] = useState(range);
  const problem = agendaRangeProblem(typed.desde, typed.hasta);
  const read = useCentralRead(viewKey('agenda', range), () => getCentralView('agenda', range));
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem) setRange(typed); };
  const days = read.data ? byDay(read.data.events) : [];
  return <>
    <p className="muted">Los calendarios de Google conectados en Central, en hora de Madrid. Es otra agenda: la de AgoraOne no cambia.</p>
    <form className="field-row central-filters" onSubmit={submit}>
      <label className="field">Desde<input type="date" value={typed.desde} onChange={event => setTyped({ ...typed, desde: event.target.value })} required/></label>
      <label className="field">Hasta<input type="date" value={typed.hasta} onChange={event => setTyped({ ...typed, hasta: event.target.value })} required/></label>
      <div className="actions central-actions"><button type="submit" className="button" disabled={Boolean(problem)}>Ver</button></div>
    </form>
    {problem && <p className="notice" role="status">{problem}</p>}
    {read.failure ? <CentralProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/>
      : !read.data ? <Loading label="Leyendo la agenda de Central" lines={4}/>
      : <>
        {read.data.errors.map(error => <p key={error} className="notice" role="status">{error}</p>)}
        {!days.length ? <p className="muted">Nada en la agenda de Central para estos días.</p> : days.map(([day, events]) => <article key={day} className="card central-record">
          <h3 className="central-day">{dayHeading(day)}</h3>
          <ul className="central-events">{events.map((e, index) => <li key={`${e.start}-${index}`}>
            <span className="central-event-time">{e.allDay ? 'Todo el día' : <>{timeLabel(e.start)}{e.end && <small className="muted">hasta {timeLabel(e.end)}</small>}</>}</span>
            <div>
              <strong>{e.summary ?? 'Sin título'}</strong>{e.calendar && <span className="chip">{e.calendar}</span>}
              {e.location && <small className="muted">{discreet ? HIDDEN : e.location}</small>}
              {(e.client || e.project) && <small>{[e.client && `Cliente: ${e.client}`, e.project && `Proyecto: ${e.project}`].filter(Boolean).join(' · ')}</small>}
            </div>
          </li>)}</ul>
        </article>)}
      </>}
  </>;
}
