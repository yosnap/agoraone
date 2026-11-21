import { useRef, useState } from 'react';
import { followBot, getBotRequests, sendBotErrand, type BotErrandKind, type BotErrandPreview, type BotRequest } from '../api/orca-bots';
import { askWatson } from '../assistant/pending-ask';
import type { Section } from '../shell/shell-state';
import { ActionButton } from '../ui/action-button';
import { BotErrandFacts } from './orca-bot-errand';

const states = { waiting: 'Esperando', answered: 'Respondió', silent: 'Sin respuesta en 30 min' } as const;
const POLL_MS = 15_000;
const message = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;

/** «Seguir el hilo»: the user's own text to the same chat of the bot, after its exact preview and «Enviar a <bot>». */
function FollowUp({ request, onDone }: { request: BotRequest; onDone: () => void }) {
  const [kind, setKind] = useState<BotErrandKind>('question');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<BotErrandPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true); setError('');
    try { await work(); } catch (failure) { setPreview(null); setError(message(failure, fallback)); } finally { setBusy(false); }
  };
  if (preview) return <div className="orca-launch">
    <BotErrandFacts preview={preview}/>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="orca-actions">
      <button type="button" className="button primary" disabled={busy} onClick={() => void run(async () => { await sendBotErrand(preview.id); onDone(); }, 'No se pudo enviar al bot.')}>
        {busy ? 'Enviando…' : `Enviar a ${preview.bot.name}`}</button>
      <button type="button" className="button" disabled={busy} onClick={() => setPreview(null)}>Cambiar</button>
    </div>
  </div>;
  return <form className="orca-launch" onSubmit={event => { event.preventDefault(); void run(async () => setPreview(await followBot(request.messageId, kind, text)), 'No se pudo preparar.'); }}>
    <div className="segmented" role="group" aria-label="Qué le pides">
      <button type="button" aria-pressed={kind === 'question'} onClick={() => setKind('question')}>Preguntar</button>
      <button type="button" aria-pressed={kind === 'handoff'} onClick={() => setKind('handoff')}>Encargar</button></div>
    <label className="field">Mensaje para {request.bot.name}<textarea value={text} rows={3} maxLength={4000} required onChange={event => setText(event.target.value)}/></label>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="orca-actions"><button type="submit" className="button primary" disabled={busy || !text.trim()}>{busy ? 'Preparando…' : 'Ver la vista previa'}</button></div>
  </form>;
}

/** The errands sent to bots and their answers, read from AgoraOne's mailbox in Orca. While one still waits, it is read
 * again every 15 s, only while this list is on screen. An answer is data: it triggers nothing, and it reaches Watson
 * only with «Pasar a Watson». */
export function BotRequests({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  const [data, setData] = useState<{ requests: BotRequest[]; problem: string | null } | null>(null);
  const [following, setFollowing] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = useRef(false);
  // Built once (refs and setters only), so the ref callback below is stable and React calls it only on mount and unmount.
  const reader = useRef<{ load: () => void; watch: (node: HTMLElement | null) => void } | null>(null);
  if (!reader.current) {
    const load = () => {
      if (timer.current) clearTimeout(timer.current);
      void getBotRequests().then(found => {
        setData(found);
        if (shown.current && found.requests.some(r => r.state === 'waiting')) timer.current = setTimeout(load, POLL_MS);
      }).catch(() => undefined);
    };
    // On screen: the first reading; off screen: no more readings (a ref callback, not an effect).
    const watch = (node: HTMLElement | null) => {
      if (node && !shown.current) { shown.current = true; load(); }
      if (!node) { shown.current = false; if (timer.current) clearTimeout(timer.current); }
    };
    reader.current = { load, watch };
  }
  const { load, watch } = reader.current;
  const pass = (request: BotRequest) => {
    askWatson(`Esto ha respondido el bot «${request.bot.name}» a «${request.subject}». Resúmemelo.`, { botReply: request.messageId });
    onOpen('assistant');
  };
  return <div ref={watch} className="orca-bot-requests">
    <h3>Encargos enviados</h3>
    {data?.problem && <p className="notice">{data.problem}</p>}
    {data && data.requests.length === 0 && <p className="muted">Aún no has enviado nada a un bot: hazlo desde «Llevar a Orca» en un correo, una nota o un proyecto.</p>}
    {data && data.requests.length > 0 && <ul className="orca-bot-request-list">{data.requests.map(request => <li key={request.messageId} className="card">
      <div className="orca-bot-request-head">
        <span className={`chip orca-bot-request-state ${request.state}`}>{states[request.state]}</span>
        <span className="coding-name"><strong>{discreet ? 'Encargo oculto' : request.subject}</strong>
          <small>{request.bot.name} · {request.kind === 'handoff' ? 'encargo' : 'pregunta'} · {discreet ? 'proyecto oculto' : `${request.project} (${request.client})`}</small></span>
      </div>
      {request.answer && !discreet && <pre className="orca-bot-answer">{request.answer}</pre>}
      {request.state === 'silent' && <small className="muted">Míralo en Orca, en los chats de {request.bot.name}.</small>}
      <div className="orca-actions">
        {request.answer && <ActionButton icon="send" label="Pasar a Watson" onClick={() => pass(request)}/>}
        {request.canFollow && <button type="button" className="button" aria-pressed={following === request.messageId}
          onClick={() => setFollowing(following === request.messageId ? null : request.messageId)}>Seguir el hilo</button>}
      </div>
      {following === request.messageId && <FollowUp request={request} onDone={() => { setFollowing(null); load(); }}/>}
    </li>)}</ul>}
  </div>;
}
