import { useState } from 'react';
import { getCrmdevClient, getCrmdevView, type CrmdevClient, type CrmdevClientRecord, type CrmdevFilters } from '../api/crmdev';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { Block, Facts, RecordLayout } from '../ui/record-layout';
import { Badge, CrmdevProblem, Gone, HIDDEN, OpenInCrmdev, OrderNote, ReadAgain, Said } from './crmdev-common';
import { CrmdevEditClient, CrmdevNewClient } from './crmdev-edit-client';
import { clientStatusLabels, filterOptions, labelOf } from './crmdev-labels';
import { TicketsTable } from './crmdev-tickets';
import { changeKey, resetChange, useEditing } from './use-crmdev-change';
import { readKey, useCrmdevRead, type CrmdevRead } from './use-crmdev-view';

/** The key of a client's contact for the list it was opened from; null in discreet mode, so it is never asked. */
export const contactKey = (id: string, estado: string | undefined, discreet: boolean) => (discreet ? null : readKey(`cliente:${id}`, { estado }));

/** The contact of a client: its address (in discreet mode it is neither asked nor shown). */
function ClientContact({ read, discreet, onOpen }: { read: CrmdevRead<CrmdevClientRecord> & { reload: () => void }; discreet: boolean; onOpen: (section: Section) => void }) {
  if (discreet) return <Facts items={[['Correo', HIDDEN]]}/>;
  if (read.failure) return <CrmdevProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/>;
  if (!read.data) return <Loading label="Leyendo el contacto del cliente" lines={1}/>;
  return <Facts items={[['Correo', read.data.email ?? '—']]}/>;
}

/** A client's record, built from the list just read: its data, its address (hidden in discreet mode) and its tickets.
 * `estado` is the filter of that list, so the address comes from the same list (and the core's cache). Its data can be
 * changed after seeing exactly what changes; its mail only out of discreet mode, once read. */
export function ClientRecord({ client, estado, gone = false, readAt, discreet, onBack, onOpen }: {
  client: CrmdevClient & { id: string }; estado?: string; gone?: boolean; readAt: string | null; discreet: boolean; onBack: () => void; onOpen: (section: Section) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [said, setSaid] = useState('');
  const tickets = useCrmdevRead(readKey('tickets', { cliente: client.id }), fresh => getCrmdevView('tickets', { cliente: client.id }, fresh));
  const contact = useCrmdevRead(contactKey(client.id, estado, discreet), fresh => getCrmdevClient(client.id, estado, fresh));
  return <RecordLayout titleId="crmdev-client-title" title={client.name ?? 'Cliente sin nombre'}
    subtitle={client.company && client.company !== client.name ? client.company : undefined} badges={<span className="chip">De CRMDev</span>}
    actions={<span className="actions"><ReadAgain times={[readAt, tickets.data?.readAt, contact.data?.readAt]}/>
      <OpenInCrmdev page={`clientes/${client.id}`} discreet={discreet}/>
      <button type="button" className="button" onClick={onBack}>Volver a la lista</button></span>}>
    <Said text={said}/>
    {gone && <div className="central-wide"><Gone/></div>}
    <Block title="Datos" actions={!editing && <button type="button" className="button" onClick={() => { setSaid(''); resetChange(changeKey('cliente', client.id)); setEditing(true); }}>Editar</button>}>
      {/* Keyed by id (and once when its mail arrives): a reread after a conflict keeps what was typed and the review. */}
      {editing ? <CrmdevEditClient key={`${client.id}:${contact.data ? 'correo' : ''}`} client={client} list={gone ? {} : { estado }} discreet={discreet}
        email={discreet || !contact.data ? undefined : contact.data.email} onCancel={() => setEditing(false)}
        onDone={text => { setEditing(false); setSaid(text); }}/>
        : <Facts items={[['Nombre', client.name ?? '—'], ['Empresa', client.company ?? '—'], ['Estado', labelOf(clientStatusLabels, client.status)]]}/>}
    </Block>
    <Block title="Contacto"><ClientContact read={contact} discreet={discreet} onOpen={onOpen}/></Block>
    <Block title="Tickets" wide>
      {tickets.failure ? <CrmdevProblem failure={tickets.failure} onRetry={tickets.reload} onOpen={onOpen}/>
        : !tickets.data ? <Loading label="Leyendo los tickets del cliente" lines={3}/>
        : <><OrderNote page={tickets.data}/><TicketsTable tickets={tickets.data.items} discreet={discreet} withClient={false}/></>}
    </Block>
  </RecordLayout>;
}

/** Clientes: the 100 most recent (without contact in the list), filtered by state in CRMDev, and each client's record. */
export function CrmdevClients({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  const [filters, setFilters] = useState<CrmdevFilters['clientes']>({});
  const [creating, setCreating] = useState(false);
  const [said, setSaid] = useState('');
  const read = useCrmdevRead(readKey('clientes', filters), fresh => getCrmdevView('clientes', filters, fresh));
  const open = useEditing(read.data?.items);
  const picked = open.row;
  // The existing client of a «Nuevo cliente» CRMDev already has: opened from the whole list, where it is.
  const existing = (id: string) => { setCreating(false); setFilters({}); open.open(id); };
  if (picked) return <ClientRecord key={picked.id} client={picked} estado={filters.estado} gone={open.gone} readAt={read.data?.readAt ?? null} discreet={discreet}
    onBack={open.close} onOpen={onOpen}/>;
  return <>
    <div className="field-row central-filters">
      <label className="field">Estado<ModernSelect value={filters.estado ?? ''} onChange={value => setFilters({ estado: value || undefined })}
        options={filterOptions(clientStatusLabels)}/></label>
      <ReadAgain times={[read.data?.readAt]}/>
    </div>
    <Said text={said}/>
    {creating ? <CrmdevNewClient discreet={discreet} onCancel={() => setCreating(false)} onExisting={existing}
      onDone={text => { setCreating(false); setSaid(text); }}/>
      : <div className="crmdev-new"><button type="button" className="button" onClick={() => { setSaid(''); resetChange(changeKey('cliente-nuevo')); setCreating(true); }}>Nuevo cliente</button></div>}
    {read.failure ? <CrmdevProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/>
      : !read.data ? <Loading label="Leyendo los clientes de CRMDev" lines={4}/>
      : <>
        <OrderNote page={read.data}/>
        {!read.data.items.length ? <p className="muted">Ningún cliente{filters.estado ? ' con este estado' : ''}.</p> : <table className="data-table central-table">
          <thead><tr><th>Cliente</th><th>Empresa</th><th>Estado</th><th><span className="visually-hidden">Acciones</span></th></tr></thead>
          <tbody>{read.data.items.map((c, index) => <tr key={c.id ?? index}>
            <td className="crmdev-title"><strong>{c.name ?? '—'}</strong></td>
            <td>{c.company && c.company !== c.name ? c.company : '—'}</td>
            <td><Badge labels={clientStatusLabels} value={c.status}/></td>
            <td className="central-row-actions">{c.id && <span className="actions">
              <button type="button" className="button" aria-label={`Ver ficha de ${c.name ?? 'cliente sin nombre'}`} onClick={() => open.open(c.id as string, c)}>Ver ficha</button>
              <OpenInCrmdev page={`clientes/${c.id}`} discreet={discreet}/></span>}</td>
          </tr>)}</tbody>
        </table>}
      </>}
  </>;
}
