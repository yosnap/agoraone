import { useState } from 'react';
import type { CentralClientRecord } from '../api/central';
import type { ClientField } from '../api/central-write';
import { ChangeReview, useCentralChange } from './central-change';
import { ActionButton } from '../ui/action-button';

const FIELDS: { field: ClientField; label: string; max: number; type?: string; lines?: boolean }[] = [
  { field: 'name', label: 'Nombre', max: 120 }, { field: 'company', label: 'Empresa', max: 160 },
  { field: 'email', label: 'Correo', max: 200, type: 'email' }, { field: 'phone', label: 'Teléfono', max: 40, type: 'tel' },
  { field: 'taxId', label: 'NIF', max: 30 }, { field: 'address', label: 'Dirección', max: 500, lines: true },
];

/** A client's data in Central, changed from its record: «Revisar el cambio» shows exactly what changes (and which
 * contact fields are emptied) and only «Guardar en Central» sends it, with the version of the record read. */
export function CentralEditClient({ client, onDone, onCancel, onReview }: {
  client: CentralClientRecord & { id: string; revision: string; editable: NonNullable<CentralClientRecord['editable']> }; onDone: (said: string) => void; onCancel: () => void; onReview: () => void;
}) {
  const [values, setValues] = useState<Record<ClientField, string>>(() =>
    Object.fromEntries(FIELDS.map(({ field }) => [field, client.editable[field] ?? ''])) as Record<ClientField, string>);
  const change = useCentralChange(onDone);
  // Compared with the data as Central keeps it, never with the scrubbed copy shown in the record.
  const changed = FIELDS.filter(({ field }) => values[field].trim() !== (client.editable[field] ?? '').trim());
  const review = () => void change.ask({
    kind: 'cliente', id: client.id, revision: client.revision,
    changes: Object.fromEntries(changed.map(({ field }) => [field, values[field].trim() || null])),
  });
  if (change.preview || change.conflict) return <ChangeReview change={change} onCancel={() => { change.reset(); onCancel(); }} onReview={onReview}/>;
  return <form className="central-edit" onSubmit={event => { event.preventDefault(); review(); }}>
    <div className="central-edit-grid">{FIELDS.map(({ field, label, max, type, lines }) => <label key={field} className={`field${lines ? ' central-edit-wide' : ''}`}>{label}
      {lines ? <textarea value={values[field]} maxLength={max} rows={2} onChange={event => setValues({ ...values, [field]: event.target.value })}/>
        : <input type={type ?? 'text'} value={values[field]} maxLength={max} onChange={event => setValues({ ...values, [field]: event.target.value })}/>}
    </label>)}</div>
    {change.error && <p className="error" role="alert">{change.error}</p>}
    <div className="actions central-actions">
      <ActionButton icon="close" label="Cancelar" onClick={onCancel}/>
      <ActionButton icon="check" label="Revisar el cambio" tone="primary" busyLabel={change.busy && 'Preparando…'} type="submit" disabled={!changed.length || change.busy}/>
    </div>
  </form>;
}
