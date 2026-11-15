import { useState } from 'react';
import { moveVaultNote, readVaultNote } from '../api/client';
import { dismissProposal, type ReorgMove } from '../api/core';

type Outcome = { ok: boolean; text: string };
type Seen = { revision: string; title: string };
type Reorg = { id: string; summary: string; moves: ReorgMove[]; state: 'open' | 'busy' | 'made' | 'dismissed'; outcomes: Record<number, Outcome>; seen: Record<number, Seen>; result?: string };
const place = (folder: string) => folder || '(raíz)';

/** A batch of moves and renames Watson proposed to reorder the vault (1.7): every change with its box; only the
 * ones left ticked are applied, one by one, through the vault's own move route with the revision read when the card
 * appeared (a note changed since then is not moved), a copy first, never overwriting another note, never deleting. */
export function useReorgProposals() {
  const [list, setList] = useState<Reorg[]>([]);
  const settle = (id: string, change: (p: Reorg) => Partial<Reorg>) => setList(all => all.map(p => p.id === id ? { ...p, ...change(p) } : p));
  const run = async (proposal: Reorg, chosen: ReorgMove[]) => {
    settle(proposal.id, () => ({ state: 'busy' }));
    let moved = 0;
    for (const move of chosen) {
      let outcome: Outcome;
      try {
        const note = proposal.seen[move.n] ?? await readVaultNote(move.source, move.ref);
        await moveVaultNote(move.source, move.ref, { folder: move.toFolder, title: move.toTitle ?? note.title, revision: note.revision });
        moved += 1;
        outcome = { ok: true, text: 'Hecho' };
      } catch (failure) { outcome = { ok: false, text: failure instanceof Error ? failure.message : 'No se pudo.' }; }
      settle(proposal.id, p => ({ outcomes: { ...p.outcomes, [move.n]: outcome } }));
    }
    void dismissProposal(proposal.id).catch(() => undefined);  // used: Watson's proposal is let go
    const failed = chosen.length - moved;
    settle(proposal.id, () => ({ state: 'made', result: `${moved} ${moved === 1 ? 'nota reordenada' : 'notas reordenadas'}${failed ? `; ${failed} no se ${failed === 1 ? 'pudo' : 'pudieron'} (mira el motivo en cada una)` : ''}. Hay copia previa de cada una.` }));
  };
  const dismiss = (proposal: Reorg) => { settle(proposal.id, () => ({ state: 'dismissed', result: 'Descartado: no se ha movido nada.' })); void dismissProposal(proposal.id).catch(() => undefined); };
  return { list, run, dismiss, clear: () => setList([]),
    add: (id: string, summary: string, moves: ReorgMove[]) => {
      setList(all => all.some(p => p.id === id) ? all : [...all, { id, summary, moves, state: 'open', outcomes: {}, seen: {} }]);
      // The revision each note has now, as the user sees the batch: «Aplicar» moves exactly that version.
      for (const move of moves) void readVaultNote(move.source, move.ref)
        .then(note => settle(id, p => ({ seen: { ...p.seen, [move.n]: { revision: note.revision, title: note.title } } }))).catch(() => undefined);
    } };
}

function Change({ move, checked, onToggle, outcome, locked }: { move: ReorgMove; checked: boolean; onToggle: () => void; outcome?: Outcome; locked: boolean }) {
  const moving = move.toFolder !== move.folder;
  return <li><label className="check">
    <input type="checkbox" checked={checked} onChange={onToggle} disabled={locked}/>
    <span className="cleanup-text">
      <strong>{move.title}{move.toTitle && <> → {move.toTitle}</>}</strong>
      <small>{moving ? <>{place(move.folder)} → {place(move.toFolder)}{move.newFolder && ' (carpeta nueva)'}</> : `En ${place(move.folder)}, solo cambia el título`}{move.reason && ` · ${move.reason}`}</small>
      {move.links > 0 && <small className="reorg-warn">{move.links === 1 ? 'Un enlace' : `${move.links} enlaces`} [[…]] a esta nota dejará{move.links === 1 ? '' : 'n'} de funcionar.</small>}
      {outcome && <small className={outcome.ok ? 'ok-note' : 'reorg-warn'}>{outcome.text}</small>}
    </span>
  </label></li>;
}

function ReorgCard({ proposal, state }: { proposal: Reorg; state: ReturnType<typeof useReorgProposals> }) {
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(proposal.moves.map(m => m.n)));
  const toggle = (n: number) => setChosen(current => { const next = new Set(current); if (next.has(n)) next.delete(n); else next.add(n); return next; });
  const open = proposal.state === 'open';
  const shown = open ? proposal.moves : proposal.state === 'dismissed' ? [] : proposal.moves.filter(m => chosen.has(m.n));
  return <article className="card note-proposal" aria-label="Reorganización del vault propuesta">
    <strong>Reordenar el vault: {proposal.moves.length} {proposal.moves.length === 1 ? 'cambio' : 'cambios'}</strong>
    {proposal.summary && <p>{proposal.summary}</p>}
    {open && <small className="muted">Desmarca lo que no quieras cambiar. Cada nota se mueve con copia previa; nunca se borra ni se pisa otra.</small>}
    {open && <div className="inbox-actions"><button type="button" className="button" onClick={() => setChosen(new Set())}>Ninguno</button>
      <button type="button" className="button" onClick={() => setChosen(new Set(proposal.moves.map(m => m.n)))}>Todos</button></div>}
    {shown.length > 0 && <ul className="cleanup-list">{shown.map(move => <Change key={move.n} move={move} checked={chosen.has(move.n)} onToggle={() => toggle(move.n)}
      outcome={proposal.outcomes[move.n]} locked={!open}/>)}</ul>}
    {(open || proposal.state === 'busy') && <div className="inbox-actions">
      <button type="button" className="button act-run" disabled={!open || chosen.size === 0}
        onClick={() => void state.run(proposal, proposal.moves.filter(m => chosen.has(m.n)))}>{proposal.state === 'busy' ? 'Aplicando…' : `Aplicar ${chosen.size}`}</button>
      <button type="button" className="button" disabled={!open} onClick={() => state.dismiss(proposal)}>Descartar</button>
    </div>}
    {proposal.result && <small className={proposal.state === 'made' ? 'ok-note' : 'muted'} role="status">{proposal.result}</small>}
  </article>;
}

export function ReorgProposals({ state }: { state: ReturnType<typeof useReorgProposals> }) {
  if (!state.list.length) return null;
  return <>{state.list.map(proposal => <ReorgCard key={proposal.id} proposal={proposal} state={state}/>)}</>;
}
