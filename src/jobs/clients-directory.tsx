import { useEffect, useRef, useState } from 'react';
import { deleteClient, distinctClient, getClient, getClients, type ClientsDirectory, type DirectoryClient } from '../api/clients';
import { getWritePermissions } from '../api/central-write';
import { refreshCrmdevClients } from '../api/crmdev';
import { invalidateClients } from '../data/clients-store';
import { LoadError, Loading } from '../ui/load-state';
import { ClientDetail, ClientOrigins } from './client-detail';
import { ClientSuggestions, DistinctPairs, VaultCards } from './client-follow-up';
import { ClientForm } from './client-form';
import { CrmdevPendingList } from './crmdev-pending-list';
import { filterClients, followUp, forDiscreet, type ClientsFilter } from './clients-view';
import { takeClientsFilter } from './jobs-tab';
import { ActionButton } from '../ui/action-button';

const rowKey = (client: DirectoryClient) => `${client.sources.join('+')}-${client.localId ?? client.centralId ?? client.crmdevId ?? client.name}`;

/** One list of the user's clients from three sources: Central's and CRMDev's (read-only here) and the ones kept in
 * AgoraOne, which the user creates, changes and deletes (after confirming). The same client in several sources shows
 * once; names that are only alike come up as a suggestion, linked only on «Enlazar». A client kept only here while a CRM
 * is connected is «sin ubicar»: its record offers «Crear en Central» and «Crear en CRMDev» (after seeing it), and the
 * vault's «Clientes/<Nombre>» cards without a client can become clients kept here. In discreet mode nothing can be
 * changed and a record shows no address, phone nor tax id (it never does), and only normal vault cards are named. */
