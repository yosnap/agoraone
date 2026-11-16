import { useState } from 'react';
import { cleanMailFromProposal, dismissProposal, type CleanupMessage } from '../api/core';

type Cleanup = { id: string; action: 'archive' | 'trash'; messages: CleanupMessage[]; state: 'open' | 'busy' | 'made' | 'dismissed'; result?: string };
const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: '2-digit' }) : '';

/** Mail Watson proposed to tidy (1.7): the whole list, each message with its box; only the ones left ticked move
 * to the account's archive or trash, with «Archivar» or «Mover a la Papelera». Never deleted for good. */
export function useCleanupProposals(onMade?: () => void) {
  const [list, setList] = useState<Cleanup[]>([]);
  const settle = (id: string, change: Partial<Cleanup>) => setList(all => all.map(p => p.id === id ? { ...p, ...change } : p));
  const run = async (proposal: Cleanup, ids: number[]) => {
    settle(proposal.id, { state: 'busy' });
    try {
      const done = await cleanMailFromProposal(proposal.id, ids);
      settle(proposal.id, { state: 'made', result: `${done.moved} ${done.moved === 1 ? 'correo movido' : 'correos movidos'} ${proposal.action === 'trash' ? 'a la Papelera' : 'al archivo'}.${done.problems.length ? ` No se pudo en: ${done.problems.join('; ')}.` : ''}` });
      onMade?.();
    } catch (failure) { settle(proposal.id, { state: 'dismissed', result: failure instanceof Error ? failure.message : 'No se pudo.' }); }
  };
  const dismiss = (proposal: Cleanup) => { settle(proposal.id, { state: 'dismissed', result: 'Descartado: no se ha movido nada.' }); void dismissProposal(proposal.id).catch(() => undefined); };
  return { list, run, dismiss, clear: () => setList([]),
    add: (id: string, action: Cleanup['action'], messages: CleanupMessage[]) => setList(all => all.some(p => p.id === id) ? all : [...all, { id, action, messages, state: 'open' }]) };
}

function CleanupCard({ proposal, state, discreet }: { proposal: Cleanup; state: ReturnType<typeof useCleanupProposals>; discreet: boolean }) {
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(proposal.messages.map(m => m.id)));
  const toggle = (id: number) => setChosen(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const trash = proposal.action === 'trash';
  const open = proposal.state === 'open' || proposal.state === 'busy';
  return <article className="card note-proposal" aria-label="Limpieza del correo propuesta">
    <strong>{trash ? 'Mover a la Papelera' : 'Archivar'}: {proposal.messages.length} {proposal.messages.length === 1 ? 'correo' : 'correos'}</strong>
    <small className="muted">Desmarca los que quieras conservar en la bandeja de entrada. {trash ? 'Quedan en la Papelera de su cuenta, recuperables.' : 'Van al archivo de su cuenta.'}</small>
    {open && <>
      <div className="inbox-actions"><button type="button" className="button" onClick={() => setChosen(new Set())}>Ninguno</button>
        <button type="button" className="button" onClick={() => setChosen(new Set(proposal.messages.map(m => m.id)))}>Todos</button></div>
      <ul className="cleanup-list">{proposal.messages.map(message => <li key={message.id}><label className="check">
        <input type="checkbox" checked={chosen.has(message.id)} onChange={() => toggle(message.id)}/>
        <span className="cleanup-text"><strong>{discreet && message.level !== 'normal' ? 'Correo reservado' : message.subject}</strong>
          <small>{discreet && message.level !== 'normal' ? '' : message.from} · {day(message.date)} · {message.account}</small></span>
      </label></li>)}</ul>
      <div className="inbox-actions">
        <button type="button" className={`button ${trash ? 'act-delete' : 'act-run'}`} disabled={proposal.state === 'busy' || chosen.size === 0}
          onClick={() => void state.run(proposal, [...chosen])}>{proposal.state === 'busy' ? 'Moviendo…' : `${trash ? 'Mover a la Papelera' : 'Archivar'} ${chosen.size}`}</button>
        <button type="button" className="button" onClick={() => state.dismiss(proposal)}>Descartar</button>
      </div>
    </>}
    {proposal.result && <small className={proposal.state === 'made' ? 'ok-note' : 'muted'} role="status">{proposal.result}</small>}
  </article>;
}

export function CleanupProposals({ state, discreet }: { state: ReturnType<typeof useCleanupProposals>; discreet: boolean }) {
  if (!state.list.length) return null;
  return <>{state.list.map(proposal => <CleanupCard key={proposal.id} proposal={proposal} state={state} discreet={discreet}/>)}</>;
}
