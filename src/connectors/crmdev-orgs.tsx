import { useRef, useState } from 'react';
import { addCrmdevOrg, changeCrmdevOrg, forgetCrmdevOrg, getCrmdevOrgs, testCrmdevOrg, type CrmdevOrg } from '../api/crmdev';
import { ActionButton } from '../ui/action-button';
import { LoadError } from '../ui/load-state';

const when = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
const read = (org: CrmdevOrg) => org.fetchedAt === null ? 'sin leer todavía'
  : `${org.clients ?? 0} clientes y ${org.projects ?? 0} proyectos · leída ${when.format(new Date(org.fetchedAt))}`;

/** The organizations of CRMDev AgoraOne knows: a key of CRMDev belongs to one organization and CRMDev does not say its
 * name, so each one is named here. Rename, change its key, test it or forget it; add another with its name and key.
 * Keys are typed here and go only to the secret store: they never come back to the screen. */
export function CrmdevOrgs() {
  const [orgs, setOrgs] = useState<CrmdevOrg[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; field: 'name' | 'key'; value: string } | null>(null);
  const [adding, setAdding] = useState({ name: '', key: '' });
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);
  const load = () => { getCrmdevOrgs().then(found => setOrgs(found.orgs)).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer las organizaciones.')); };
  if (!asked.current) { asked.current = true; load(); }
  const act = async (work: () => Promise<{ orgs?: CrmdevOrg[]; warning?: string } | unknown>, done: string) => {
    setBusy(true); setError(''); setNote('');
    try {
      const answer = await work() as { orgs?: CrmdevOrg[]; warning?: string };
      if (answer?.orgs) setOrgs(answer.orgs);
      setNote(answer?.warning ?? done); setEditing(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo hacer el cambio.'); }
    finally { setBusy(false); }
  };
  if (!orgs) return error ? <LoadError message={error} onRetry={load}/> : null;
  return <div className="crmdev-orgs">
    <h3>Organizaciones</h3>
    <p className="muted">Cada clave de CRMDev es de una sola organización. Añade una por organización con el nombre que tiene en CRMDev: así eliges
      a cuál va cada cliente y cada proyecto.</p>
    <ul className="install-list">{orgs.map(org => <li key={org.id} className="install-row crmdev-org">
      {editing?.id === org.id ? <span className="field-row crmdev-org-edit">
        <label className="field">{editing.field === 'name' ? 'Nombre' : 'Clave nueva'}
          <input type={editing.field === 'key' ? 'password' : 'text'} autoComplete="off" value={editing.value} placeholder={editing.field === 'key' ? 'crm_…' : ''}
            onChange={event => setEditing({ ...editing, value: event.target.value })}/></label>
        <span className="actions">
          <ActionButton icon="close" label="Cancelar" disabled={busy} onClick={() => setEditing(null)}/>
          <ActionButton icon="save" label="Guardar" tone="primary" disabled={busy || !editing.value.trim()}
            onClick={() => void act(() => changeCrmdevOrg(org.id, { [editing.field]: editing.value }), editing.field === 'name' ? 'Nombre guardado.' : 'Clave guardada.')}/>
        </span>
      </span> : <>
        <span><strong>{org.name}</strong> <span className={`status-badge ${org.hasKey ? 'good' : 'paused'}`}>{org.hasKey ? 'Con clave' : 'Sin clave'}</span>
          <small className="muted"> · {read(org)}</small></span>
        <span className="actions">
          <ActionButton icon="edit" label="Renombrar" small disabled={busy} onClick={() => setEditing({ id: org.id, field: 'name', value: org.name })}/>
          <ActionButton icon="settings" label="Cambiar clave" small disabled={busy} onClick={() => setEditing({ id: org.id, field: 'key', value: '' })}/>
          {org.hasKey && <ActionButton icon="check" label="Probar" small disabled={busy}
            onClick={() => void act(() => testCrmdevOrg(org.id), `«${org.name}» responde con su clave.`)}/>}
          {orgs.length > 1 && <ActionButton icon="trash" label="Olvidar" small tone="danger" disabled={busy}
            onClick={() => void act(() => forgetCrmdevOrg(org.id), `«${org.name}» olvidada: su clave se ha quitado; en CRMDev no se borra nada.`)}/>}
        </span>
      </>}
    </li>)}</ul>
    <div className="field-row crmdev-org-add">
      <label className="field">Nombre de la organización<input type="text" value={adding.name} maxLength={80} placeholder="Como se llama en CRMDev"
        onChange={event => setAdding({ ...adding, name: event.target.value })}/></label>
      <label className="field">Su clave<input type="password" autoComplete="off" value={adding.key} placeholder="crm_…"
        onChange={event => setAdding({ ...adding, key: event.target.value })}/></label>
      <span className="actions"><ActionButton icon="plus" label="Añadir organización" tone="primary" disabled={busy || !adding.name.trim() || !adding.key.trim()}
        onClick={() => void act(async () => { const answer = await addCrmdevOrg(adding.name, adding.key); setAdding({ name: '', key: '' }); return answer; },
          `«${adding.name.trim()}» añadida y leída.`)}/></span>
    </div>
    {note && <p className="ok-note" role="status">{note}</p>}
    {error && <LoadError message={error}/>}
  </div>;
}
