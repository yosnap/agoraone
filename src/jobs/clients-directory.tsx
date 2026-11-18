import { useRef, useState } from 'react';
import { deleteClient, distinctClient, getClients, linkClient, sourceLabels, type ClientsDirectory, type DirectoryClient } from '../api/clients';
import { LoadError, Loading } from '../ui/load-state';
import { ClientForm } from './client-form';

const tone = { central: 'paused', local: 'good', ambos: 'good' } as const;

/** One list of the user's clients: Central's (read-only here) and the ones kept in AgoraOne, which the user creates,
 * changes and deletes (after confirming). A client kept here and one of Central's with the same tax id or address
 * show once; names that are only alike come up as a suggestion, linked only on «Enlazar». Nothing of Central's is
 * changed from here. In discreet mode nothing can be opened, so no address, phone or tax id is shown. */
export function ClientsDirectoryView({ discreet }: { discreet: boolean }) {
  const [data, setData] = useState<ClientsDirectory | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const asked = useRef(false);
  const request = useRef(0);
  const load = () => {
    const mine = ++request.current;
    getClients().then(found => { if (mine === request.current) { setData(found); setError(''); } })
      .catch(failure => { if (mine === request.current) setError(failure instanceof Error ? failure.message : 'No se pudieron leer los clientes.'); });
  };
  if (!asked.current) { asked.current = true; load(); }
  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true); setError(''); setNote('');
    try { await work(); setNote(done); load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo hacer el cambio.'); }
    finally { setBusy(false); setDeleting(null); }
  };
  if (!data) return error ? <LoadError message={error} onRetry={load}/> : <Loading label="Leyendo tus clientes" lines={3}/>;
  const actions = (client: DirectoryClient) => {
    if (discreet || client.localId === null) return <small className="muted">{client.localId === null ? 'Solo lectura (de Central)' : ''}</small>;
    const id = client.localId;
    if (deleting === id) return <span className="field-row" role="group" aria-label={`Confirmar eliminar ${client.name}`}>
      <small>Se borra de AgoraOne{client.source === 'ambos' ? '; en Central sigue igual' : ''}.</small>
      <button type="button" className="button danger" disabled={busy} onClick={() => void act(() => deleteClient(id), `«${client.name}» eliminado de tus clientes.`)}>Eliminar de verdad</button>
      <button type="button" className="button" disabled={busy} onClick={() => setDeleting(null)}>Cancelar</button>
    </span>;
    return <span className="actions">
      <button type="button" className="button" disabled={busy} onClick={() => { setEditing(id); setNote(''); }}>Editar</button>
      {client.source === 'ambos' && client.centralId && <button type="button" className="button" disabled={busy}
        onClick={() => void act(() => distinctClient(id, client.centralId!), `«${client.name}» ya no se une con tu cliente propio.`)}>Son distintos</button>}
      <button type="button" className="button danger" disabled={busy} onClick={() => setDeleting(id)}>Eliminar…</button>
    </span>;
  };
  return <div className="clients-directory">
    <div className="jobs-heading"><h2>Clientes</h2>
      {!discreet && editing === null && <button type="button" className="button primary" onClick={() => { setEditing('new'); setNote(''); }}>Nuevo cliente</button>}</div>
    <p className="muted">{!data.central.on ? 'Central está apagado en Ajustes › Módulos: ves solo los clientes que guardas en AgoraOne.'
      : !data.central.read ? 'Central no está conectado o aún no se ha leído (Ajustes › Central): ves solo los clientes que guardas en AgoraOne.'
      : 'Tus clientes de Central y los que guardas en AgoraOne, en una sola lista. Los de Central se cambian en Central.'}</p>
    {editing !== null && !discreet && <ClientForm key={editing} clientId={editing === 'new' ? null : editing} onCancel={() => setEditing(null)}
      onDone={saved => { setEditing(null); setNote(`«${saved.name}» guardado.`); load(); }}/>}
    {!discreet && data.suggestions.length > 0 && <ul className="install-list" aria-label="Posibles clientes repetidos">{data.suggestions.map(s =>
      <li key={`${s.localId}-${s.centralId}`} className="install-row">
        <span>¿Tu cliente «{s.localName}» es el mismo que «{s.centralName}» de Central?</span>
        <span className="actions">
          <button type="button" className="button" disabled={busy} onClick={() => void act(() => distinctClient(s.localId, s.centralId), 'Se quedan como clientes distintos.')}>Son distintos</button>
          <button type="button" className="button primary" disabled={busy} onClick={() => void act(() => linkClient(s.localId, s.centralId), `«${s.localName}» enlazado con «${s.centralName}» de Central.`)}>Enlazar</button>
        </span>
      </li>)}</ul>}
    {note && <p role="status" className="task-done">{note}</p>}
    {error && <LoadError message={error}/>}
    {data.clients.length === 0 ? <p className="muted">Todavía no tienes clientes. Crea uno con «Nuevo cliente» para que la Bandeja, WhatsApp, las reuniones, Fiscal y Watson lo reconozcan.</p>
      : <table className="work-table clients-table"><thead><tr><th>Cliente</th><th>Origen</th><th>Proyectos</th><th><span className="visually-hidden">Acciones</span></th></tr></thead>
        <tbody>{data.clients.map(client => <tr key={`${client.source}-${client.localId ?? client.centralId ?? client.name}`}>
          <td><strong>{client.name}</strong>{client.company && client.company !== client.name && <small className="muted"> · {client.company}</small>}
            {client.aliases.length > 0 && <small className="muted"> · también «{client.aliases.join('», «')}»</small>}</td>
          <td><span className={`status-badge ${tone[client.source]}`}>{sourceLabels[client.source]}</span></td>
          <td>{client.source === 'local' ? '—' : client.projects.length}</td>
          <td>{actions(client)}</td>
        </tr>)}</tbody></table>}
  </div>;
}
