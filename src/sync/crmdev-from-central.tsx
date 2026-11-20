import { useRef, useState } from 'react';
import { confirmBatch, dismissPending, getCrmdevPending, previewBatch, type CrmdevPending, type PendingItem, type PendingKind } from '../api/clients';
import { pendingChangeText, pendingText } from '../jobs/clients-view';
import { ActionButton } from '../ui/action-button';
import { LoadError, Loading } from '../ui/load-state';
import { BatchReview } from './batch-review';
import { SyncTable, type SyncGroup, type SyncItem, type SyncRow } from './sync-table';

export const KIND_LABELS: Record<string, string> = { CLIENT: 'De cliente', OWN: 'Propio', TRAINING: 'Formación', EXPERIMENT: 'Experimento' };
export const CENTRAL_STATUS: Record<string, string> = { ACTIVE: 'Activo', MAINTENANCE: 'Mantenimiento', DORMANT: 'En pausa', ARCHIVED: 'Archivado' };
const SENDABLE = new Set<PendingKind>(['client_missing', 'contact_missing', 'client_changed', 'project_missing', 'project_changed']);
const GROUPS: { kind: PendingKind; label: string; hint: string }[] = [
  { kind: 'client_missing', label: 'Clientes que faltan', hint: 'Clientes de Central que no están en CRMDev: se crean con su nombre, correo, empresa y teléfono (nunca el NIF ni la dirección).' },
  { kind: 'project_missing', label: 'Proyectos que faltan', hint: 'Proyectos de Central que no están en CRMDev. Si marcas también su cliente, va primero y el proyecto queda con él.' },
  { kind: 'contact_missing', label: 'Contactos que faltan', hint: 'El correo de contacto de Central no está en CRMDev: se añade al cliente o se crea una persona de esa empresa.' },
  { kind: 'client_changed', label: 'Clientes distintos', hint: 'Clientes con nombre, empresa o correo distintos: CRMDev se pone como Central.' },
  { kind: 'project_changed', label: 'Proyectos distintos', hint: 'Proyectos con nombre o estado distintos: CRMDev se pone como Central (el cliente se cambia en CRMDev).' },
  { kind: 'crmdev_only', label: 'Solo en CRMDev', hint: 'Clientes de CRMDev que no están en Central: se crean en Central, en Central › Por crear.' },
];

const rowOf = (item: PendingItem): SyncRow => ({
  key: item.key, name: item.name, selectable: SENDABLE.has(item.kind), dismissed: item.dismissed, dismissable: true,
  client: item.kind === 'project_missing' ? item.client ?? null : undefined,
  kind: item.kind === 'project_missing' ? (item.projectKind ? KIND_LABELS[item.projectKind] ?? item.projectKind : null) : undefined,
  status: item.kind === 'project_missing' && item.status ? CENTRAL_STATUS[item.status] ?? item.status : undefined,
  detail: item.kind === 'project_missing' ? (item.maybe ? `Quizá es «${item.maybe}» de CRMDev: enlázalo en su ficha.` : null)
    : item.kind === 'client_changed' || item.kind === 'project_changed' ? null : pendingText(item),
  changes: item.changes?.map(pendingChangeText),
});

/** «Desde Central» in the CRMDev section: what Central has and CRMDev lacks or has otherwise, by groups, to tick and
 * send with «Enviar a CRMDev» after seeing the exact review. Central is the source: nothing comes back from CRMDev. */
export function CrmdevFromCentral({ discreet, onChanged }: { discreet: boolean; onChanged?: () => void }) {
  const [data, setData] = useState<CrmdevPending | null>(null);
  const [error, setError] = useState('');
  const [withDismissed, setWithDismissed] = useState(false);
  const [reviewing, setReviewing] = useState<SyncItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);
  const load = (all = withDismissed) => {
    getCrmdevPending(all).then(found => { setData(found); setError(''); })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo comparar con Central.'));
  };
  if (!asked.current) { asked.current = true; load(false); }
  if (!data) return error ? <LoadError message={error} onRetry={() => load()}/> : <Loading label="Comparando Central y CRMDev" lines={3}/>;
  if (!data.active) return <p className="muted">Para comparar, enciende y lee Central (Conectores) y vuelve a leer CRMDev.</p>;
  const dismiss = async (row: SyncRow) => {
    const item = data.items.find(i => i.key === row.key);
    if (!item) return;
    setBusy(true); setError('');
    try { await dismissPending(item.key, item.dismissed ? null : item.signature); load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
    finally { setBusy(false); }
  };
  const groups: SyncGroup[] = GROUPS.map(g => ({ id: g.kind, label: g.label, hint: g.hint, rows: data.items.filter(i => i.kind === g.kind).map(rowOf) }));
  return <section className="sync-section" aria-label="Desde Central">
    <p className="muted">Central manda: aquí está lo que tiene Central y falta o es distinto en CRMDev. Marca lo que quieras, pulsa «Revisar envío» para ver
      exactamente qué irá y envíalo. Va a la organización de CRMDev de la clave guardada en Conectores.{data.truncated ? ' De CRMDev se leen los 1000 más recientes: puede faltar algo que sí está.' : ''}</p>
    {error && <LoadError message={error}/>}
    {reviewing && <BatchReview key={reviewing.map(i => i.key).join('|')} onClose={() => setReviewing(null)}
      onDone={() => { load(); onChanged?.(); }}
      dest={{ name: 'CRMDev', action: 'Enviar a CRMDev', preview: anyway => previewBatch(reviewing.map(i => i.key), anyway), confirm: confirmBatch }}/>}
    <SyncTable groups={groups} discreet={discreet} busy={busy || reviewing !== null} reviewLabel="Revisar envío" onReview={setReviewing}
      onDismiss={row => void dismiss(row)} empty="Todo al día: CRMDev tiene lo mismo que Central."
      tools={<>
        {data.dismissed > 0 && <button type="button" className="button" aria-pressed={withDismissed}
          onClick={() => { setWithDismissed(!withDismissed); load(!withDismissed); }}>{withDismissed ? 'Ocultar descartados' : `Ver descartados (${data.dismissed})`}</button>}
        <ActionButton icon="refresh" label="Comparar de nuevo" disabled={busy} onClick={() => load()}/>
      </>}/>
  </section>;
}
