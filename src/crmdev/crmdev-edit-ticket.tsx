import { useState } from 'react';
import type { CrmdevFilters, CrmdevTicket } from '../api/crmdev';
import { ModernSelect } from '../ui/modern-select';
import { CrmdevReview, EditActions } from './crmdev-common';
import { categoryLabels, priorityLabels, ticketStatusLabels } from './crmdev-labels';
import { useCrmdevChange } from './use-crmdev-change';

/** The options of a field: each known value and, if CRMDev has another one now, that one first (shown as it comes). */
export const optionsOf = (labels: Record<string, string>, current: string | null | undefined) =>
  [...(current && !(current in labels) ? [[current, current]] : []), ...Object.entries(labels)].map(([value, label]) => ({ value, label }));

/** A ticket's state, priority and category, changed after seeing exactly what changes. Tickets are opened by clients:
 * they are not created here. */
export function CrmdevEditTicket({ ticket, list, onDone, onCancel }: {
  ticket: CrmdevTicket & { id: string }; list: CrmdevFilters['tickets']; onDone: (said: string) => void; onCancel: () => void;
}) {
  const [values, setValues] = useState({ status: ticket.status ?? '', priority: ticket.priority ?? '', category: ticket.category ?? '' });
  const change = useCrmdevChange(onDone);
  const changes = Object.fromEntries(Object.entries(values).filter(([field, value]) => value && value !== ticket[field as keyof typeof values]));
  if (change.preview || change.conflict) return <CrmdevReview change={change} onCancel={onCancel} onReview={() => undefined}/>;
  return <form className="central-edit crmdev-edit" aria-label={`Cambiar el ticket ${ticket.title ?? ''}`}
    onSubmit={event => { event.preventDefault(); void change.ask({ kind: 'ticket', id: ticket.id, list, changes }); }}>
    <strong>Ticket «{ticket.title ?? '—'}»</strong>
    <div className="crmdev-edit-row">
      <label className="field">Estado<ModernSelect value={values.status} onChange={status => setValues({ ...values, status })} options={optionsOf(ticketStatusLabels, ticket.status)}/></label>
      <label className="field">Prioridad<ModernSelect value={values.priority} onChange={priority => setValues({ ...values, priority })} options={optionsOf(priorityLabels, ticket.priority)}/></label>
      <label className="field">Categoría<ModernSelect value={values.category} onChange={category => setValues({ ...values, category })} options={optionsOf(categoryLabels, ticket.category)}/></label>
      <EditActions busy={change.busy} disabled={!Object.keys(changes).length} onCancel={onCancel}/>
    </div>
    {change.error && <p className="error" role="alert">{change.error}</p>}
  </form>;
}
