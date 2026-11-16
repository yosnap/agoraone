import { useState } from 'react';
import { createIssueFromProposal, dismissProposal, type ProposedIssue } from '../api/core';

type IssueProposal = { id: string; issue: ProposedIssue; state: 'open' | 'busy' | 'made' | 'dismissed'; result?: string; url?: string };

/** GitHub issues Watson prepared from a meeting: shown whole (repository, title and body) and created with the
 * user's own GitHub CLI only with «Crear la issue». */
export function useIssueProposals() {
  const [list, setList] = useState<IssueProposal[]>([]);
  const settle = (id: string, change: Partial<IssueProposal>) => setList(all => all.map(p => p.id === id ? { ...p, ...change } : p));
  const create = async (proposal: IssueProposal) => {
    settle(proposal.id, { state: 'busy' });
    try {
      const made = await createIssueFromProposal(proposal.id);
      settle(proposal.id, { state: 'made', result: `Issue creada en ${made.repo}.`, url: made.url });
    } catch (failure) { settle(proposal.id, { state: 'dismissed', result: failure instanceof Error ? failure.message : 'GitHub no la creó.' }); }
  };
  const dismiss = (proposal: IssueProposal) => { settle(proposal.id, { state: 'dismissed', result: 'Issue descartada: no se ha creado nada.' }); void dismissProposal(proposal.id).catch(() => undefined); };
  return { list, create, dismiss, add: (id: string, issue: ProposedIssue) => setList(all => all.some(p => p.id === id) ? all : [...all, { id, issue, state: 'open' }]), clear: () => setList([]) };
}

export function IssueProposals({ state }: { state: ReturnType<typeof useIssueProposals> }) {
  if (!state.list.length) return null;
  return <>{state.list.map(proposal => {
    const { issue } = proposal;
    return <article key={proposal.id} className="card note-proposal" aria-label="Issue propuesta">
      <strong>Issue propuesta: {issue.title}</strong>
      <small>En {issue.repo} · {issue.client ? `${issue.client} › ` : ''}{issue.project}{issue.meeting ? ` · de la reunión «${issue.meeting}»` : ''}</small>
      {issue.visibility === 'public' ? <small className="fiscal-warning" role="note">Repositorio PÚBLICO: cualquiera en internet verá esta issue. Revisa que no lleve nada privado de la reunión.</small>
        : issue.visibility === null ? <small className="muted">No se ha podido saber si el repositorio es público: la verá quien pueda ver {issue.repo}.</small>
        : <small className="muted">Repositorio privado: la verá quien tenga acceso a {issue.repo}.</small>}
      <pre className="issue-body">{issue.body}</pre>
      {proposal.state === 'open' || proposal.state === 'busy' ? <div className="inbox-actions">
        <button type="button" className="button primary" disabled={proposal.state === 'busy'} onClick={() => void state.create(proposal)}>{proposal.state === 'busy' ? 'Creando en GitHub…' : issue.visibility === 'public' ? 'Crear la issue pública' : 'Crear la issue'}</button>
        <button type="button" className="button" disabled={proposal.state === 'busy'} onClick={() => state.dismiss(proposal)}>Descartar</button>
      </div> : null}
      {proposal.result && <small className={proposal.state === 'made' ? 'ok-note' : 'muted'} role="status">{proposal.result}{proposal.url && <> <a href={proposal.url} target="_blank" rel="noopener noreferrer">Abrir en GitHub</a></>}</small>}
    </article>;
  })}</>;
}
