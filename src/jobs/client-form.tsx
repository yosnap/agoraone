import { useRef, useState } from 'react';
import { createClient, getClient, updateClient, type OwnClient, type OwnClientFields } from '../api/clients';
import { LoadError, Loading } from '../ui/load-state';

const blank: OwnClientFields = { name: '', company: null, email: null, phone: null, taxId: null, domains: [], notes: null };
const text = (value: string) => value.trim() || null;
/** «acme.com, www.acme.es» → ['acme.com', 'www.acme.es']; the core checks each one. */
const splitDomains = (value: string) => value.split(/[\s,;]+/).map(part => part.trim()).filter(Boolean);

/** A client kept in AgoraOne: created or changed only on «Guardar». Its address, phone and tax id stay in this
 * Mac's core and go to no model; the screen's lists never receive them. */
export function ClientForm({ clientId, onDone, onCancel }: { clientId: number | null; onDone: (saved: OwnClient) => void; onCancel: () => void }) {
  const [fields, setFields] = useState<OwnClientFields | null>(clientId === null ? blank : null);
  const [domains, setDomains] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const asked = useRef(false);
  const load = () => {
    if (clientId === null) return;
    setError('');
    getClient(clientId).then(found => { setFields(found); setDomains(found.domains.join(', ')); })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo leer el cliente.'));
  };
  if (!asked.current) { asked.current = true; load(); }
  if (!fields) return <div className="card task-form">{error ? <LoadError message={error} onRetry={load}/> : <Loading label="Leyendo el cliente"/>}</div>;
  const set = (name: keyof OwnClientFields) => (event: { target: { value: string } }) => setFields({ ...fields, [name]: event.target.value });
  const save = async () => {
    if (!fields.name.trim()) return;
    setBusy(true); setError('');
    const body: OwnClientFields = { name: fields.name.trim(), company: text(fields.company ?? ''), email: text(fields.email ?? ''), phone: text(fields.phone ?? ''),
      taxId: text(fields.taxId ?? ''), notes: text(fields.notes ?? ''), domains: splitDomains(domains) };
    try { onDone(clientId === null ? await createClient(body) : await updateClient(clientId, body)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar el cliente.'); setBusy(false); }
  };
  return <form className="card task-form client-form" aria-label={clientId === null ? 'Nuevo cliente' : `Editar ${fields.name}`}
    onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="field-row">
      <label className="field">Nombre<input autoFocus required maxLength={200} value={fields.name} onChange={set('name')} placeholder="Por ejemplo: Café Web"/></label>
      <label className="field">Empresa (opcional)<input maxLength={200} value={fields.company ?? ''} onChange={set('company')}/></label>
    </div>
    <div className="field-row">
      <label className="field">Correo<input type="email" maxLength={320} autoComplete="off" value={fields.email ?? ''} onChange={set('email')} placeholder="hola@cafeweb.es"/></label>
      <label className="field">Teléfono<input type="tel" maxLength={40} autoComplete="off" value={fields.phone ?? ''} onChange={set('phone')} placeholder="+34 600 000 000"/></label>
      <label className="field">NIF<input maxLength={30} autoComplete="off" value={fields.taxId ?? ''} onChange={set('taxId')}/></label>
    </div>
    <label className="field">Notas (opcional)<textarea rows={3} maxLength={4000} value={fields.notes ?? ''} onChange={set('notes')}/></label>
    <small className="muted">El correo, el teléfono y el NIF sirven para reconocer al cliente en la Bandeja, WhatsApp y Fiscal. Se quedan en este equipo: no van a ningún modelo ni a las listas de la pantalla.</small>
    {error && <LoadError message={error}/>}
    <div className="field-row">
      <label className="field">Dominios (opcional, separados por comas)<input maxLength={600} value={domains} onChange={event => setDomains(event.target.value)} placeholder="cafeweb.es, cafeweb.com"/></label>
      <span className="actions">
        <button type="button" className="button" disabled={busy} onClick={onCancel}>Cancelar</button>
        <button type="submit" className="button primary" disabled={busy || !fields.name.trim()}>{busy ? 'Guardando…' : 'Guardar'}</button>
      </span>
    </div>
  </form>;
}
