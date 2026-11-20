import { useEffect, useState } from 'react';
import { getCrmdevPending, type CrmdevPending } from '../api/clients';
import { pendingTotal } from '../jobs/clients-view';
import { openCrmdevTab } from '../crmdev/use-crmdev-view';
import type { Section } from '../shell/shell-state';

/** What Central has and CRMDev lacks or has otherwise, only counted (no name, so also in discreet mode); «Ver» opens
 * the list in CRMDev › Desde Central. Hidden while there is nothing or either is not read. */
export function CrmdevPendingCard({ onOpen }: { onOpen: (section: Section) => void }) {
  const [data, setData] = useState<CrmdevPending | null>(null);
  useEffect(() => {
    let alive = true;
    getCrmdevPending().then(found => { if (alive) setData(found); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  if (!data?.active || !pendingTotal(data.counts)) return null;
  const { counts } = data;
  const parts = [
    [counts.client_missing + counts.contact_missing, 'clientes o contactos por enviar'],
    [counts.project_missing, 'proyectos por enviar'],
    [counts.client_changed + counts.project_changed, 'con datos distintos'],
    [counts.crmdev_only, 'de CRMDev sin Central'],
  ].filter(([n]) => n) as [number, string][];
  return <article className="card" aria-labelledby="crmdev-pending-title">
    <div className="card-head"><h2 id="crmdev-pending-title">Pendiente en CRMDev</h2></div>
    <p className="muted">Lo que tiene Central y falta o es distinto en CRMDev.</p>
    <div className="field-row">
      {parts.map(([n, label]) => <span key={label}>{n} {label}</span>)}
      <span className="actions"><button type="button" className="button" onClick={() => { openCrmdevTab('central'); onOpen('crmdev'); }}>Ver lo pendiente</button></span>
    </div>
  </article>;
}
