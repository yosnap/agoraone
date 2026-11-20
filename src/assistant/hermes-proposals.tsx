import { useEffect, useRef, useState } from 'react';
import { createConversation, getHermesCatalog, sendMessage, cancelTurn, type ToolApproval } from '../api/client';
import type { HermesProposal } from '../api/core';
import type { HermesProfile } from '../../shared/hermes-catalog';
import { ApprovalCard } from '../ui/approval-card';

type Shown = { key: number; proposal: HermesProposal };

/** Tasks Watson proposed for a Hermes profile. Nothing is sent until the user presses «Enviar a <perfil>»; then the
 * profile's own agent answers in a conversation of that profile, asking «Permitir» for every tool that is not a
 * local read. Its answer goes back to Watson only if the user passes it on. A card whose task is running is kept
 * when the chat is cleared, so its approvals stay on screen. */
export function useHermesProposals() {
  const [list, setList] = useState<Shown[]>([]);
  const counter = useRef(0);
  const running = useRef(new Set<number>());
  return {
    list, running,
    add: (proposal: HermesProposal) => { const key = ++counter.current; setList(all => [...all, { key, proposal }]); },
    close: (key: number) => setList(all => all.filter(p => p.key !== key)),
    clear: () => setList(all => all.filter(p => running.current.has(p.key))),
  };
}

type PassBack = (profile: string, label: string, reply: string) => Promise<boolean>;

export function HermesProposals({ state, name, busy, onPassBack }: { state: ReturnType<typeof useHermesProposals>; name: string; busy: boolean; onPassBack: PassBack }) {
  const [profiles, setProfiles] = useState<HermesProfile[] | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    if (!state.list.length || profiles) return;
    getHermesCatalog().then(catalog => setProfiles(catalog.profiles)).catch(() => setProblem('No se pudo leer el catálogo de Hermes.'));
  }, [state.list.length, profiles]);
  if (!state.list.length) return null;
  return <>{state.list.map(({ key, proposal }) => <HermesTask key={key} id={`hermes-task-${key}`} proposal={proposal} problem={problem}
    profile={profiles?.find(p => p.name === proposal.profile) ?? null} loading={!profiles && !problem} name={name} busy={busy}
    onRunning={on => { if (on) state.running.current.add(key); else state.running.current.delete(key); }}
    onClose={() => state.close(key)} onPassBack={onPassBack}/>)}</>;
}

