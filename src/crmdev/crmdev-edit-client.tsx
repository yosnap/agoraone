import { useState } from 'react';
import type { CrmdevClient, CrmdevClientValues, CrmdevFilters } from '../api/crmdev';
import { ModernSelect } from '../ui/modern-select';
import { CrmdevReview, EditActions } from './crmdev-common';
import { optionsOf } from './crmdev-edit-ticket';
import { clientStatusLabels } from './crmdev-labels';
import { useCrmdevChange } from './use-crmdev-change';

/** A new client in CRMDev: name, company, state and, out of discreet mode, mail and phone. The core first checks that
 * CRMDev does not already have it (same name or mail) and, if it does, offers to open that one. Notes and source are
 * written in CRMDev. */
export function CrmdevNewClient({ discreet, onDone, onCancel, onExisting }: {
  discreet: boolean; onDone: (said: string) => void; onCancel: () => void; onExisting: (id: string) => void;
}) {
  const [values, setValues] = useState<Required<CrmdevClientValues>>({ name: '', company: '', email: '', phone: '', status: '' });
  const change = useCrmdevChange(onDone);
  const set = (field: keyof CrmdevClientValues) => (value: string) => setValues({ ...values, [field]: value });
  const sent = Object.fromEntries(Object.entries({ ...values, ...(discreet ? { email: '', phone: '' } : {}) })
    .map(([field, value]) => [field, value.trim()]).filter(([, value]) => value)) as CrmdevClientValues;
  if (change.preview || change.conflict || change.exists) return <CrmdevReview change={change} onCancel={onCancel} onReview={() => undefined} onLink={onExisting}/>;
  return <form className="central-edit crmdev-edit" aria-label="Nuevo cliente en CRMDev"
    onSubmit={event => { event.preventDefault(); void change.ask({ kind: 'cliente-nuevo', values: sent }); }}>
    <strong>Nuevo cliente en CRMDev</strong>
    <div className="central-edit-grid">
      <label className="field">Nombre<input value={values.name} maxLength={300} required onChange={event => set('name')(event.target.value)}/></label>
      <label className="field">Empresa<input value={values.company} maxLength={300} onChange={event => set('company')(event.target.value)}/></label>
      {!discreet && <label className="field">Correo<input type="email" value={values.email} maxLength={200} onChange={event => set('email')(event.target.value)}/></label>}
      {!discreet && <label className="field">Teléfono<input type="tel" value={values.phone} maxLength={40} onChange={event => set('phone')(event.target.value)}/></label>}
      <label className="field">Estado<ModernSelect value={values.status} onChange={set('status')}
        options={[{ value: '', label: 'Por defecto (Contacto)' }, ...optionsOf(clientStatusLabels, null)]}/></label>
    </div>
    {discreet && <small className="muted">En modo discreto no se piden el correo ni el teléfono: añádelos fuera de él o en CRMDev.</small>}
    {change.error && <p className="error" role="alert">{change.error}</p>}
    <EditActions busy={change.busy} disabled={!values.name.trim()} onCancel={onCancel}/>
  </form>;
}

/** A client's name, company, state and, out of discreet mode and once its current mail is read, its mail; changed
 * after seeing exactly what changes. Its notes are not offered (CRMDev's list does not give them and would overwrite
 * them whole), and CRMDev's API cannot empty a mail. */
export function CrmdevEditClient({ client, email, list, discreet, onDone, onCancel }: {
  client: CrmdevClient & { id: string }; email: string | null | undefined; list: CrmdevFilters['clientes']; discreet: boolean;
  onDone: (said: string) => void; onCancel: () => void;
}) {
  const withMail = !discreet && email !== undefined;
  const [values, setValues] = useState({ name: client.name ?? '', company: client.company ?? '', email: email ?? '', status: client.status ?? '' });
  const change = useCrmdevChange(onDone);
  const company = values.company.trim();
  const changes = {
    ...(values.name.trim() && values.name.trim() !== (client.name ?? '') ? { name: values.name.trim() } : {}),
    ...(company !== (client.company ?? '') ? { company: company || null } : {}),
    ...(withMail && values.email.trim() && values.email.trim() !== (email ?? '') ? { email: values.email.trim() } : {}),
    ...(values.status && values.status !== client.status ? { status: values.status } : {}),
  };
  if (change.preview || change.conflict) return <CrmdevReview change={change} onCancel={onCancel} onReview={() => undefined}/>;
  return <form className="central-edit crmdev-edit" aria-label="Cambiar el cliente"
    onSubmit={event => { event.preventDefault(); void change.ask({ kind: 'cliente', id: client.id, list, changes }); }}>
    <div className="central-edit-grid">
      <label className="field">Nombre<input value={values.name} maxLength={300} required onChange={event => setValues({ ...values, name: event.target.value })}/></label>
      <label className="field">Empresa<input value={values.company} maxLength={300} onChange={event => setValues({ ...values, company: event.target.value })}/></label>
      {withMail && <label className="field">Correo<input type="email" value={values.email} maxLength={200} onChange={event => setValues({ ...values, email: event.target.value })}/></label>}
      <label className="field">Estado<ModernSelect value={values.status} onChange={status => setValues({ ...values, status })} options={optionsOf(clientStatusLabels, client.status)}/></label>
    </div>
    <small className="muted">{discreet ? 'El correo se oculta en modo discreto: cámbialo fuera de él. ' : ''}Las notas del cliente se escriben en CRMDev; el correo no se puede vaciar desde aquí.</small>
    {change.error && <p className="error" role="alert">{change.error}</p>}
    <EditActions busy={change.busy} disabled={!Object.keys(changes).length} onCancel={onCancel}/>
  </form>;
}
