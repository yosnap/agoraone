import { useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { createEvent, createReminder, getCalendars, type CalendarInfo } from '../api/core';
import { LoadError } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';

type Clash = { title: string; start: string; end: string };
const two = (n: number) => String(n).padStart(2, '0');
/** A date as the value of a datetime-local input, in the user's own time. */
export const localInput = (date: Date) => `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
export const hourMinute = (iso: string) => new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

/** A new event or reminder, created only when the user presses the button; if the event overlaps others,
 * they are listed and it is created only with a second, explicit yes. Nothing is ever deleted. */
export function EventForm({ initial, inboxId, chatId, discreet = false, onDone, onCancel }: {
  initial?: { title?: string; start?: Date; notes?: string }; inboxId?: number; chatId?: number; discreet?: boolean; onDone: (note: string) => void; onCancel: () => void;
}) {
  const start = initial?.start ?? new Date(Math.ceil(Date.now() / 1800000) * 1800000);
  const [kind, setKind] = useState<'event' | 'reminder'>('event');
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [calendarId, setCalendarId] = useState('');
  const [form, setForm] = useState({ title: initial?.title ?? '', start: localInput(start), end: localInput(new Date(start.getTime() + 3600000)),
    allDay: false, location: '', notes: initial?.notes ?? '' });
  const [clashes, setClashes] = useState<Clash[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    getCalendars().then(found => { setCalendars(found.calendars.filter(c => c.writable && !c.hidden)); if (found.problem) setError(found.problem); })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer los calendarios.'));
  }
  const options = calendars.filter(c => c.kind === kind);
  const save = async (overlapOk: boolean) => {
    setBusy(true); setError('');
    try {
      const calendar = calendarId && options.some(c => c.id === calendarId) ? calendarId : null;
      if (kind === 'reminder') {
        await createReminder({ calendarId: calendar, title: form.title.trim(), due: form.start ? new Date(form.start).toISOString() : null, notes: form.notes || null, inboxId: inboxId ?? null, chatId: chatId ?? null });
        onDone(`Recordatorio «${form.title.trim()}» creado.`);
      } else {
        const made = await createEvent({ calendarId: calendar, title: form.title.trim(), start: new Date(form.start).toISOString(), end: new Date(form.end).toISOString(),
          allDay: form.allDay, location: form.location || null, notes: form.notes || null, overlapOk, inboxId: inboxId ?? null, chatId: chatId ?? null });
        onDone(`Evento «${form.title.trim()}» creado${made.clashes ? `; se solapa con ${made.clashes}` : ''}.`);
      }
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409 && Array.isArray(failure.data?.clashes)) setClashes(failure.data.clashes as Clash[]);
      else setError(failure instanceof Error ? failure.message : 'No se pudo crear.');
    } finally { setBusy(false); }
  };
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => { setForm({ ...form, [key]: event.target.value }); setClashes(null); };
  return <form className="card event-form" aria-label="Nuevo evento o recordatorio" onSubmit={event => { event.preventDefault(); void save(false); }}>
    <div className="segmented" role="group" aria-label="Tipo">{(['event', 'reminder'] as const).map(k =>
      <button key={k} type="button" aria-pressed={kind === k} onClick={() => { setKind(k); setClashes(null); }}>{k === 'event' ? 'Evento' : 'Recordatorio'}</button>)}</div>
    <div className="event-form-grid">
      <label className="field">Título<input value={form.title} onChange={set('title')} maxLength={200} required autoFocus/></label>
      <label className="field">{kind === 'event' ? 'Calendario' : 'Lista'}<ModernSelect value={calendarId}
        options={[{ value: '', label: 'El predeterminado' }, ...options.map(c => ({ value: c.id, label: `${c.title} · ${c.account}` }))]} onChange={setCalendarId}/></label>
      <label className="field">{kind === 'event' ? 'Empieza' : 'Vence'}<input type="datetime-local" value={form.start} onChange={set('start')} required={kind === 'event'}/></label>
      {kind === 'event' && <label className="field">Termina<input type="datetime-local" value={form.end} onChange={set('end')} required/></label>}
      {kind === 'event' && <label className="field">Lugar<input value={form.location} onChange={set('location')} maxLength={300}/></label>}
    </div>
    {kind === 'event' && <label className="check"><input type="checkbox" checked={form.allDay} onChange={event => setForm({ ...form, allDay: event.target.checked })}/> Todo el día</label>}
    <label className="field">Notas<textarea value={form.notes} onChange={set('notes')} rows={3} maxLength={4000}/></label>
    {clashes && <div className="calendar-clash" role="alert"><strong>Se solapa con:</strong>
      <ul>{clashes.map((c, i) => <li key={i}>{discreet ? '•••' : c.title} · {hourMinute(c.start)}–{hourMinute(c.end)}</li>)}</ul></div>}
    {error && <LoadError message={error}/>}
    <div className="field-row">
      {clashes ? <button type="button" className="button primary" disabled={busy} onClick={() => void save(true)}>Crear de todos modos</button>
        : <button type="submit" className="button primary" disabled={busy || !form.title.trim()}>{busy ? 'Creando…' : kind === 'event' ? 'Crear el evento' : 'Crear el recordatorio'}</button>}
      <button type="button" className="button" disabled={busy} onClick={onCancel}>Cancelar</button>
    </div>
  </form>;
}
