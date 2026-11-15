import { useState } from 'react';
import { acceptProposal, dismissProposal, type ProposedRule } from '../api/core';
import { actionLabels } from '../inbox/inbox-labels';

export type Proposal = { id: string; rule: ProposedRule; state: 'open' | 'made' | 'dismissed' | 'failed'; note?: string };
const levels: Record<string, string> = { normal: 'normal', local_only: 'solo en este Mac', private: 'privado' };

/** The mail rules Watson proposed in this conversation, each exactly as it would be created: nothing is
 * written until «Crear regla» (or a plain «sí» while only one is open). */
export function useProposals() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const settle = (id: string, change: Partial<Proposal>) => setProposals(list => list.map(p => p.id === id ? { ...p, ...change } : p));
  const accept = async (proposal: Proposal) => {
    try { const made = await acceptProposal(proposal.id); settle(proposal.id, { state: 'made', note: `Regla «${made.name}» creada: ya se aplica al correo pendiente y al que llegue.` }); }
    catch (failure) { settle(proposal.id, { state: 'failed', note: failure instanceof Error ? failure.message : 'No se pudo crear la regla.' }); }
  };
  const dismiss = (proposal: Proposal) => { settle(proposal.id, { state: 'dismissed', note: 'Propuesta descartada: no se ha creado nada.' }); void dismissProposal(proposal.id).catch(() => undefined); };
  /** A short «sí» or «no» answers the only open proposal; returns true when it did. */
  const answer = (text: string) => {
    const open = proposals.filter(p => p.state === 'open');
    if (open.length !== 1) return false;
    const said = text.trim().toLowerCase().replace(/[.!¡¿?]/g, '');
    if (['sí', 'si', 'vale', 'ok', 'créala', 'creala', 'adelante', 'sí, créala'].includes(said)) { void accept(open[0]); return true; }
    if (['no', 'no gracias', 'déjalo', 'dejalo'].includes(said)) { dismiss(open[0]); return true; }
    return false;
  };
  return { proposals, add: (id: string, rule: ProposedRule) => setProposals(list => list.some(p => p.id === id) ? list : [...list, { id, rule, state: 'open' }]),
    clear: () => setProposals([]), accept, dismiss, answer };
}

export function RuleProposals({ state, discreet }: { state: ReturnType<typeof useProposals>; discreet: boolean }) {
  if (!state.proposals.length) return null;
  return <>{state.proposals.map(proposal => <article key={proposal.id} className="card rule-proposal" aria-label="Regla propuesta">
    <strong>Regla del correo propuesta</strong>
    <dl className="reply-preview">
      <dt>Nombre</dt><dd>{discreet ? '•••' : proposal.rule.name}</dd>
      {proposal.rule.sender && <><dt>Remitente</dt><dd>{discreet ? '•••' : proposal.rule.sender}</dd></>}
      {proposal.rule.subject && <><dt>Asunto contiene</dt><dd>{discreet ? '•••' : proposal.rule.subject}</dd></>}
      {proposal.rule.words && <><dt>Palabras</dt><dd>{discreet ? '•••' : proposal.rule.words}</dd></>}
      <dt>Acción</dt><dd>{actionLabels[proposal.rule.action] ?? proposal.rule.action}</dd>
      {proposal.rule.confidentiality && <><dt>Confidencialidad</dt><dd>{levels[proposal.rule.confidentiality]}</dd></>}
    </dl>
    {proposal.state === 'open' ? <>
      <p className="muted">Solo se crea si la confirmas (o respondes «sí»). Se aplica también al correo que ya está sin decidir; la puedes cambiar o quitar en Ajustes › Correo.</p>
      <div className="field-row">
        <button type="button" className="button primary" onClick={() => void state.accept(proposal)}>Crear regla</button>
        <button type="button" className="button" onClick={() => state.dismiss(proposal)}>No</button>
      </div>
    </> : <p className={proposal.state === 'made' ? 'ok-note' : 'muted'} role="status">{proposal.note}</p>}
  </article>)}</>;
}
