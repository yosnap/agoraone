import { useRef, useState } from 'react';
import { askContactsAccess, getAlerts, openFullDiskAccess, putAlertSettings, type AlertSettings, type Level } from '../api/core';
import { LoadError } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';

const levels: { value: Level; label: string }[] = [
  { value: 'local_only', label: 'Solo en este Mac' }, { value: 'normal', label: 'Normal: Watson las ve' }, { value: 'private', label: 'Privado' }];
const toggles: { key: keyof AlertSettings; label: string }[] = [
  { key: 'missedCalls', label: 'Llamadas perdidas sin devolver' }, { key: 'meetings', label: 'Reuniones 15 minutos antes' },
  { key: 'commitments', label: 'Plazos de los correos (hoy y mañana)' }, { key: 'summary', label: 'Resumen de la mañana' }];

/** The reminders: which ones, the morning summary's time, quiet hours, the calls' confidentiality and the
 * two macOS permissions they use (Full Disk Access for the call history, Contacts for the names). */
export function AlertsSettingsCard() {
  const [chosen, setChosen] = useState<AlertSettings | null>(null);
  const [contacts, setContacts] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState('');
  const asked = useRef(false);
  const load = () => getAlerts().then(found => { setChosen(found.settings); setContacts(found.contacts); setProblems(found.problems); })
    .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer los avisos.'));
  if (!asked.current) { asked.current = true; void load(); }
  const save = async (changes: Partial<AlertSettings>) => {
    setError('');
    try { setChosen(await putAlertSettings(changes)); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  const callsBlocked = problems.some(p => p.includes('Acceso total al disco'));
  return <article className="card" aria-labelledby="alerts-title">
    <div className="card-head"><h2 id="alerts-title">Avisos</h2></div>
    <p>Notificaciones de macOS desde AgoraOne, cada una una sola vez y nunca en horas de silencio. Nada sale a Telegram.</p>
    {chosen && <>
      <div className="alerts-toggles">{toggles.map(t => <label key={t.key} className="check">
        <input type="checkbox" checked={Boolean(chosen[t.key])} onChange={event => void save({ [t.key]: event.target.checked })}/> {t.label}</label>)}</div>
      <div className="field-row">
        <label className="field">Resumen a las<input type="time" value={chosen.morning} onChange={event => event.target.value && void save({ morning: event.target.value })}/></label>
        <label className="field">Silencio desde<input type="time" value={chosen.quietFrom} onChange={event => event.target.value && void save({ quietFrom: event.target.value })}/></label>
        <label className="field">hasta<input type="time" value={chosen.quietTo} onChange={event => event.target.value && void save({ quietTo: event.target.value })}/></label>
      </div>
      <label className="field">Llamadas<ModernSelect value={chosen.callsLevel} options={levels} onChange={value => void save({ callsLevel: value as Level })}/></label>
    </>}
    <ul className="alerts-permissions">
      <li><span>Historial de llamadas{callsBlocked ? ': necesita «Acceso total al disco»' : ''}</span>
        {callsBlocked && <button type="button" className="button" onClick={() => void openFullDiskAccess().catch(() => undefined)}>Abrir Ajustes del Sistema</button>}</li>
      <li><span>Contactos (nombres de las llamadas): {contacts === 'granted' ? 'con permiso' : contacts === 'denied' ? 'denegado en Ajustes del Sistema' : contacts === 'unavailable' ? 'no disponible' : 'sin permiso'}</span>
        {contacts !== 'granted' && contacts !== 'denied' && contacts !== 'unavailable' && <button type="button" className="button"
          onClick={() => void askContactsAccess().then(found => setContacts(found.contacts)).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo pedir el permiso.'))}>Dar permiso</button>}</li>
    </ul>
    {callsBlocked && <p className="muted">En Ajustes del Sistema › Privacidad y seguridad › Acceso total al disco, añade AgoraOne y vuelve a abrirla. Solo se lee el historial, nunca se cambia.</p>}
    {error && <LoadError message={error}/>}
  </article>;
}
