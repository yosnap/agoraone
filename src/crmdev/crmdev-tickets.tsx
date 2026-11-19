import { useState } from 'react';
import { getCrmdevView, type CrmdevFilters, type CrmdevTicket } from '../api/crmdev';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { Badge, CrmdevProblem, LongText, OpenInCrmdev, OrderNote, ReadAgain, Said } from './crmdev-common';
import { CrmdevEditTicket } from './crmdev-edit-ticket';
import { categoryLabels, dayLabel, filterOptions, labelOf, priorityLabels, ticketStatusLabels } from './crmdev-labels';
import { namesOf, readKey, useCrmdevRead } from './use-crmdev-view';

/** What the screen filters itself, over the tickets that came: CRMDev's API filters tickets only by state and client. */
export type ScreenFilters = { prioridad?: string; proyecto?: string };
export const screenFiltered = (tickets: CrmdevTicket[], { prioridad, proyecto }: ScreenFilters) =>
  tickets.filter(t => (!prioridad || t.priority === prioridad) && (!proyecto || t.project === proyecto));

/** Some tickets: title (and description), state, priority, category, who opened it, client, project and date; with
 * `onEdit`, an «Editar» button on each. In discreet mode neither descriptions nor the column of who opened it are shown. */
export function TicketsTable({ tickets, discreet, withClient = true, onEdit }: {
  tickets: CrmdevTicket[]; discreet: boolean; withClient?: boolean; onEdit?: (id: string) => void;
}) {
  if (!tickets.length) return <p className="muted">Ningún ticket.</p>;
  return <table className="data-table central-table">
    <thead><tr><th>Ticket</th><th>Estado</th><th>Prioridad</th><th>Categoría</th>{!discreet && <th>Abierto por</th>}{withClient && <th>Cliente</th>}<th>Proyecto</th><th>Fecha</th>
      <th><span className="visually-hidden">Acciones</span></th></tr></thead>
    <tbody>{tickets.map((t, index) => <tr key={t.id ?? index}>
      <td className="crmdev-title"><strong>{t.title ?? '—'}</strong><LongText text={t.description} discreet={discreet}/></td>
      <td><Badge labels={ticketStatusLabels} value={t.status}/></td>
      <td><Badge labels={priorityLabels} value={t.priority}/></td>
      <td>{labelOf(categoryLabels, t.category)}</td>
      {!discreet && <td>{t.requester ?? '—'}</td>}
      {withClient && <td>{t.client ?? '—'}</td>}
      <td>{t.project ?? '—'}</td>
      <td className="central-date">{dayLabel(t.createdAt)}</td>
      <td className="central-row-actions">{t.id && <span className="actions">
        {onEdit && <button type="button" className="button" aria-label={`Editar el ticket ${t.title ?? ''}`} onClick={() => onEdit(t.id as string)}>Editar</button>}
        <OpenInCrmdev page={`tickets/${t.id}`} discreet={discreet}/></span>}</td>
    </tr>)}</tbody>
  </table>;
}

/** Tickets: the 100 most recent, by state and client in CRMDev; priority and project are filtered here, over those 100,
 * and the view says so. */
export function CrmdevTickets({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  const [filters, setFilters] = useState<CrmdevFilters['tickets']>({});
  const [local, setLocal] = useState<ScreenFilters>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const read = useCrmdevRead(readKey('tickets', filters), fresh => getCrmdevView('tickets', filters, fresh));
  const clients = useCrmdevRead(readKey('clientes'), fresh => getCrmdevView('clientes', {}, fresh));
  // The projects offered come from the tickets read: a new state or client starts again from all projects.
  const remote = (next: CrmdevFilters['tickets']) => { setFilters(next); setLocal({ ...local, proyecto: undefined }); };
  const clientOptions = [{ value: '', label: 'Todos' }, ...(clients.data?.items ?? [])
    .filter((c): c is typeof c & { id: string } => Boolean(c.id)).map(c => ({ value: c.id, label: c.name ?? c.id }))];
  const projects = namesOf((read.data?.items ?? []).map(t => t.project));
  const shown = read.data ? screenFiltered(read.data.items, local) : [];
  const narrowed = Boolean(local.prioridad || local.proyecto);
  const picked = editing ? read.data?.items.find(t => t.id === editing) : undefined;
  return <>
    <div className="field-row central-filters">
      <label className="field">Estado<ModernSelect value={filters.estado ?? ''} onChange={value => remote({ ...filters, estado: value || undefined })}
        options={filterOptions(ticketStatusLabels)}/></label>
      <label className="field">Prioridad<ModernSelect value={local.prioridad ?? ''} onChange={value => setLocal({ ...local, prioridad: value || undefined })}
        options={filterOptions(priorityLabels, 'Todas')}/></label>
      <label className="field">Cliente<ModernSelect value={filters.cliente ?? ''} onChange={value => remote({ ...filters, cliente: value || undefined })}
        options={clientOptions}/></label>
      <label className="field">Proyecto<ModernSelect value={local.proyecto ?? ''} onChange={value => setLocal({ ...local, proyecto: value || undefined })}
        options={[{ value: '', label: 'Todos' }, ...projects.map(name => ({ value: name, label: name }))]}/></label>
      <ReadAgain times={[read.data?.readAt]}/>
    </div>
    {read.failure ? <CrmdevProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/>
      : !read.data ? <Loading label="Leyendo los tickets de CRMDev" lines={4}/>
      : <>
        <p className="muted crmdev-order">La prioridad y el proyecto se filtran aquí, sobre los tickets leídos{read.data.more ? ` (los ${read.data.limit} más recientes)` : ''}: la API de CRMDev solo filtra los tickets por estado y por cliente.</p>
        <OrderNote page={read.data}/>
        {narrowed && <p className="muted" role="status">{shown.length} de {read.data.items.length} tickets leídos.</p>}
        <Said text={said}/>
        {picked?.id && <CrmdevEditTicket key={JSON.stringify(picked)} ticket={{ ...picked, id: picked.id }} list={filters} onCancel={() => setEditing(null)}
          onDone={text => { setEditing(null); setSaid(text); }}/>}
        <TicketsTable tickets={shown} discreet={discreet} onEdit={id => { setSaid(''); setEditing(id); }}/>
      </>}
  </>;
}