function HermesTask({ id, proposal, profile, loading, problem, name, busy, onRunning, onClose, onPassBack }: {
  id: string; proposal: HermesProposal; profile: HermesProfile | null; loading: boolean; problem: string; name: string; busy: boolean;
  onRunning: (on: boolean) => void; onClose: () => void; onPassBack: PassBack;
}) {
  const [task, setTask] = useState(proposal.task);
  const [phase, setPhase] = useState<'draft' | 'sending' | 'done'>('draft');
  const [stage, setStage] = useState('');
  const [partial, setPartial] = useState('');
  const [reply, setReply] = useState('');
  const [approvals, setApprovals] = useState<ToolApproval[]>([]);
  const [error, setError] = useState('');
  const [passing, setPassing] = useState(false);
  // The conversation is created once and reused if the task is sent again after an error.
  const conversation = useRef<string | null>(null);
  const sending = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const label = profile?.label || proposal.profile;
  // Leaving the chat while the profile works stops its turn: nobody would see its approvals any more.
  useEffect(() => () => {
    if (sending.current && conversation.current) { cancelTurn(conversation.current).catch(() => {}); abort.current?.abort(); }
    onRunning(false);
  }, []);  // once, on leaving: the callbacks it uses only touch refs
  async function send() {
    if (!profile || !task.trim() || sending.current) return;
    sending.current = true; onRunning(true);
    setPhase('sending'); setError(''); setPartial(''); setApprovals([]); setStage('Preparando conversación');
    const controller = new AbortController();
    abort.current = controller;
    try {
      conversation.current ??= (await createConversation(profile.id)).id;
      const current = conversation.current;
      const done = await sendMessage(current, task.trim(), undefined, event => {
        if (event.type === 'delta') { setPartial(previous => previous + event.text); setStage('Recibiendo respuesta'); }
        else if (event.type === 'tool') setStage(event.state === 'start' ? `Usando ${event.name}` : 'Esperando al proveedor');
        else if (event.type === 'approval') { setApprovals(previous => [...previous, event]); setStage('Esperando tu confirmación'); }
        else if (event.type === 'approval-settled') setApprovals(previous => previous.map(item => item.requestId === event.requestId && event.reason !== 'resolved' ? { ...item, expired: event.reason } : item));
        else setStage(event.stage === 'starting' ? 'Iniciando Hermes' : 'Esperando al proveedor');
      }, controller.signal);
      const last = [...done.messages].reverse().find(m => m.role === 'assistant');
      setReply(last?.content ?? ''); setPhase('done');
      // The profile's chat opens this conversation next time, to continue it there.
      try { localStorage.setItem(`agora-profile-conversation-${profile.id}`, current); } catch { /* without storage it is not reopened */ }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) { setError(e instanceof Error ? e.message : 'No se pudo enviar.'); setPhase('draft'); }
    } finally { sending.current = false; onRunning(false); abort.current = null; setApprovals([]); setPartial(''); }
  }
  async function passBack() {
    setPassing(true);
    const ok = await onPassBack(proposal.profile, label, reply);
    setPassing(false);
    if (ok) onClose();
  }
  return <article className="card note-proposal" aria-label={`Encargo propuesto para ${label}`}>
    <strong>Encargo para {label} (Hermes)</strong>
    {phase === 'draft' && <>
      <small>Se envía tal cual como mensaje tuyo al perfil, que trabaja con sus propias herramientas: cada una que no sea de lectura local te pedirá «Permitir».</small>
      <label htmlFor={id} className="visually-hidden">Texto del encargo</label>
      <textarea id={id} value={task} onChange={event => setTask(event.target.value)} maxLength={4000} rows={5}/>
      {loading && <p className="muted">Buscando el perfil…</p>}
      {problem && <p role="alert" className="error">{problem}</p>}
      {!loading && !problem && !profile && <p role="alert" className="error">El perfil «{proposal.profile}» no está en el catálogo de Hermes.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions"><button type="button" onClick={onClose}>Descartar</button>
        <button type="button" className="primary" disabled={!profile || !task.trim()} onClick={send}>Enviar a {label}</button></div>
    </>}
    {phase === 'sending' && <>
      {conversation.current && approvals.map(item => <ApprovalCard key={item.requestId} conversationId={conversation.current!} approval={item} label={label}
        onAnswered={() => setApprovals(previous => previous.filter(other => other.requestId !== item.requestId))}/>)}
      {partial && <p className="pre-wrap">{partial}</p>}
      <p className="pending" role="status">{stage}…{conversation.current && <button type="button" className="stop-turn"
        onClick={() => { cancelTurn(conversation.current!).catch(() => {}); setStage('Deteniendo'); }}>Detener</button>}</p>
    </>}
    {phase === 'done' && <>
      <small>Respuesta de {label}. También la tienes en el chat del perfil.</small>
      <p className="pre-wrap">{reply || 'El perfil no devolvió texto.'}</p>
      {reply && <small>Si se la pasas a {name}, sale de este Mac hacia su modelo, sin las líneas que parezcan claves.</small>}
      <div className="actions"><button type="button" onClick={onClose}>Cerrar</button>
        {reply && <button type="button" className="primary" disabled={busy || passing} title={busy ? `${name} está respondiendo` : undefined}
          onClick={passBack}>Pasar la respuesta a {name}</button>}</div>
    </>}
  </article>;
}
