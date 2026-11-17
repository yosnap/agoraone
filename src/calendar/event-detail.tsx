import { useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { changeCalendarEvent, getCalendarEvent, type EventDetail } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { hourMinute, localInput } from './event-form';

type Clash = { title: string; start: string; end: string };
const statusLabel = { accepted: 'acepta', declined: 'no va', tentative: 'quizá', pending: 'sin responder' };
const when = (detail: EventDetail) => detail.allDay
  ? new Date(detail.start).toLocaleDateString('es-ES', { dateStyle: 'full' })
  : `${new Date(detail.start).toLocaleDateString('es-ES', { dateStyle: 'full' })}, ${hourMinute(detail.start)}–${hourMinute(detail.end)}`;

/** One event whole: the video-call link first, the place, who organises it and who comes, and its notes. The
 * user's own events (their calendar allows it, nobody else organises them) can be changed here: that occurrence
 * only, warning of clashes, refused if the event changed meanwhile; AgoraOne keeps the previous version and never
 * deletes an event. */
export function EventDetailCard({ id, discreet, onClose, onChanged }: { id: string; discreet: boolean; onClose: () => void; onChanged: (note: string) => void }) {
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<{ title: string; start: string; end: string; allDay: boolean; location: string; notes: string } | null>(null);
  const [clashes, setClashes] = useState<Clash[] | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef('');
  if (asked.current !== id) {
    asked.current = id;
    setDetail(null); setError(''); setForm(null); setClashes(null);
    void getCalendarEvent(id).then(found => { if (asked.current === id) setDetail(found); })
      .catch(failure => { if (asked.current === id) setError(failure instanceof Error ? failure.message : 'No se pudo leer el evento.'); });
  }
  const edit = (found: EventDetail) => setForm({ title: found.title, start: localInput(new Date(found.start)), end: localInput(new Date(found.end)),
    allDay: found.allDay, location: found.location ?? '', notes: found.notes ?? '' });
  const save = async (overlapOk: boolean) => {
    if (!detail || !form) return;
    setBusy(true); setError('');
    try {
      const done = await changeCalendarEvent({ id: detail.id, revision: detail.revision, title: form.title.trim(), start: new Date(form.start).toISOString(),
        end: new Date(form.end).toISOString(), allDay: form.allDay, location: form.location.trim() || null, notes: form.notes || null, overlapOk });
      onChanged(`Evento «${form.title.trim()}» cambiado${done.clashes ? `; se solapa con ${done.clashes}` : ''}. AgoraOne guarda cómo estaba antes.`);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409 && Array.isArray(failure.data?.clashes)) setClashes(failure.data.clashes as Clash[]);
      else setError(failure instanceof Error ? failure.message : 'No se pudo guardar el cambio.');
    } finally { setBusy(false); }
  };
  const set = (key: 'title' | 'start' | 'end' | 'location' | 'notes') => (event: { target: { value: string } }) => { setForm(f => f && { ...f, [key]: event.target.value }); setClashes(null); };
  return <article className="card event-detail" aria-label="Detalle del evento">
    <div className="card-head"><h2>{detail ? (discreet ? '•••' : detail.title) : 'Evento'}</h2>
      <button type="button" className="button" onClick={onClose}>Cerrar</button></div>
    {!detail && !error && <Loading label="Leyendo el evento" lines={3}/>}
    {detail && discreet && <p className="muted">Sal del modo discreto para ver el detalle.</p>}
    {detail && !discreet && !form && <>
      <p>{when(detail)}{detail.recurring ? ' · se repite' : ''}</p>
      {detail.links.filter(l => l.meeting).map(l => <p key={l.url}><a className="button primary" href={l.url} target="_blank" rel="noopener noreferrer">Unirse a {l.meeting}</a></p>)}
      {detail.location && <p><strong>Lugar:</strong> {detail.location}</p>}
      {detail.organizer && <p><strong>Organiza:</strong> {detail.organizer.me ? 'tú' : detail.organizer.name || detail.organizer.email}</p>}
      {detail.attendees.length > 0 && <div><strong>Asistentes</strong><ul className="event-people">{detail.attendees.map((p, n) =>
        <li key={n}>{p.me ? 'Tú' : p.name || p.email}{p.email && p.name && !p.me ? <small className="muted"> · {p.email}</small> : null} <small className="muted">({statusLabel[p.status]})</small></li>)}</ul></div>}
      {detail.links.some(l => !l.meeting) && <div><strong>Enlaces</strong><ul className="event-people">{detail.links.filter(l => !l.meeting).map(l =>
        <li key={l.url}><a href={l.url} target="_blank" rel="noopener noreferrer">{l.url}</a></li>)}</ul></div>}
      {detail.notes && <div><strong>Notas</strong><p className="event-notes">{detail.notes}</p></div>}
      {detail.editable
        ? <div className="field-row"><button type="button" className="button" onClick={() => edit(detail)}>Cambiar…</button></div>
        : <p className="muted">{detail.why}</p>}
    </>}
    {detail && !discreet && form && <form className="event-form" aria-label="Cambiar el evento" onSubmit={event => { event.preventDefault(); void save(false); }}>
      {detail.recurring && <p className="muted">Es un evento que se repite: solo se cambia esta vez.</p>}
      {detail.attendees.some(p => !p.me) && <p className="muted">Tiene invitados: tu calendario les avisará del cambio.</p>}
      <div className="event-form-grid">
        <label className="field">Título<input value={form.title} onChange={set('title')} maxLength={1000} required/></label>
        <label className="field">Empieza<input type="datetime-local" value={form.start} onChange={set('start')} required/></label>
        <label className="field">Termina<input type="datetime-local" value={form.end} onChange={set('end')} required/></label>
        <label className="field">Lugar<input value={form.location} onChange={set('location')} maxLength={2000}/></label>
      </div>
      <label className="check"><input type="checkbox" checked={form.allDay} onChange={event => { setForm({ ...form, allDay: event.target.checked }); setClashes(null); }}/> Todo el día</label>
      <label className="field">Notas<textarea value={form.notes} onChange={set('notes')} rows={5} maxLength={100000}/></label>
      {clashes && <div className="calendar-clash" role="alert"><strong>Se solapa con:</strong>
        <ul>{clashes.map((c, i) => <li key={i}>{c.title} · {hourMinute(c.start)}–{hourMinute(c.end)}</li>)}</ul></div>}
      <div className="field-row">
        {clashes ? <button type="button" className="button primary" disabled={busy || !form.title.trim() || !form.start || !form.end} onClick={() => void save(true)}>Guardar de todos modos</button>
          : <button type="submit" className="button primary" disabled={busy || !form.title.trim()}>{busy ? 'Guardando…' : 'Guardar los cambios'}</button>}
        <button type="button" className="button" disabled={busy} onClick={() => { setForm(null); setClashes(null); }}>Cancelar</button>
      </div>
    </form>}
    {error && <LoadError message={error}/>}
  </article>;
}
