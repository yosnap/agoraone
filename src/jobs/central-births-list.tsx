import { useRef, useState } from 'react';
import { confirmCentralBatch, dismissBirth, getClientBirths, previewCentralBatch, type ClientBirth, type DirectoryClient } from '../api/clients';
import { ActionButton } from '../ui/action-button';
import { LoadError, Loading } from '../ui/load-state';
import { BatchReview } from './batch-review';
import { birthText, centralCandidates } from './clients-view';

type Row = { key: string; name: string; detail: string; editable: boolean; birth?: ClientBirth };

/** «Crear en Central»: clients are born in Central. Here are the clients kept only in AgoraOne, the clients of CRMDev
 * that are not in Central and the proposals from mail, WhatsApp and meetings (only what is «normal»; never an address
 * nor a number on this list). The user ticks them, may change a proposal's name, sees each new client exactly in the
 * review and creates them all with one «Crear en Central». Nothing is created by itself. In discreet mode, only seen. */
export function CentralBirthsList({ clients, canCentral, discreet, onDone }: {
  clients: DirectoryClient[]; canCentral: boolean; discreet: boolean; onDone: () => void;
}) {
  const [births, setBirths] = useState<{ items: ClientBirth[]; dismissed: number } | null>(null);
  const [error, setError] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const [withDismissed, setWithDismissed] = useState(false);
  const [reviewing, setReviewing] = useState<{ key: string; name?: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);
  const load = (all = withDismissed) => {
    getClientBirths(all).then(found => { setBirths(found); setError(''); })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer las propuestas.'));
  };
  if (!asked.current) { asked.current = true; load(false); }
  if (!births) return error ? <LoadError message={error} onRetry={() => load()}/> : <Loading label="Buscando clientes por crear" lines={3}/>;
  const { local, crmdev } = centralCandidates(clients);
  const groups: [string, Row[]][] = [
    ['Tus clientes de AgoraOne sin ubicar', local.map(c => ({ key: `local:${c.localId}`, name: c.name, detail: c.company && c.company !== c.name ? c.company : '', editable: false }))],
    ['Clientes de CRMDev que no están en Central', crmdev.map(c => ({ key: `crmdev:${c.crmdevId}`, name: c.name, detail: c.company && c.company !== c.name ? c.company : '', editable: false }))],
    ['Propuestas de correo, WhatsApp y reuniones', births.items.map(b => ({ key: b.key, name: b.name, detail: birthText(b), editable: true, birth: b }))],
  ];
  const all = groups.flatMap(([, rows]) => rows).filter(row => !row.birth?.dismissed);
  const chosen = all.filter(row => ticked.has(row.key));
  const can = canCentral && !discreet;
  const toggle = (key: string) => setTicked(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const hide = async (birth: ClientBirth) => {
    setBusy(true); setError('');
    try { await dismissBirth(birth.key, !birth.dismissed); load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
    finally { setBusy(false); }
  };
  const review = () => setReviewing(chosen.map(row => {
    const name = names[row.key]?.trim();
    return row.editable && name && name !== row.name ? { key: row.key, name } : { key: row.key };
  }));
  return <section className="central-births" aria-label="Crear en Central">
    <p className="muted">Tus clientes nacen en Central: marca los que quieras crear, revisa cada uno tal cual irá y pulsa «Crear en Central».
      Las propuestas salen de correos y conversaciones de cliente o de trabajo y de tus reuniones, nunca de lo «solo en este Mac» ni de lo privado.
      Nada se crea solo.</p>
    {!canCentral && <p className="notice">Para crear en Central hace falta una clave con el permiso «escritura» (Conectores › Central).</p>}
    <div className="field-row">
      <span>{all.length ? `${all.length} por crear` : 'Nada por crear en Central'}</span>
      <span className="actions">
        {births.dismissed > 0 && <button type="button" className="button" aria-pressed={withDismissed}
          onClick={() => { setWithDismissed(!withDismissed); load(!withDismissed); }}>{withDismissed ? 'Ocultar descartadas' : `Ver descartadas (${births.dismissed})`}</button>}
        {can && <ActionButton icon="send" label={`Revisar (${chosen.length})`} tone="primary" disabled={busy || reviewing !== null || !chosen.length} onClick={review}/>}
      </span>
    </div>
    {error && <LoadError message={error}/>}
    {reviewing && <BatchReview key={reviewing.map(i => i.key).join('|')} onClose={() => setReviewing(null)}
      onDone={() => { setTicked(new Set()); load(); onDone(); }}
      dest={{ name: 'Central', action: 'Crear en Central', preview: anyway => previewCentralBatch(reviewing, anyway), confirm: confirmCentralBatch }}/>}
    {groups.map(([title, rows]) => rows.length > 0 && <div key={title} className="central-births-group">
      <h3>{title} <small className="muted">({rows.length})</small></h3>
      <ul className="plain-list">{rows.map(row => <li key={row.key} className={row.birth?.dismissed ? 'muted' : undefined}>
        <div className="field-row">
          <span>{can && !row.birth?.dismissed && <input type="checkbox" aria-label={`Crear «${row.name}» en Central`} checked={ticked.has(row.key)} onChange={() => toggle(row.key)}/>}
            {can && row.editable && ticked.has(row.key)
              ? <input type="text" aria-label="Nombre en Central" value={names[row.key] ?? row.name} maxLength={120}
                onChange={event => setNames(current => ({ ...current, [row.key]: event.target.value }))}/>
              : <strong>{row.name}</strong>}
            {row.detail && <small className="muted"> · {row.detail}</small>}</span>
          {!discreet && row.birth && <span className="actions">
            <ActionButton icon={row.birth.dismissed ? 'eye' : 'close'} label={row.birth.dismissed ? 'Volver a mostrar' : 'Descartar'} small disabled={busy}
              onClick={() => void hide(row.birth!)}/>
          </span>}
        </div>
      </li>)}</ul>
    </div>)}
  </section>;
}
