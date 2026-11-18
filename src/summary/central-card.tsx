import { useRef, useState } from 'react';
import { getCentral, refreshCentral, type CentralState } from '../api/core';
import { LoadError } from '../ui/load-state';

const serverTone: Record<string, string> = { green: 'good', amber: 'waiting', red: 'bad', grey: 'paused' };
const serverLabel: Record<string, string> = { green: 'Bien', amber: 'Atención', red: 'Problema', grey: 'Sin datos' };

/** Clients and servers from Central (read-only snapshot, refreshed every half hour). */
export function CentralCard({ discreet }: { discreet: boolean }) {
  const [state, setState] = useState<CentralState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const asked = useRef(false);
  if (!asked.current) { asked.current = true; getCentral().then(setState).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo leer Central.')); }
  const refresh = async () => {
    setBusy(true); setError('');
    try { setState(await refreshCentral()); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo leer Central.'); } finally { setBusy(false); }
  };
  const snapshot = state?.snapshot;
  const active = (snapshot?.clients ?? []).filter(c => c.projects.some(p => p.status === 'ACTIVE' || p.status === 'MAINTENANCE'));
  return <article className="card summary-wide" aria-labelledby="central-title">
    <div className="card-head"><h2 id="central-title">Clientes y servidores · Central</h2>
      <button type="button" className="button" disabled={busy || !state?.configured} onClick={() => void refresh()}>{busy ? 'Leyendo…' : 'Actualizar'}</button></div>
    {state && !state.configured ? <p className="muted">Central no está conectado: conéctalo en Ajustes › Central.</p> : !snapshot ? <p className="muted">Aún no se ha leído Central{state?.problem ? '' : ': se lee cada media hora o con «Actualizar»'}.</p> : <>
      <p className="muted">{snapshot.clients.length} clientes ({active.length} con proyectos activos) · {snapshot.servers.length} servidores · leído {new Date(snapshot.fetchedAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}. Solo lectura.</p>
      <div className="summary-split">
        <div><h3>Servidores</h3><ul className="central-list">{snapshot.servers.map(server => <li key={server.name}>
          <span>{discreet ? 'Servidor' : server.name}{server.provider && !discreet ? <small className="muted"> · {server.provider}</small> : null}</span>
          <span className={`status-badge ${serverTone[server.status ?? 'grey'] ?? 'paused'}`}>{serverLabel[server.status ?? 'grey'] ?? server.status}</span></li>)}</ul></div>
        <div><h3>Clientes con proyectos activos</h3>{active.length === 0 ? <p className="muted">Ninguno.</p> : <ul className="central-list">{active.slice(0, 12).map(client => <li key={client.name}>
          <span>{discreet ? 'Cliente' : client.name}</span>
          <small className="muted">{client.projects.filter(p => p.status === 'ACTIVE' || p.status === 'MAINTENANCE').length} activos{client.domains.length ? '' : ' · sin dominio para el correo'}</small></li>)}</ul>}</div>
      </div>
    </>}
    {state?.notice && <p className="muted">{state.notice}</p>}
    {(error || state?.problem) && <LoadError message={error || state?.problem || ''}/>}
  </article>;
}
