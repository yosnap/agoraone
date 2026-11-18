import { useState, type FormEvent } from 'react';
import { getCentralView } from '../api/central';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { CentralProblem } from './central-connect';
import { addDays, agendaDays, agendaRangeProblem, dayHeading, madridDay, timeLabel, useCentralRead, viewKey } from './use-central-view';

/** «Agenda de Central»: the events of the Google calendars chosen in Central, between two days of Madrid (at most 62),
 * with the client or project each one is linked to. It is not AgoraOne's own Agenda, which stays as it is. In discreet
 * mode, as AgoraOne's Agenda, the title shows «•••» and the place, the client and the project are not shown. */
export function CentralAgenda({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  const [range, setRange] = useState(() => { const today = madridDay(new Date()); return { desde: today, hasta: addDays(today, 13) }; });
  const [typed, setTyped] = useState(range);
  const problem = agendaRangeProblem(typed.desde, typed.hasta);
  const read = useCentralRead(viewKey('agenda', range), () => getCentralView('agenda', range));
  const submit = (event: FormEvent) => { event.preventDefault(); if (!problem) setRange(typed); };
  const days = read.data ? agendaDays(read.data.events, range.desde) : [];
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
          <ul className="central-events">{events.map(({ event: e, until }, index) => <li key={`${e.start}-${index}`}>
            <span className="central-event-time">{e.allDay ? 'Todo el día' : timeLabel(e.start)}
              {until ? <small className="muted">{until}</small> : !e.allDay && e.end && <small className="muted">hasta {timeLabel(e.end)}</small>}</span>
            <div>
              <strong>{discreet ? '•••' : e.summary ?? 'Sin título'}</strong>{e.calendar && <span className="chip">{e.calendar}</span>}
              {!discreet && e.location && <small className="muted">{e.location}</small>}
              {!discreet && (e.client || e.project) && <small>{[e.client && `Cliente: ${e.client}`, e.project && `Proyecto: ${e.project}`].filter(Boolean).join(' · ')}</small>}
            </div>
          </li>)}</ul>
        </article>)}
      </>}
  </>;
}
