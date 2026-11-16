import { useRef, useState } from 'react';
import { askCalendarAccess, getAgenda, getAgendaRange, getAlerts, getCalendarStatus, type Agenda, type AlertsView, type CalendarStatus } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { CalendarViews, move, origin, period, title, ymd, type Scale } from './calendar-views';
import { EventForm, hourMinute } from './event-form';
import './calendar.css';

type When = 'hoy' | 'mañana' | 'semana';
type Mode = 'lista' | 'calendario';
const dayName = (iso: string) => new Date(iso).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
const scales: { value: Scale; label: string }[] = [{ value: 'dia', label: 'Día' }, { value: 'semana', label: 'Semana' }, { value: 'mes', label: 'Mes' }, { value: 'año', label: 'Año' }];

/** The agenda: macOS's calendars and pending reminders as a list (today, tomorrow, the week) or as a calendar
 * (day, week, month, year), each event with its calendar, account and scope; the notices of now (missed calls,
 * meetings about to start, deadlines) in a narrower column at the right. New events and reminders are created
 * only from the form, after pressing its button. */
export function AgendaView({ discreet }: { discreet: boolean }) {
  const [mode, setMode] = useState<Mode>('lista');
  const [when, setWhen] = useState<When>('hoy');
  const [scale, setScale] = useState<Scale>('semana');
  const [focus, setFocus] = useState(() => new Date());
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [agenda, setAgenda] = useState<Agenda | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [reminders, setReminders] = useState<AlertsView | null>(null);
  const asked = useRef(false);
  const request = useRef(0);
  const load = async (next: { mode?: Mode; when?: When; scale?: Scale; focus?: Date } = {}) => {
    const view = { mode, when, scale, focus, ...next };
    const mine = ++request.current;
    setAgenda(null); setError('');
    try {
      const { first, last } = period(view.scale, view.focus);
      const found = view.mode === 'lista' ? await getAgenda(view.when) : await getAgendaRange(ymd(first), ymd(last));
      if (mine === request.current) setAgenda(found);
      void getAlerts().then(setReminders).catch(() => undefined);
    } catch (failure) { if (mine === request.current) setError(failure instanceof Error ? failure.message : 'No se pudo leer la agenda.'); }
  };
  const change = (next: { mode?: Mode; when?: When; scale?: Scale; focus?: Date }) => {
    if (next.mode) setMode(next.mode);
    if (next.when) setWhen(next.when);
    if (next.scale) setScale(next.scale);
    if (next.focus) setFocus(next.focus);
    void load(next);
  };
  const start = async () => {
    try { const found = await getCalendarStatus(); setStatus(found); if (found.events === 'granted') void load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo leer el calendario.'); }
  };
  if (!asked.current) { asked.current = true; void start(); void getAlerts().then(setReminders).catch(() => undefined); }
  const allow = async () => {
    setError('');
    try { const found = await askCalendarAccess(); setStatus(found); if (found.events === 'granted') void load(); else setError(found.events === 'undetermined' ? 'Responde al aviso de macOS y vuelve a pulsar «Dar permiso».'
      : 'macOS no ha dado permiso. Puedes darlo en Ajustes del Sistema › Privacidad y seguridad › Calendarios.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo pedir el permiso.'); }
  };
  const clashing = new Set(agenda?.overlaps.flat() ?? []);
  const days = new Map<string, Agenda['events']>();
  for (const event of agenda?.events ?? []) days.set(dayName(event.start), [...(days.get(dayName(event.start)) ?? []), event]);
  // In the calendar, the reminders due within the period shown; in the list, every pending one up to its end.
  const { first, last } = period(scale, focus);
  const dueReminders = (agenda?.reminders ?? []).filter(r => mode === 'lista' || (r.due && ymd(new Date(r.due)) >= ymd(first) && ymd(new Date(r.due)) <= ymd(last)));
  const notices = reminders && (reminders.morning || reminders.alerts.length > 0);
  return <section className="page agenda" aria-labelledby="agenda-title">
    <div className="eyebrow">AGENDA{discreet ? ' · MODO DISCRETO' : ''}</div>
    <h1 id="agenda-title">Agenda</h1>
    <p className="page-lead">Tus calendarios y recordatorios de macOS (iCloud, Google, Exchange…), con los solapes marcados. Los eventos y recordatorios se crean solo cuando lo confirmas; AgoraOne nunca borra ninguno.</p>
    <div className={`agenda-layout${notices ? '' : ' alone'}`}>
      <div className="agenda-main">
        {status === null && !error ? <Loading label="Leyendo el calendario"/> : status && status.events !== 'granted' ? <article className="card">
          <p>{status.events === 'unavailable' ? 'El calendario de macOS no está disponible aquí.' : 'AgoraOne necesita tu permiso para leer los calendarios y los recordatorios. macOS te lo preguntará una vez.'}</p>
          {status.events !== 'unavailable' && <p><button type="button" className="button primary" onClick={() => void allow()}>Dar permiso</button></p>}
        </article> : <>
          <div className="fiscal-bar agenda-bar">
            <div className="segmented" role="group" aria-label="Vista">{(['lista', 'calendario'] as Mode[]).map(m =>
              <button key={m} aria-pressed={mode === m} onClick={() => change({ mode: m })}>{m === 'lista' ? 'Lista' : 'Calendario'}</button>)}</div>
            {mode === 'lista' ? <div className="segmented" role="group" aria-label="Periodo">{(['hoy', 'mañana', 'semana'] as When[]).map(w =>
              <button key={w} aria-pressed={when === w} onClick={() => change({ when: w })}>{w === 'semana' ? 'Esta semana' : w[0].toUpperCase() + w.slice(1)}</button>)}</div>
              : <div className="segmented" role="group" aria-label="Escala">{scales.map(s =>
                <button key={s.value} aria-pressed={scale === s.value} onClick={() => change({ scale: s.value })}>{s.label}</button>)}</div>}
            <button type="button" className="button primary" onClick={() => { setAdding(true); setNote(''); }}>Nuevo evento o recordatorio</button>
          </div>
          {mode === 'calendario' && <div className="agenda-nav">
            <button type="button" className="button" aria-label="Anterior" onClick={() => change({ focus: move(scale, focus, -1) })}>‹</button>
            <button type="button" className="button" onClick={() => change({ focus: new Date() })}>Hoy</button>
            <button type="button" className="button" aria-label="Siguiente" onClick={() => change({ focus: move(scale, focus, 1) })}>›</button>
            <h2>{title(scale, focus)}</h2>
          </div>}
          {note && <p className="ok-note" role="status">{note}</p>}
          {adding && <EventForm discreet={discreet} onCancel={() => setAdding(false)} onDone={done => { setAdding(false); setNote(done); void load(); }}/>}
          {agenda?.overlaps.length ? <p className="fiscal-warning">{agenda.overlaps.length === 1 ? 'Hay un solape' : `Hay ${agenda.overlaps.length} solapes`}: los eventos marcados coinciden en el tiempo.</p> : null}
          {agenda === null && !error ? <Loading label="Leyendo la agenda" lines={4}/> : agenda && <>
            {agenda.problem && <p className="fiscal-warning">{agenda.problem}</p>}
            {mode === 'calendario' ? <CalendarViews scale={scale} focus={focus} agenda={agenda} discreet={discreet} onDay={day => change({ scale: 'dia', focus: day })}/>
              : agenda.events.length === 0 && !agenda.problem ? <p className="muted">Nada en el calendario {when === 'semana' ? 'esta semana' : when}.</p>
              : [...days.entries()].map(([day, events]) => <div key={day} className="agenda-day"><h2>{day}</h2>
                <ul className="agenda-list">{events.map(event => <li key={event.id} className={clashing.has(event.id) ? 'agenda-clash' : undefined}>
                  <span className="agenda-time">{event.allDay ? 'Todo el día' : `${hourMinute(event.start)}–${hourMinute(event.end)}`}</span>
                  <span className="agenda-what"><span>{discreet ? '•••' : event.title}{!discreet && event.location && <small className="muted"> · {event.location}</small>}</span>
                    {!discreet && origin(event) && <small className="agenda-origin"><i style={{ background: event.scope?.color ?? undefined }}/>{origin(event)}</small>}</span>
                  {clashing.has(event.id) && <span className="chip warn">Solape</span>}</li>)}</ul></div>)}
            <h2>{mode === 'lista' ? 'Recordatorios pendientes' : 'Recordatorios de este periodo'}</h2>
            {dueReminders.length === 0 ? <p className="muted">Ninguno.</p> : <ul className="agenda-list">{dueReminders.map(reminder => <li key={reminder.id}>
              <span className="agenda-time">{reminder.due ? `${new Date(reminder.due).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} ${hourMinute(reminder.due)}` : 'Sin fecha'}</span>
              <span className="agenda-what"><span>{discreet ? '•••' : reminder.title}</span>
                {!discreet && origin(reminder) && <small className="agenda-origin"><i style={{ background: reminder.scope?.color ?? undefined }}/>{origin(reminder)}</small>}</span></li>)}</ul>}
          </>}
        </>}
        {error && <LoadError message={error}/>}
      </div>
      {notices && <aside className="agenda-side" aria-label="Avisos de ahora">
        <h2>Avisos</h2>
        {reminders.morning && <p className="ok-note">{reminders.morning.body}</p>}
        {reminders.alerts.map(alert => <p key={alert.key} className="fiscal-warning"><strong>{discreet ? 'Aviso' : alert.title}</strong>{discreet ? '' : <><br/>{alert.body}</>}</p>)}
      </aside>}
    </div>
  </section>;
}
