import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createConversation, getConversation, sendMessage, type Conversation, type Status, type DocumentSource } from '../api/client';

export function ChatPanel({ status, onConnected, document, onDetach, profile }: {
  status: Status | null; onConnected: () => void; document?: DocumentSource; onDetach?: () => void;
  profile?: { id: string; label: string };
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
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!message.trim() || busy || restoring) return;
    setBusy(true); setError(''); setPartial(''); setElapsed(0); setStage('Preparando conversación');
    try {
      const current = conversation || await createConversation(profile?.id);
      if (current.profileId !== profile?.id) throw new Error('La conversación no pertenece al perfil seleccionado.');
      setConversation(current); localStorage.setItem(storageKey, current.id);
      setConversation(await sendMessage(current.id, message, document?.id, event => {
        if (event.type === 'delta') { setPartial(previous => previous + event.text); setStage('Recibiendo respuesta'); }
        else setStage(event.stage === 'starting' ? 'Iniciando Hermes' : 'Esperando al proveedor');
      })); setMessage(''); onConnected();
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo enviar.'); }
    finally { setBusy(false); setPartial(''); }
  }
  return <section className="chat" aria-label={`Conversación con ${label}`}>
    <div className="chat-heading"><span className="eyebrow">CONVERSACIÓN · HERMES</span><button disabled={busy || restoring} onClick={() => { setConversation(null); setError(''); localStorage.removeItem(storageKey); }}>Nueva</button></div>
    <div className="messages" role="log" aria-live="polite">
      {!conversation?.messages.length && <div className="chat-empty"><span>✧</span><h3>Una idea empieza<br/>con una conversación.</h3><p>{profile ? `Conversación con la identidad de ${label}. Historial propio de AgoraOne, separado de Desktop y de otros perfiles.` : 'Luma conversa a través de Hermes. Puedes adjuntar un documento autorizado desde el catálogo de prueba.'}</p></div>}
      {conversation?.messages.map((item, index) => <article className={`message ${item.role}`} key={index}><strong>{item.role === 'user' ? 'Tú' : `${label} · Hermes`}</strong><p>{item.content}</p>{item.sources?.map(source => <small key={source.id}>Documento enviado: {source.title} · versión {source.revision.slice(0, 8)}</small>)}{item.identity && <small>Identidad enviada: {item.identity.files.map(file => `${file.name} (${file.revision.slice(0, 8)})`).join(', ') || 'nombre del perfil; sin archivos de identidad'}</small>}</article>)}
      {busy && <><article className="message user"><strong>Tú</strong><p>{message}</p></article>{partial && <article className="message assistant"><strong>{label} · Hermes</strong><p>{partial}</p></article>}<p className="pending" role="status">{stage}… {elapsed} s</p></>}<div ref={bottom}/>
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    {status?.state !== 'configured' && <p className="notice">{status?.detail || 'Comprobando el backend…'}</p>}
    {document && <div className="document-attached"><span>Solo lectura: {document.title}</span><button disabled={busy} onClick={onDetach} aria-label="Quitar documento">×</button></div>}
    <form onSubmit={submit}><label htmlFor="message">Tu mensaje a {label}</label><textarea id="message" placeholder="¿Qué te gustaría explorar?" maxLength={6000} value={message} onChange={e => setMessage(e.target.value)} disabled={busy || restoring}/><button className="primary" disabled={busy || restoring || !message.trim() || status?.state !== 'configured'}>{busy ? 'Consultando…' : 'Enviar a Hermes ↗'}</button></form>
    <small>{profile ? 'Al enviar, se releen y transmiten SOUL, MEMORY y USER del perfil al proveedor configurado en AgoraOne. Sin herramientas ni escritura de memoria. Puede diferir del modelo/proveedor de Desktop.' : document ? 'Se enviará el texto del documento seleccionado a tu proveedor de inferencia. Se vuelve a leer en cada envío.' : 'Sin acceso directo al disco. Las respuestas utilizan tu proveedor de inferencia.'}</small>
  </section>;
}
