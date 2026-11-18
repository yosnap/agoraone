import { useRef, useState } from 'react';
import { useAssistantName } from '../assistant/assistant-name';
import { askContactsAccess, getAlerts, openFullDiskAccess, putAlertSettings, type AlertSettings, type Level } from '../api/core';
import { LoadError } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { isMac, onlyHereLabel } from '../ui/platform';

const levelsFor = (assistant: string): { value: Level; label: string }[] => [
  { value: 'local_only', label: onlyHereLabel }, { value: 'normal', label: `Normal: ${assistant} las ve` }, { value: 'private', label: 'Privado' }];
const toggles: { key: keyof AlertSettings; label: string }[] = [
  { key: 'missedCalls', label: 'Llamadas perdidas sin devolver' }, { key: 'meetings', label: 'Reuniones 15 minutos antes' },
  { key: 'commitments', label: 'Plazos de los correos (hoy y mañana)' }, { key: 'summary', label: 'Resumen de la mañana' }];

/** The reminders: which ones, the morning summary's time, quiet hours, the calls' confidentiality and the
 * two macOS permissions they use (Full Disk Access for the call history, Contacts for the names). */
export function AlertsSettingsCard() {
  const levels = levelsFor(useAssistantName());
  const [chosen, setChosen] = useState<AlertSettings | null>(null);
  const [contacts, setContacts] = useState('');
  const [callsProblem, setCallsProblem] = useState<string | null>(null);
  // The hours are kept here while typed and saved when the field is left (a half-typed hour is never sent).
  const [hours, setHours] = useState({ morning: '', quietFrom: '', quietTo: '' });
  const [error, setError] = useState('');
  const asked = useRef(false);
  const load = () => getAlerts().then(found => { setChosen(found.settings); setContacts(found.contacts); setCallsProblem(found.callsProblem);
    setHours({ morning: found.settings.morning, quietFrom: found.settings.quietFrom, quietTo: found.settings.quietTo }); })
    .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer los avisos.'));
  if (!asked.current) { asked.current = true; void load(); }
  const save = async (changes: Partial<AlertSettings>) => {
    setError('');
    try { setChosen(await putAlertSettings(changes)); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  const callsBlocked = callsProblem === 'permission';
  const hour = (key: keyof typeof hours, label: string) => <label className="field">{label}<input type="time" value={hours[key]}
    onChange={event => setHours({ ...hours, [key]: event.target.value })}
    onBlur={() => hours[key] && chosen && hours[key] !== chosen[key] && void save({ [key]: hours[key] })}/></label>;
  return <article className="card" aria-labelledby="alerts-title">
    <div className="card-head"><h2 id="alerts-title">Avisos</h2></div>
    <p>Notificaciones {isMac ? 'de macOS' : 'del sistema'} desde AgoraOne, cada una una sola vez y nunca en horas de silencio. Nada sale a Telegram.</p>
    {chosen && <>
      <div className="alerts-toggles">{toggles.map(t => <label key={t.key} className="check">
        <input type="checkbox" checked={Boolean(chosen[t.key])} onChange={event => void save({ [t.key]: event.target.checked })}/> {t.label}</label>)}</div>
      <div className="field-row">
        {hour('morning', 'Resumen a las')}{hour('quietFrom', 'Silencio desde')}{hour('quietTo', 'hasta')}
      </div>
      <label className="field">Llamadas<ModernSelect value={chosen.callsLevel} options={levels} onChange={value => void save({ callsLevel: value as Level })}/></label>
    </>}
    <ul className="alerts-permissions">
      <li><span>Historial de llamadas{callsBlocked ? ': necesita «Acceso total al disco»' : callsProblem === 'unavailable' ? ': solo disponible en macOS' : callsProblem === 'missing' ? ': este Mac no tiene historial' : callsProblem === 'unreadable' ? ': no se pudo leer' : ''}</span>
        {callsBlocked && <button type="button" className="button" onClick={() => void openFullDiskAccess().catch(() => undefined)}>Abrir Ajustes del Sistema</button>}</li>
      <li><span>Contactos (nombres de las llamadas): {contacts === 'granted' ? 'con permiso' : contacts === 'denied' ? 'denegado en Ajustes del Sistema' : contacts === 'unavailable' ? 'no disponible en este sistema' : 'sin permiso'}</span>
        {contacts === 'undetermined' && <button type="button" className="button"
          onClick={() => void askContactsAccess().then(found => setContacts(found.contacts)).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo pedir el permiso.'))}>Dar permiso</button>}</li>
    </ul>
    {callsBlocked && <p className="muted">En Ajustes del Sistema › Privacidad y seguridad › Acceso total al disco, añade AgoraOne y vuelve a abrirla. Solo se lee el historial, nunca se cambia.</p>}
    {error && <LoadError message={error}/>}
  </article>;
}