export function ClientsDirectoryView({ discreet }: { discreet: boolean }) {
  const [data, setData] = useState<ClientsDirectory | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<ClientsFilter>(takeClientsFilter);
  // The client being deleted and how many meetings name it (asked before confirming).
  const [deleting, setDeleting] = useState<{ id: number; meetings: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  // Whether the saved key may create clients in Central (asked only when Central is on and read).
  const [canCentral, setCanCentral] = useState(false);
  const asked = useRef(false);
  const request = useRef(0);
  const load = () => {
    const mine = ++request.current;
    getClients(discreet).then(found => {
      if (mine !== request.current) return;
      setData(found); setError('');
      if (found.central.on && found.central.read) {
        getWritePermissions().then(can => { if (mine === request.current) setCanCentral(can.central); }).catch(() => setCanCentral(false));
      } else setCanCentral(false);
    })
      .catch(failure => { if (mine === request.current) setError(failure instanceof Error ? failure.message : 'No se pudieron leer los clientes.'); });
  };
  if (!asked.current) { asked.current = true; load(); }
  // Discreet mode turned on or off with the directory open: reserved vault cards go at once, and the core is asked again.
  const readWith = useRef(discreet);
  useEffect(() => { if (readWith.current !== discreet) { readWith.current = discreet; load(); } });
  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true); setError(''); setNote('');
    try { await work(); setNote(done); load(); invalidateClients(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo hacer el cambio.'); }
    finally { setBusy(false); setDeleting(null); }
  };
  const askDelete = (id: number) => {
    setDeleting({ id, meetings: null }); setNote('');
    getClient(id).then(found => setDeleting(current => current?.id === id ? { id, meetings: found.references.meetings } : current)).catch(() => undefined);
  };
  if (!data) return error ? <LoadError message={error} onRetry={load}/> : <Loading label="Leyendo tus clientes" lines={3}/>;
  const can = { central: canCentral, crmdev: data.crmdev.on && data.crmdev.connected };
  const shown = filterClients(data.clients, filter);
  const picked = open === null ? null : data.clients.find(client => rowKey(client) === open) ?? null;
  const cards = forDiscreet(data.vaultCards, discreet);
  const pending = followUp({ ...data, vaultCards: cards });
  const actions = (client: DirectoryClient) => {
    const record = <ActionButton icon="eye" label="Ficha" onClick={() => { setOpen(rowKey(client)); setNote(''); }}/>;
    if (discreet || client.localId === null) return <span className="actions">{record}</span>;
    const id = client.localId;
    if (deleting?.id === id) return <span className="field-row" role="group" aria-label={`Confirmar eliminar ${client.name}`}>
      <small>Se borra de AgoraOne{client.sources.length > 1 ? '; en Central y CRMDev sigue igual' : ''}. Antes se guarda una copia con sus notas.
        {deleting.meetings ? ` ${deleting.meetings === 1 ? 'Una reunión lo nombra y conservará' : `${deleting.meetings} reuniones lo nombran y conservarán`} el nombre «${client.aliases.at(-1) ?? client.name}».` : ''}</small>
      <ActionButton icon="close" label="Cancelar" disabled={busy} onClick={() => setDeleting(null)}/>
      <ActionButton icon="trash" label="Eliminar de verdad" tone="danger" disabled={busy} onClick={() => void act(() => deleteClient(id), `«${client.name}» eliminado de tus clientes.`)}/>
    </span>;
    return <span className="actions">
      {record}
      <ActionButton icon="edit" label="Editar" disabled={busy} onClick={() => { setEditing(id); setNote(''); }}/>
      {client.source === 'ambos' && client.centralId && (client.aliases.length
        ? <button type="button" className="button" disabled={busy}
          onClick={() => void act(() => distinctClient(id, client.centralId!), `«${client.aliases.at(-1)}» y «${client.name}» de Central se quedan como clientes distintos.`)}>Son distintos</button>
        : <small className="muted">Mismo nombre que en Central: para separarlos, cambia antes el nombre del tuyo.</small>)}
      <ActionButton icon="trash" label="Eliminar…" tone="danger" disabled={busy} onClick={() => askDelete(id)}/>
    </span>;
  };
  const bothRead = data.central.on && data.central.read && data.crmdev.on && data.crmdev.read;
  const sources = [data.central.on && data.central.read ? 'Central' : null, data.crmdev.on && data.crmdev.read ? 'CRMDev' : null].filter(Boolean);
  return <div className="clients-directory">
    <div className="jobs-heading"><h2>Clientes{pending && <small className="muted"> · {pending}</small>}</h2>
      <span className="actions">
        {data.crmdev.on && data.crmdev.connected && <ActionButton icon="refresh" label="Actualizar CRMDev" disabled={busy}
          onClick={() => void act(refreshCrmdevClients, 'Clientes de CRMDev leídos de nuevo.')}/>}
        {!discreet && editing === null && <ActionButton icon="plus" label="Nuevo cliente" tone="primary" onClick={() => { setEditing('new'); setNote(''); }}/>}
      </span></div>
    <p className="muted">{sources.length ? `Tus clientes de ${sources.join(' y ')} y los que guardas en AgoraOne, en una sola lista. Los de cada CRM se cambian en su sección.`
      : 'Ni Central ni CRMDev están encendidos y leídos (Conectores): ves solo los clientes que guardas en AgoraOne.'}
      {data.crmdev.truncated ? ' De CRMDev se leen los 1000 más recientes: el resto no se ve aquí.' : ''}</p>
    {data.crmdev.problem && <LoadError message={data.crmdev.problem}/>}
    <div className="segmented" role="group" aria-label="Qué clientes ver">{([['all', 'Todos'], ['unplaced', `Sin ubicar (${data.unplacedCount})`],
      ['cards', `Fichas sin cliente (${cards.count})`], ...(bothRead ? [['pending', 'Pendiente en CRMDev'] as const] : [])] as const).map(([key, label]) =>
      <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</div>
    {editing !== null && !discreet && <ClientForm key={editing} clientId={editing === 'new' ? null : editing} onCancel={() => setEditing(null)}
      onDone={saved => { setEditing(null); setNote(`«${saved.name}» guardado.`); load(); invalidateClients(); }}/>}
    {!discreet && <ClientSuggestions suggestions={data.suggestions} busy={busy} act={(work, said) => void act(work, said)}/>}
    {!discreet && <DistinctPairs pairs={data.distinctPairs} busy={busy} act={(work, said) => void act(work, said)}/>}
    {picked && <ClientDetail key={open} client={picked} can={can} discreet={discreet} busy={busy} onClose={() => setOpen(null)}
      act={(work, said) => void act(work, said)} onDone={said => { setNote(said); load(); invalidateClients(); }}/>}
    {note && <p role="status" className="task-done">{note}</p>}
    {error && <LoadError message={error}/>}
    {filter === 'pending' ? <CrmdevPendingList discreet={discreet}/>
      : filter === 'cards' ? <VaultCards cards={cards} discreet={discreet} busy={busy} act={(work, said) => void act(work, said)}/>
      : shown.length === 0 ? <p className="muted">{filter === 'unplaced' ? 'Ningún cliente sin ubicar: todos están en Central o en CRMDev.'
        : 'Todavía no tienes clientes. Crea uno con «Nuevo cliente» para que la Bandeja, WhatsApp, las reuniones, Fiscal y Watson lo reconozcan.'}</p>
      : <table className="work-table clients-table"><thead><tr><th>Cliente</th><th>Origen</th><th className="num">Proyectos</th><th><span className="visually-hidden">Acciones</span></th></tr></thead>
        <tbody>{shown.map(client => <tr key={rowKey(client)}>
          <td><strong>{client.name}</strong>{client.company && client.company !== client.name && <small className="muted"> · {client.company}</small>}
            {client.aliases.length > 0 && <small className="muted"> · también «{client.aliases.join('», «')}»</small>}</td>
          <td><ClientOrigins client={client}/></td>
          <td className="num">{client.sources.includes('central') ? client.projects.length : '—'}</td>
          <td>{actions(client)}</td>
        </tr>)}</tbody></table>}
  </div>;
}
