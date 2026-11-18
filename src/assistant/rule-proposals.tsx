import { useState } from 'react';
import { acceptProposal, dismissProposal, type ProposedRule } from '../api/core';
import { actionLabels } from '../inbox/inbox-labels';
import { hereLabel } from '../ui/platform';

export type Proposal = { id: string; rule: ProposedRule; state: 'open' | 'busy' | 'made' | 'dismissed' | 'failed'; note?: string };
const levels: Record<string, string> = { normal: 'normal', local_only: `solo en ${hereLabel}`, private: 'privado' };

/** The mail rules Watson proposed in this conversation, each exactly as it would be created: nothing is
 * written until «Crear regla» (or a plain «sí» while only one is open). */
export function useProposals() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const settle = (id: string, change: Partial<Proposal>) => setProposals(list => list.map(p => p.id === id ? { ...p, ...change } : p));
  const accept = async (proposal: Proposal) => {
    if (proposal.state !== 'open') return;
    settle(proposal.id, { state: 'busy' });
    try { const made = await acceptProposal(proposal.id); settle(proposal.id, { state: 'made', note: `Regla «${made.name}» creada: ya se aplica al correo pendiente y al que llegue.` }); }
    catch (failure) { settle(proposal.id, { state: 'failed', note: failure instanceof Error ? failure.message : 'No se pudo crear la regla.' }); }
  };
  const dismiss = (proposal: Proposal) => { settle(proposal.id, { state: 'dismissed', note: 'Propuesta descartada: no se ha creado nada.' }); void dismissProposal(proposal.id).catch(() => undefined); };
  /** A short «sí» or «no» answers the proposal of Watson's last answer, and only that one: anything else
   * written in between expires it (see `expire`). Never a rule that ignores mail, and never in discreet mode,
   * where the rule cannot be seen: those need the button. Returns true when it answered. */
  const answer = (text: string, discreet: boolean) => {
    const open = proposals.filter(p => p.state === 'open');
    if (open.length !== 1 || discreet || open[0].rule.action === 'ignore') return false;
    const said = text.trim().toLowerCase().replace(/[.!¡¿?]/g, '');
    if (['sí', 'si', 'vale', 'ok', 'créala', 'creala', 'adelante', 'sí, créala'].includes(said)) { void accept(open[0]); return true; }
    if (['no', 'no gracias', 'déjalo', 'dejalo'].includes(said)) { dismiss(open[0]); return true; }
    return false;
  };
  /** The user wrote something else: an open proposal no longer answers a «sí»; it is asked for again. */
  const expire = () => setProposals(list => list.map(p => p.state === 'open' ? { ...p, state: 'dismissed', note: 'Sin confirmar: si la quieres, pídesela otra vez a Watson.' } : p));
  return { proposals, expire, add: (id: string, rule: ProposedRule) => setProposals(list => list.some(p => p.id === id) ? list : [...list, { id, rule, state: 'open' }]),
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
    {proposal.state === 'open' || proposal.state === 'busy' ? <>
      {proposal.rule.action === 'ignore' && <p className="fiscal-warning">«Ignorar» deja en silencio ese correo: no aparecerá en la Bandeja, tampoco el que ya está sin decidir. Confírmalo con el botón.</p>}
      <p className="muted">{discreet ? 'Sal del modo discreto para verla y confirmarla.' : `Solo se crea si la confirmas${proposal.rule.action === 'ignore' ? '' : ' (o respondes «sí» ahora)'}. Se aplica también al correo que ya está sin decidir; la puedes cambiar o quitar en Ajustes › Correo.`}</p>
      <div className="field-row">
        <button type="button" className="button primary" disabled={discreet || proposal.state === 'busy'} onClick={() => void state.accept(proposal)}>{proposal.state === 'busy' ? 'Creando…' : 'Crear regla'}</button>
        <button type="button" className="button" disabled={proposal.state === 'busy'} onClick={() => state.dismiss(proposal)}>No</button>
      </div>
    </> : <p className={proposal.state === 'made' ? 'ok-note' : 'muted'} role="status">{proposal.note}</p>}
  </article>)}</>;
}
