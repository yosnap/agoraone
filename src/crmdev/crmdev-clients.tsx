import { useState } from 'react';
import { getCrmdevClient, getCrmdevView, type CrmdevClient, type CrmdevFilters } from '../api/crmdev';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { Block, Facts, RecordLayout } from '../ui/record-layout';
import { Badge, CrmdevProblem, HIDDEN, OrderNote } from './crmdev-common';
import { clientStatusLabels, filterOptions, labelOf } from './crmdev-labels';
import { TicketsTable } from './crmdev-tickets';
import { forgetCrmdev, readKey, useCrmdevRead } from './use-crmdev-view';

/** The contact of a client: its address, asked only outside discreet mode (in discreet mode it is neither asked nor
 * shown). */
function ClientContact({ id, discreet, onOpen }: { id: string; discreet: boolean; onOpen: (section: Section) => void }) {
  const read = useCrmdevRead(discreet ? null : `cliente:${id}`, () => getCrmdevClient(id));
  if (discreet) return <Facts items={[['Correo', HIDDEN]]}/>;
  if (read.failure) return <CrmdevProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/>;
  if (!read.data) return <Loading label="Leyendo el contacto del cliente" lines={1}/>;
  return <Facts items={[['Correo', read.data.email ?? '—']]}/>;
}

/** A client's record, built from the list just read: its data, its address (hidden in discreet mode) and its tickets. */
function ClientRecord({ client, discreet, onBack, onOpen }: { client: CrmdevClient & { id: string }; discreet: boolean; onBack: () => void; onOpen: (section: Section) => void }) {
  const tickets = useCrmdevRead(readKey('tickets', { cliente: client.id }), () => getCrmdevView('tickets', { cliente: client.id }));
  return <RecordLayout titleId="crmdev-client-title" title={client.name ?? 'Cliente sin nombre'}
    subtitle={client.company && client.company !== client.name ? client.company : undefined} badges={<span className="chip">De CRMDev</span>}
    actions={<span className="actions"><button type="button" className="button" onClick={forgetCrmdev}>Volver a leer</button>
      <button type="button" className="button" onClick={onBack}>Volver a la lista</button></span>}>
    <Block title="Datos">
      <Facts items={[['Nombre', client.name ?? '—'], ['Empresa', client.company ?? '—'], ['Estado', labelOf(clientStatusLabels, client.status)]]}/>
    </Block>
    <Block title="Contacto"><ClientContact id={client.id} discreet={discreet} onOpen={onOpen}/></Block>
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
  const [open, setOpen] = useState<string | null>(null);
  const read = useCrmdevRead(readKey('clientes', filters), () => getCrmdevView('clientes', filters));
  const picked = open ? read.data?.items.find(c => c.id === open) : undefined;
  if (picked?.id) return <ClientRecord client={{ ...picked, id: picked.id }} discreet={discreet} onBack={() => setOpen(null)} onOpen={onOpen}/>;
  return <>
    <div className="field-row central-filters">
      <label className="field">Estado<ModernSelect value={filters.estado ?? ''} onChange={value => setFilters({ estado: value || undefined })}
        options={filterOptions(clientStatusLabels)}/></label>
    </div>
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
            <td className="central-row-actions">{c.id && <button type="button" className="button" onClick={() => setOpen(c.id)}>Ver ficha</button>}</td>
          </tr>)}</tbody>
        </table>}
      </>}
  </>;
}
