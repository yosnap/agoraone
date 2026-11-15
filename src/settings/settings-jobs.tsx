import { useRef, useState } from 'react';
import { getHermesCatalog } from '../api/client';
import { getJobsSettings, putJobsSettings } from '../api/core';
import { LoadError } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';

/** Trabajos: which Hermes profile is the central bot, the recipient a new commission («encargo») starts with. */
export function JobsSettingsCard() {
  const [central, setCentral] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<{ value: string; label: string }[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    Promise.all([getJobsSettings(), getHermesCatalog()]).then(([settings, catalog]) => {
      setCentral(settings.central);
      setProfiles(catalog.profiles.map(p => ({ value: p.name, label: p.name === 'default' ? `${p.label || 'Hermes principal'} (perfil raíz)` : p.label || p.name })));
    }).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer los ajustes de Trabajos.'));
  }
  const change = async (value: string) => {
    setError(''); setSaved('');
    try { setCentral((await putJobsSettings({ central: value })).central); setSaved('Bot central guardado.'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  const known = central !== null && profiles.some(p => p.value === central);
  return <article className="card" aria-labelledby="jobs-settings-title">
    <div className="card-head"><h2 id="jobs-settings-title">Trabajos</h2></div>
    <p>El bot central es el perfil de Hermes al que van los encargos si no eliges otro. Los recoge el despachador del kanban de Hermes, dentro de su gateway.</p>
    {central !== null && <label className="field">Bot central<ModernSelect value={known ? central : ''}
      options={[...(known ? [] : [{ value: '', label: `${central} (ya no existe)` }]), ...profiles]} onChange={value => value && void change(value)}/></label>}
    {saved && <p className="ok-note" role="status">{saved}</p>}
    {error && <LoadError message={error}/>}
  </article>;
}
