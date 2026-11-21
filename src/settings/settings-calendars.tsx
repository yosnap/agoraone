import { useRef, useState } from 'react';
import { useAssistantName } from '../assistant/assistant-name';
import { askCalendarAccess, changeCalendar, getCalendars, getCalendarStatus, getScopes, type CalendarInfo, type CalendarStatus, type Level, type Scope } from '../api/core';
import { LoadError } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { onlyHereLabel } from '../ui/platform';

const levelsFor = (assistant: string): { value: Level; label: string }[] => [
  { value: 'normal', label: `Normal: ${assistant} lo ve` }, { value: 'local_only', label: onlyHereLabel }, { value: 'private', label: 'Privado' }];

/** The macOS calendars and reminders lists: permission, and each one's scope and confidentiality (only the
 * normal ones reach the assistant and its model); a hidden one leaves the agenda. */
export function CalendarsSettingsCard() {
  const levels = levelsFor(useAssistantName());
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [calendars, setCalendars] = useState<CalendarInfo[] | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [error, setError] = useState('');
  // Hidden calendars stay out of the list until asked for; one hidden just now stays in view so it can be undone.
  const [showHidden, setShowHidden] = useState(false);
  const [justHidden, setJustHidden] = useState<Set<string>>(new Set());
  const asked = useRef(false);
  const load = async () => {
    setError('');
    try {
      const found = await getCalendarStatus(); setStatus(found);
      if (found.events === 'granted' || found.reminders === 'granted') {
        const [list, scopeList] = await Promise.all([getCalendars(), getScopes()]);
        setCalendars(list.calendars); setScopes(scopeList.scopes);
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo leer el calendario.'); }
  };
  if (!asked.current) { asked.current = true; void load(); }
  const change = async (calendar: CalendarInfo, patch: Partial<Pick<CalendarInfo, 'scopeId' | 'confidentiality' | 'hidden'>>) => {
    const next = { ...calendar, ...patch };
    if (patch.hidden) setJustHidden(current => new Set(current).add(calendar.id));
    setCalendars(current => current?.map(c => c.id === calendar.id ? next : c) ?? null);
    try { await changeCalendar(calendar.id, { scopeId: next.scopeId, confidentiality: next.confidentiality, hidden: next.hidden }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); void load(); }
  };
  const granted = status?.events === 'granted';
  const hiddenCount = calendars?.filter(c => c.hidden && !justHidden.has(c.id)).length ?? 0;
  const shown = calendars?.filter(c => showHidden || !c.hidden || justHidden.has(c.id));
  return <article className="card" aria-labelledby="calendars-title">
    <div className="card-head"><h2 id="calendars-title">Calendarios</h2>
      {status && <span className={`status-badge ${granted ? 'good' : 'paused'}`}>{granted ? 'Con permiso' : status.events === 'unavailable' ? 'No disponible' : 'Sin permiso'}</span>}</div>
    <p>Los calendarios y recordatorios de macOS. AgoraOne los lee para tu agenda y solo crea eventos o recordatorios cuando lo confirmas; nunca borra.</p>
    {status && !granted && status.events !== 'unavailable' && <p><button type="button" className="button primary"
      onClick={() => void askCalendarAccess().then(found => { setStatus(found); void load(); }).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo pedir el permiso.'))}>Dar permiso</button></p>}
    {status?.events === 'denied' && <p className="muted">Si lo denegaste, se cambia en Ajustes del Sistema › Privacidad y seguridad › Calendarios y Recordatorios.</p>}
    {shown && <ul className="calendar-settings">{shown.map(calendar => <li key={calendar.id}>
      <span className="calendar-name">{calendar.title}<small className="muted"> · {calendar.kind === 'event' ? 'Calendario' : 'Recordatorios'} · {calendar.account}</small></span>
      <ModernSelect value={calendar.scopeId === null ? '' : String(calendar.scopeId)} options={[{ value: '', label: 'Sin ámbito' }, ...scopes.map(s => ({ value: String(s.id), label: s.name }))]}
        onChange={value => void change(calendar, { scopeId: value ? Number(value) : null })}/>
      <ModernSelect value={calendar.confidentiality} options={levels} onChange={value => void change(calendar, { confidentiality: value as Level })}/>
      <label className="check"><input type="checkbox" checked={calendar.hidden} onChange={event => void change(calendar, { hidden: event.target.checked })}/> Ocultar</label>
    </li>)}</ul>}
    {calendars && (hiddenCount > 0 || showHidden) && <p><button type="button" className="button" aria-expanded={showHidden}
      onClick={() => { setShowHidden(!showHidden); setJustHidden(new Set()); }}>
      {showHidden ? 'Esconder los ocultos' : `Mostrar ${hiddenCount === 1 ? 'el calendario oculto' : `los ${hiddenCount} calendarios ocultos`}`}</button></p>}
    {error && <LoadError message={error}/>}
  </article>;
}
