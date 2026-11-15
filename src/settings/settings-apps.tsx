import { useRef, useState } from 'react';
import { getApps, putAllowedApps, type InstalledApp } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';

/** The apps Watson may open without asking (1.5): picked from the ones installed on this computer. Any
 * other installed app can still be opened, after a «sí»; nothing is ever closed or changed. */
export function AppsSettingsCard() {
  const [apps, setApps] = useState<InstalledApp[] | null>(null);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const asked = useRef(false);
  if (!asked.current) { asked.current = true; void getApps().then(found => { setApps(found.apps); setAllowed(found.allowed); }).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer las aplicaciones.')); }
  const toggle = async (id: string) => {
    const next = allowed.includes(id) ? allowed.filter(a => a !== id) : [...allowed, id];
    setError('');
    try { setAllowed((await putAllowedApps(next)).allowed); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  const wanted = filter.trim().toLowerCase();
  const shown = (apps ?? []).filter(app => allowed.includes(app.id) || (wanted && [app.name, ...(app.aliases ?? [])].some(n => n.toLowerCase().includes(wanted)))).slice(0, 40);
  return <article className="card" aria-labelledby="apps-title">
    <div className="card-head"><h2 id="apps-title">Aplicaciones que Watson puede abrir</h2>
      {apps && <span className="status-badge good">{allowed.length} permitidas</span>}</div>
    <p>Di o escribe «abre Notas»: las apps marcadas se abren sin preguntar; cualquier otra de este equipo, solo después de que digas «sí». Watson solo abre aplicaciones: nunca las cierra ni cambia nada.</p>
    {!apps && !error ? <Loading label="Buscando las aplicaciones instaladas" lines={2}/> : apps && <>
      <label className="field">Buscar una aplicación para añadirla<input value={filter} onChange={event => setFilter(event.target.value)} placeholder={`Entre ${apps.length} instaladas…`}/></label>
      <ul className="apps-list">{shown.map(app => <li key={app.id}><label className="check">
        <input type="checkbox" checked={allowed.includes(app.id)} onChange={() => void toggle(app.id)}/> {app.name}
        {app.aliases?.length ? <small className="muted"> ({app.aliases.join(', ')})</small> : null}</label></li>)}</ul>
      {!shown.length && <p className="muted">Ninguna permitida todavía: busca una arriba.</p>}
    </>}
    {error && <LoadError message={error}/>}
  </article>;
}
