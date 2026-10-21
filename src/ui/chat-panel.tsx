import { useEffect, useRef, useState, type FormEvent } from 'react';
import { cancelTurn, createConversation, getConversation, sendMessage, type Conversation, type Status, type DocumentSource, type ToolApproval } from '../api/client';
import { ApprovalCard } from './approval-card';

export type ChatState = { busy: boolean; approvals: number };

export function ChatPanel({ status, onConnected, document, onDetach, profile, onState }: {
  status: Status | null; onConnected: () => void; document?: DocumentSource; onDetach?: () => void;
  profile?: { id: string; label: string };
  /** Tells the app while a turn runs and how many approvals wait, so it can keep this chat alive and point back to it. */
  onState?: (state: ChatState) => void;
}) {
  const label = profile?.label || 'Luma';
  const storageKey = profile ? `agora-profile-conversation-${profile.id}` : 'agora-luma-conversation';
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState('');
  const [stage, setStage] = useState('Preparando conversación');
  const [elapsed, setElapsed] = useState(0);
  const [restoring, setRestoring] = useState(true);
  const [approvals, setApprovals] = useState<ToolApproval[]>([]);
  const [usedTools, setUsedTools] = useState<string[]>([]);
  // Profiles answer with their own agent and provider; only Luma depends on AgoraOne's provider.
  const ready = !!profile || status?.state === 'configured';
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    const id = localStorage.getItem(storageKey);
    setRestoring(true); setConversation(null);
    if (id) getConversation(id).then(data => {
      if (!live) return;
      if (data.profileId !== profile?.id) { localStorage.removeItem(storageKey); return; }
      setConversation(data);
    }).catch(() => { if (live) localStorage.removeItem(storageKey); }).finally(() => { if (live) setRestoring(false); });
    else setRestoring(false);
    return () => { live = false; };
  }, [storageKey, profile?.id]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [conversation, busy, partial]);
  const waiting = approvals.filter(item => !item.expired).length;
  // Only the values matter: the callback may be a new function on every render.
  useEffect(() => { onState?.({ busy, approvals: waiting }); }, [busy, waiting]);
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!message.trim() || busy || restoring) return;
    setBusy(true); setError(''); setPartial(''); setElapsed(0); setStage('Preparando conversación'); setApprovals([]); setUsedTools([]);
    try {
      const current = conversation || await createConversation(profile?.id);
      if (current.profileId !== profile?.id) throw new Error('La conversación no pertenece al perfil seleccionado.');
      setConversation(current); localStorage.setItem(storageKey, current.id);
      setConversation(await sendMessage(current.id, message, document?.id, event => {
        if (event.type === 'delta') { setPartial(previous => previous + event.text); setStage('Recibiendo respuesta'); }
        else if (event.type === 'tool') { setStage(event.state === 'start' ? `Usando ${event.name}` : 'Esperando al proveedor'); if (event.state === 'end') setUsedTools(previous => previous.includes(event.name) ? previous : [...previous, event.name]); }
        else if (event.type === 'approval') { setApprovals(previous => [...previous, event]); setStage('Esperando tu confirmación'); }
        else if (event.type === 'approval-settled') setApprovals(previous => previous.map(item => item.requestId === event.requestId && event.reason !== 'resolved' ? { ...item, expired: event.reason } : item));
        else setStage(event.stage === 'starting' ? 'Iniciando Hermes' : 'Esperando al proveedor');
      })); setMessage(''); onConnected();
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo enviar.'); }
    finally { setBusy(false); setPartial(''); setApprovals([]); setUsedTools([]); }
  }
  return <section className="chat" aria-label={`Conversación con ${label}`}>
    <div className="chat-heading"><span className="eyebrow">CONVERSACIÓN · HERMES</span><button disabled={busy || restoring} onClick={() => { setConversation(null); setError(''); localStorage.removeItem(storageKey); }}>Nueva</button></div>
    <div className="messages" role="log" aria-live="polite">
      {!conversation?.messages.length && <div className="chat-empty"><span>✧</span><h3>Una idea empieza<br/>con una conversación.</h3><p>{profile ? `Habla con ${label} como en Telegram: su modelo, sus herramientas y su memoria. Antes de cada acción que cambie algo te pedirá permiso aquí. Puedes adjuntar una nota del vault o un documento de la biblioteca con «Consultar con».` : 'Luma conversa a través de Hermes. Puedes adjuntar un documento de la biblioteca o una nota del vault.'}</p></div>}
      {conversation?.messages.map((item, index) => <article className={`message ${item.role}`} key={index}><strong>{item.role === 'user' ? 'Tú' : `${label} · Hermes`}</strong><p>{item.content}</p>{item.tools && <small>Herramientas usadas: {item.tools.join(', ')}</small>}{item.sources?.map(source => <small key={source.id}>Documento enviado: {source.title} · versión {source.revision.slice(0, 8)}</small>)}{item.identity && <small>Identidad enviada: {item.identity.files.map(file => `${file.name} (${file.revision.slice(0, 8)})`).join(', ') || 'nombre del perfil; sin archivos de identidad'}</small>}</article>)}
      {busy && <><article className="message user"><strong>Tú</strong><p>{message}</p></article>{usedTools.length > 0 && <p className="tools-used">Herramientas usadas: {usedTools.join(', ')}</p>}{conversation && approvals.map(item => <ApprovalCard key={item.requestId} conversationId={conversation.id} approval={item} label={label} onAnswered={() => setApprovals(previous => previous.filter(other => other.requestId !== item.requestId))}/>)}{partial && <article className="message assistant"><strong>{label} · Hermes</strong><p>{partial}</p></article>}<p className="pending" role="status">{stage}… {elapsed} s{profile && conversation && <button type="button" className="stop-turn" onClick={() => { cancelTurn(conversation.id).catch(() => {}); setStage('Deteniendo'); }}>Detener</button>}</p></>}<div ref={bottom}/>
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    {!ready && <p className="notice">{status?.detail || 'Comprobando el backend…'}</p>}
    {document && <div className="document-attached"><span>Solo lectura: {document.title}</span><button disabled={busy} onClick={onDetach} aria-label="Quitar documento">×</button></div>}
    <form onSubmit={submit}><label htmlFor="message">Tu mensaje a {label}</label><textarea id="message" placeholder="¿Qué te gustaría explorar?" maxLength={6000} value={message} onChange={e => setMessage(e.target.value)} disabled={busy || restoring}/><button className="primary" disabled={busy || restoring || !message.trim() || !ready}>{busy ? 'Consultando…' : 'Enviar a Hermes ↗'}</button></form>
    <small>{profile ? `Usa el proveedor, las herramientas, los MCP y la memoria del propio perfil${document ? ', con el texto del documento adjunto' : ''}. Las consultas que solo leen se hacen sin preguntar; todo lo que cambie algo espera a que lo permitas.` : document ? 'Se enviará el texto del documento seleccionado a tu proveedor de inferencia. Se vuelve a leer en cada envío.' : 'Sin acceso directo al disco. Las respuestas utilizan tu proveedor de inferencia.'}</small>
  </section>;
}
