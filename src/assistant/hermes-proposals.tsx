import { useEffect, useRef, useState } from 'react';
import { createConversation, getHermesCatalog, sendMessage, cancelTurn, type ToolApproval } from '../api/client';
import type { HermesProposal } from '../api/core';
import type { HermesProfile } from '../../shared/hermes-catalog';
import { ApprovalCard } from '../ui/approval-card';

type Shown = { key: number; proposal: HermesProposal };

/** Tasks Watson proposed for a Hermes profile. Nothing is sent until the user presses «Enviar a <perfil>»; then the
 * profile's own agent answers in a conversation of that profile, asking «Permitir» for every tool that is not a
 * local read. Its answer goes back to Watson only if the user passes it on. */
export function useHermesProposals() {
  const [list, setList] = useState<Shown[]>([]);
  const counter = useRef(0);
  return {
    list,
    add: (proposal: HermesProposal) => { const key = ++counter.current; setList(all => [...all, { key, proposal }]); },
    close: (key: number) => setList(all => all.filter(p => p.key !== key)),
    clear: () => setList([]),
  };
}

export function HermesProposals({ state, name, onPassBack }: { state: ReturnType<typeof useHermesProposals>; name: string; onPassBack: (profile: string, reply: string) => void }) {
  const [profiles, setProfiles] = useState<HermesProfile[] | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    if (!state.list.length || profiles) return;
    getHermesCatalog().then(catalog => setProfiles(catalog.profiles)).catch(() => setProblem('No se pudo leer el catálogo de Hermes.'));
  }, [state.list.length, profiles]);
  if (!state.list.length) return null;
  return <>{state.list.map(({ key, proposal }) => <HermesTask key={key} proposal={proposal} problem={problem}
    profile={profiles?.find(p => p.name === proposal.profile) ?? null} loading={!profiles && !problem} name={name}
    onClose={() => state.close(key)} onPassBack={onPassBack}/>)}</>;
}

function HermesTask({ proposal, profile, loading, problem, name, onClose, onPassBack }: {
  proposal: HermesProposal; profile: HermesProfile | null; loading: boolean; problem: string; name: string; onClose: () => void; onPassBack: (profile: string, reply: string) => void;
}) {
  const [task, setTask] = useState(proposal.task);
  const [phase, setPhase] = useState<'draft' | 'sending' | 'done'>('draft');
  const [stage, setStage] = useState('');
  const [partial, setPartial] = useState('');
  const [reply, setReply] = useState('');
  const [approvals, setApprovals] = useState<ToolApproval[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const label = profile?.label || proposal.profile;
  async function send() {
    if (!profile || !task.trim()) return;
    setPhase('sending'); setError(''); setPartial(''); setApprovals([]); setStage('Preparando conversación');
    try {
      const conversation = await createConversation(profile.id);
      setConversationId(conversation.id);
      // The profile's chat opens this same conversation, so the task can be followed and continued there.
      try { localStorage.setItem(`agora-profile-conversation-${profile.id}`, conversation.id); } catch { /* without storage it simply is not reopened */ }
      const done = await sendMessage(conversation.id, task.trim(), undefined, event => {
        if (event.type === 'delta') { setPartial(previous => previous + event.text); setStage('Recibiendo respuesta'); }
        else if (event.type === 'tool') setStage(event.state === 'start' ? `Usando ${event.name}` : 'Esperando al proveedor');
        else if (event.type === 'approval') { setApprovals(previous => [...previous, event]); setStage('Esperando tu confirmación'); }
        else if (event.type === 'approval-settled') setApprovals(previous => previous.map(item => item.requestId === event.requestId && event.reason !== 'resolved' ? { ...item, expired: event.reason } : item));
        else setStage(event.stage === 'starting' ? 'Iniciando Hermes' : 'Esperando al proveedor');
      });
      const last = [...done.messages].reverse().find(m => m.role === 'assistant');
      setReply(last?.content ?? ''); setPhase('done');
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo enviar.'); setPhase('draft'); }
    finally { setApprovals([]); setPartial(''); }
  }
  return <article className="card note-proposal" aria-label={`Encargo propuesto para ${label}`}>
    <strong>Encargo para {label} (Hermes)</strong>
    {phase === 'draft' && <>
      <small>Se envía tal cual como mensaje tuyo al perfil, que trabaja con sus propias herramientas: cada una que no sea de lectura local te pedirá «Permitir».</small>
      <label htmlFor={`hermes-task-${proposal.profile}`} className="visually-hidden">Texto del encargo</label>
      <textarea id={`hermes-task-${proposal.profile}`} value={task} onChange={event => setTask(event.target.value)} maxLength={4000} rows={5}/>
      {loading && <p className="muted">Buscando el perfil…</p>}
      {problem && <p role="alert" className="error">{problem}</p>}
      {!loading && !problem && !profile && <p role="alert" className="error">El perfil «{proposal.profile}» no está en el catálogo de Hermes.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions"><button type="button" onClick={onClose}>Descartar</button>
        <button type="button" className="primary" disabled={!profile || !task.trim()} onClick={send}>Enviar a {label}</button></div>
    </>}
    {phase === 'sending' && conversationId && <>
      {approvals.map(item => <ApprovalCard key={item.requestId} conversationId={conversationId} approval={item} label={label}
        onAnswered={() => setApprovals(previous => previous.filter(other => other.requestId !== item.requestId))}/>)}
      {partial && <p>{partial}</p>}
      <p className="pending" role="status">{stage}…<button type="button" className="stop-turn" onClick={() => { cancelTurn(conversationId).catch(() => {}); setStage('Deteniendo'); }}>Detener</button></p>
    </>}
    {phase === 'done' && <>
      <small>Respuesta de {label}. También la tienes en el chat del perfil.</small>
      <p style={{ whiteSpace: 'pre-wrap' }}>{reply || 'El perfil no devolvió texto.'}</p>
      <div className="actions"><button type="button" onClick={onClose}>Cerrar</button>
        {reply && <button type="button" className="primary" onClick={() => { onPassBack(label, reply); onClose(); }}>Pasar la respuesta a {name}</button>}</div>
    </>}
  </article>;
}
