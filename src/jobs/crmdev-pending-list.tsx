import { useRef, useState } from 'react';
import { confirmBatch, dismissPending, getCrmdevPending, previewBatch, type CrmdevPending, type PendingItem, type PendingKind } from '../api/clients';
import { ActionButton } from '../ui/action-button';
import { LoadError, Loading } from '../ui/load-state';
import { BatchReview } from './batch-review';
import { pendingChangeText, pendingText, pendingTotal } from './clients-view';

const SENDABLE = new Set<PendingKind>(['client_missing', 'contact_missing', 'client_changed', 'project_missing', 'project_changed']);
const GROUPS: [PendingKind, string][] = [
  ['client_missing', 'Clientes de Central que faltan en CRMDev'], ['contact_missing', 'Contactos que faltan en CRMDev'],
  ['client_changed', 'Clientes con datos distintos'], ['project_missing', 'Proyectos de Central que faltan en CRMDev'],
  ['project_changed', 'Proyectos con datos distintos'], ['crmdev_only', 'Clientes de CRMDev que no están en Central'],
];

/** «Pendiente en CRMDev»: what Central has and CRMDev lacks or has otherwise, grouped by kind. Central is the source:
 * nothing is sent from here yet and nothing comes back from CRMDev. «Descartar» hides a warning until what it says
 * changes; «Ver descartados» brings them back to undo it. Never an address nor a phone (only that it differs). */
export function CrmdevPendingList({ discreet }: { discreet: boolean }) {
  const [data, setData] = useState<CrmdevPending | null>(null);
  const [error, setError] = useState('');
  const [withDismissed, setWithDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState<string[] | null>(null);
  const asked = useRef(false);
  const load = (all = withDismissed) => {
    getCrmdevPending(all).then(found => { setData(found); setError(''); })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo leer lo pendiente en CRMDev.'));
  };
  if (!asked.current) { asked.current = true; load(false); }
  const toggle = async (item: PendingItem) => {
    setBusy(true); setError('');
    try { await dismissPending(item.key, item.dismissed ? null : item.signature); load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
    finally { setBusy(false); }
  };
  if (!data) return error ? <LoadError message={error} onRetry={() => load()}/> : <Loading label="Comparando Central y CRMDev" lines={3}/>;
  if (!data.active) return <p className="muted">Para comparar, enciende y lee Central y CRMDev en Conectores.</p>;
  const total = pendingTotal(data.counts);
  const sendable = data.items.filter(item => SENDABLE.has(item.kind) && !item.dismissed);
  return <section className="crmdev-pending" aria-label="Pendiente en CRMDev">
    <p className="muted">Central manda: aquí ves lo que tiene Central y falta o es distinto en CRMDev. Marca lo que quieras enviar,
      revisa el cambio exacto y pulsa «Enviar a CRMDev». Nada va a CRMDev sin esa pulsación, y nada vuelve de CRMDev a Central.{data.truncated ? ' De CRMDev se leen los 1000 más recientes: puede faltar algo que sí está.' : ''}</p>
    <div className="field-row">
      <span>{total ? `${total} ${total === 1 ? 'aviso' : 'avisos'}` : 'Todo al día'}</span>
      <span className="actions">
        {data.dismissed > 0 && <button type="button" className="button" aria-pressed={withDismissed}
          onClick={() => { setWithDismissed(!withDismissed); load(!withDismissed); }}>{withDismissed ? 'Ocultar descartados' : `Ver descartados (${data.dismissed})`}</button>}
        <ActionButton icon="refresh" label="Comparar de nuevo" disabled={busy} onClick={() => load()}/>
        {!discreet && <ActionButton icon="send" label={`Revisar envío (${sendable.filter(i => ticked.has(i.key)).length})`} tone="primary"
          disabled={busy || reviewing !== null || !sendable.some(i => ticked.has(i.key))}
          onClick={() => setReviewing(sendable.filter(i => ticked.has(i.key)).map(i => i.key))}/>}
      </span>
    </div>
    {error && <LoadError message={error}/>}
    {reviewing && <BatchReview key={reviewing.join('|')} onClose={() => setReviewing(null)}
      dest={{ name: 'CRMDev', action: 'Enviar a CRMDev', preview: anyway => previewBatch(reviewing, anyway), confirm: confirmBatch }}
      onDone={() => { setTicked(new Set()); load(); }}/>}
    {!discreet && sendable.length > 0 && <label className="field-row"><input type="checkbox" checked={sendable.every(i => ticked.has(i.key))}
      onChange={event => setTicked(event.target.checked ? new Set(sendable.map(i => i.key)) : new Set())}/> Marcar todo lo que se puede enviar</label>}
    {GROUPS.map(([kind, title]) => {
      const rows = data.items.filter(item => item.kind === kind);
      if (!rows.length) return null;
      return <div key={kind} className="crmdev-pending-group">
        <h3>{title} <small className="muted">({rows.length})</small></h3>
        <ul className="plain-list">{rows.map(item => <li key={item.key} className={item.dismissed ? 'muted' : undefined}>
          <div className="field-row">
            <span>{!discreet && SENDABLE.has(item.kind) && !item.dismissed && <input type="checkbox" aria-label={`Enviar «${item.name}»`}
              checked={ticked.has(item.key)} onChange={() => setTicked(current => {
                const next = new Set(current); if (next.has(item.key)) next.delete(item.key); else next.add(item.key); return next; })}/>}
              <strong>{item.name}</strong> <small className="muted">· {pendingText(item)}</small></span>
            {!discreet && <span className="actions">
              <ActionButton icon={item.dismissed ? 'eye' : 'close'} label={item.dismissed ? 'Volver a mostrar' : 'Descartar'} small disabled={busy}
                onClick={() => void toggle(item)}/>
            </span>}
          </div>
          {item.changes && item.changes.length > 0 && <ul className="muted">{item.changes.map(change => <li key={change.field}>{pendingChangeText(change)}</li>)}</ul>}
        </li>)}</ul>
      </div>;
    })}
  </section>;
}
