import { useRef, useState } from 'react';
import type { CrmdevChangeRequest } from '../api/crmdev';
import { CrmdevReview, reviewing, Said } from '../crmdev/crmdev-common';
import { useCrmdevChange } from '../crmdev/use-crmdev-change';
import { ActionButton } from '../ui/action-button';

/** A change Watson proposed for CRMDev: the request the core checked, the reason, and the same review and «Guardar en
 * CRMDev» as the forms of the «CRMDev» section. A «sí» in the chat saves nothing: only that button does. */
/** `orgName`: the organization of CRMDev it goes to (that of the record it changes), said on the card. */
export type CrmdevProposal = { kind: 'tarea-nueva' | 'tarea' | 'ticket' | 'respuesta-ticket'; id: string | null; request: CrmdevChangeRequest; reason: string | null;
  org?: string; orgName?: string | null };
type Shown = { key: number; proposal: CrmdevProposal };

export function useCrmdevProposals() {
  const [list, setList] = useState<Shown[]>([]);
  const counter = useRef(0);
  return {
    list,
    add: (proposal: CrmdevProposal) => { const key = ++counter.current; setList(all => [...all, { key, proposal }]); },
    close: (key: number) => setList(all => all.filter(p => p.key !== key)),
    clear: () => setList([]),
  };
}

const TITLES = { 'tarea-nueva': 'Tarea nueva propuesta para CRMDev', tarea: 'Cambio de tarea propuesto para CRMDev', ticket: 'Cambio de ticket propuesto para CRMDev',
  'respuesta-ticket': 'Respuesta a un ticket propuesta para CRMDev' };
const FIELD_LABELS: Record<string, string> = { title: 'Título', description: 'Descripción', status: 'Estado', priority: 'Prioridad', category: 'Categoría', projectId: 'Proyecto' };

/** What Watson wrote, before reading CRMDev: the fields and values it proposes. */
export function proposedFields(request: CrmdevChangeRequest): [string, string][] {
  if (request.kind === 'respuesta-ticket') return [['Quién la ve', request.internal ? 'Solo el equipo (nota interna)' : 'El cliente'], ['Respuesta', request.content]];
  const values = ('values' in request ? request.values : 'changes' in request ? request.changes : {}) as Record<string, unknown>;
  return Object.entries(values).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [FIELD_LABELS[k] ?? k, String(v)]);
}

function CrmdevProposalCard({ proposal, onClose }: { proposal: CrmdevProposal; onClose: () => void }) {
  const [said, setSaid] = useState('');
  const change = useCrmdevChange(`watson:${proposal.kind}:${proposal.id ?? ''}:${JSON.stringify(proposal.request)}`, setSaid, null);
  if (said) return <><Said text={said}/><ActionButton icon="check" label="Cerrar" onClick={onClose}/></>;
  if (reviewing(change)) return <CrmdevReview change={change} onCancel={onClose} onReview={() => void change.ask(proposal.request)}/>;
  return <>
    {proposal.reason && <small className="muted">{proposal.reason}</small>}
    <dl className="orca-facts">{proposal.orgName && <div><dt>Organización</dt><dd>{proposal.orgName}</dd></div>}
      {proposedFields(proposal.request).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {change.error && <p className="error" role="alert">{change.error}</p>}
    <span className="actions">
      <ActionButton icon="close" label="Descartar" disabled={change.busy} onClick={onClose}/>
      <ActionButton icon="eye" label="Revisar el cambio" tone="primary" disabled={change.busy} onClick={() => void change.ask(proposal.request)}/>
    </span>
  </>;
}

export function CrmdevProposals({ state }: { state: ReturnType<typeof useCrmdevProposals> }) {
  if (!state.list.length) return null;
  return <>{state.list.map(({ key, proposal }) => <article key={key} className="card note-proposal" aria-label={TITLES[proposal.kind]}>
    <strong>{TITLES[proposal.kind]}</strong>
    <small className="muted">Nada se guarda hasta que revises el cambio exacto y pulses «Guardar en CRMDev».</small>
    <CrmdevProposalCard proposal={proposal} onClose={() => state.close(key)}/>
  </article>)}</>;
}
