import { useRef, useState } from 'react';
import type { OrcaProposal } from '../api/core';
import { OrcaLaunch } from '../orca/orca-launch';

type Shown = { key: number; proposal: OrcaProposal };

/** What Watson proposed to take to Orca: each opens the shared launch card, filled in and editable. Nothing is
 * launched until the user sees the preview and presses «Lanzar en Orca». */
export function useOrcaProposals() {
  const [list, setList] = useState<Shown[]>([]);
  const counter = useRef(0);
  return {
    list,
    add: (proposal: OrcaProposal) => { const key = ++counter.current; setList(all => [...all, { key, proposal }]); },
    close: (key: number) => setList(all => all.filter(p => p.key !== key)),
    clear: () => setList([]),
  };
}

export function OrcaProposals({ state }: { state: ReturnType<typeof useOrcaProposals> }) {
  if (!state.list.length) return null;
  return <>{state.list.map(({ key, proposal }) => <article key={key} className="card note-proposal" aria-label="Encargo propuesto para Orca">
    <strong>{proposal.botName ? `Encargo propuesto para el bot «${proposal.botName}»` : 'Encargo propuesto para Orca'}</strong>
    <small>En {proposal.repo} · {proposal.client} › {proposal.project}{proposal.issue ? ` · ${proposal.issue}` : ''}</small>
    <OrcaLaunch choices={[proposal]} project={proposal.project} task={proposal.task} agent={proposal.agent} bot={proposal.bot} kind={proposal.kind}
      source={proposal.issue ? { kind: 'issue', url: proposal.issue } : { kind: 'project' }} onClose={() => state.close(key)}/>
  </article>)}</>;
}
