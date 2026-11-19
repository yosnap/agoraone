import { useRef, useState } from 'react';
import { useAssistantName } from '../assistant/assistant-name';
import { ApiError } from '../api/client';
import { composeChat, getChatReply, previewChat, sendChat, type ChatPreview, type ChatReplyDraft, type ChatSummary } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { closedReason, counter, META_COST_NOTICE, READ_NOTICE, UNSURE_NOTICE, windowText } from './chat-reply-text';

const levelWords = { private: 'privada', local_only: 'solo de este Mac' } as const;

/** The reply form: the text, Watson's draft only for a normal conversation, a character counter and «Vista previa»,
 * disabled with its reason when Meta's 24 h window is closed. Pure, so it can be rendered on its own. */
export function ChatReplyForm({ reply, text, instructions, busy, error, assistant, unsure = false, onText, onInstructions, onCompose, onPreview, onCancel }: {
  reply: ChatReplyDraft; text: string; instructions: string; busy: string; error: string; assistant: string; unsure?: boolean;
  onText: (text: string) => void; onInstructions: (text: string) => void; onCompose: () => void; onPreview: () => void; onCancel: () => void;
}) {
  const closed = closedReason(reply.window);
  const count = counter(text, reply.maxLength);
  const level = reply.confidentiality === 'normal' ? null : levelWords[reply.confidentiality];
  return <form className="reply-composer" aria-label="Responder por WhatsApp" onSubmit={event => { event.preventDefault(); onPreview(); }}>
    <p className="muted">Ventana de 24 h: {windowText(reply.window)}.</p>
    {closed && <p className="chat-reply-closed" role="note">{closed}</p>}
    {unsure && <p className="chat-reply-closed" role="note">{UNSURE_NOTICE}</p>}
    {level ? <p className="muted">Esta conversación es {level}: {assistant} no la lee, escribe la respuesta tú.</p>
      : <div className="field-row">
        <label className="field reply-instructions">Indicaciones para {assistant}<input value={instructions} onChange={event => onInstructions(event.target.value)} maxLength={2000}
          placeholder="Por ejemplo: dile que el lunes a las 10 me va bien"/></label>
        <button type="button" className="button" disabled={Boolean(busy)} onClick={onCompose}>{busy === 'compose' ? 'Redactando…' : `Redactar con ${assistant}`}</button>
      </div>}
    <label className="field">Mensaje<textarea value={text} onChange={event => onText(event.target.value)} rows={6} required/></label>
    <small className={`chat-reply-count${count.over ? ' over' : ''}`} aria-live="polite">{count.label}{count.over ? ' · demasiado largo para WhatsApp' : ''}</small>
    <p className="muted">Sin adjuntos: desde AgoraOne solo se responde con texto.</p>
    {error && <LoadError message={error}/>}
    <div className="inbox-actions">
      <button type="submit" className="button primary" disabled={Boolean(busy) || Boolean(closed) || !text.trim() || count.over}
        title={closed ?? undefined}>{busy === 'preview' ? 'Preparando…' : 'Vista previa'}</button>
      <button type="button" className="button" disabled={Boolean(busy)} onClick={onCancel}>Cancelar</button>
    </div>
  </form>;
}

/** Exactly what «Enviar» sends: to whom (nobody named in a private conversation), from which number, the text, no
 * attachments, the window, and the read and cost notices. «Enviar» is disabled when the window is closed or after a
 * send that cannot be repeated. */
export function ChatReplyPreview({ preview, busy, error, locked, unsure = false, onSend, onBack }: {
  preview: ChatPreview; busy: string; error: string; locked: boolean; unsure?: boolean; onSend: () => void; onBack: () => void;
}) {
  const closed = closedReason(preview.window);
  const to = preview.to ? [preview.to.name, preview.to.phone].filter(Boolean).join(' · ') || 'Contacto sin nombre' : 'Conversación privada';
  const from = [preview.from.label, preview.from.phone].filter(Boolean).join(' · ') || 'Tu número de WhatsApp';
  return <div className="reply-composer" aria-label="Vista previa del WhatsApp">
    <p className="muted">Esto es exactamente lo que se enviará. Solo sale si pulsas «Enviar», una vez.</p>
    <dl className="reply-preview">
      <dt>Para</dt><dd>{to}</dd>
      <dt>Desde</dt><dd>{from}</dd>
      <dt>Adjuntos</dt><dd>Ninguno</dd>
      <dt>Ventana</dt><dd>{windowText(preview.window)}</dd>
    </dl>
    <pre className="reply-body">{preview.draft.text}</pre>
    {closed && <p className="chat-reply-closed" role="note">{closed}</p>}
    {unsure && <p className="chat-reply-closed" role="note">{UNSURE_NOTICE}</p>}
    <p className="muted">{READ_NOTICE}</p>
    <p className="muted">{META_COST_NOTICE}</p>
    {error && <LoadError message={error}/>}
    <div className="inbox-actions">
      <button type="button" className="button primary" disabled={Boolean(busy) || Boolean(closed) || locked} title={closed ?? undefined}
        onClick={onSend}>{busy === 'send' ? 'Enviando…' : 'Enviar'}</button>
      <button type="button" className="button" disabled={Boolean(busy)} onClick={onBack}>Volver a editar</button>
    </div>
  </div>;
}

/** Only a send the core says surely did not leave may be offered again with that seal; anything else (unknown outcome,
 * already sent, being sent, or no answer from the core) disables «Enviar» for it. */
const settled = (failure: unknown) => !(failure instanceof ApiError && failure.data?.notSent === true);
const unknownOutcome = (failure: unknown) => !(failure instanceof ApiError) || failure.data?.outcome === 'unknown' || failure.status >= 500 && failure.data?.notSent !== true;

/** A reply to a WhatsApp conversation: written by hand or drafted by Watson (only when the model may read it), then the
 * exact preview, and it leaves only with «Enviar» on that preview. Nothing is sent otherwise. `initialText`: a reply
 * Watson proposed in the chat, which starts the form (editable) instead of the saved draft. */
export function ChatReply({ item, initialText, onDone, onCancel }: {
  item: Pick<ChatSummary, 'id'>; initialText?: string; onDone: (note: string) => void; onCancel: () => void;
}) {
  const assistant = useAssistantName();
  const [reply, setReply] = useState<ChatReplyDraft | null>(null);
  const [text, setText] = useState('');
  const [instructions, setInstructions] = useState('');
  const [preview, setPreview] = useState<ChatPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [locked, setLocked] = useState(false);
  // A send whose outcome is unknown: another text may go at once (user's decision, 19/11/2026), after checking the phone.
  const [unsure, setUnsure] = useState(false);
  // Watson's last text, so a second «Redactar» replaces it instead of piling both up.
  const [written, setWritten] = useState('');
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    getChatReply(item.id).then(found => { setReply(found); setText(initialText ?? found.text); })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo preparar la respuesta.'));
  }
  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label); setError('');
    try { await work(); } catch (failure) {
      if (label === 'send' && failure instanceof ApiError && failure.data?.code === 'new_message') {
        // Something new arrived since the preview: back to the text, and a new preview is needed.
        setPreview(null); setError(failure.message);
        getChatReply(item.id).then(setReply).catch(() => undefined);  // its window, as it is now
        return;
      }
      if (label === 'send' && settled(failure)) setLocked(true);
      if (label === 'send' && unknownOutcome(failure)) setUnsure(true);
      setError(failure instanceof Error ? failure.message : 'No se pudo completar.');
    } finally { setBusy(''); }
  };
  if (!reply) return error ? <div className="reply-composer"><LoadError message={error}/>
    <div className="inbox-actions"><button type="button" className="button" onClick={onCancel}>Cancelar</button></div></div>
    : <Loading label="Preparando la respuesta" lines={2}/>;
  const draft = { conversationId: reply.conversationId, text };
  if (preview) return <ChatReplyPreview preview={preview} busy={busy} error={error} locked={locked} unsure={unsure} onBack={() => { setPreview(null); setError(''); }}
    onSend={() => void run('send', async () => {
      await sendChat(preview.draft, preview.digest);
      const who = preview.to?.name ?? (preview.to ? 'el contacto' : 'la conversación privada');
      onDone(`Mensaje enviado a ${who}. La tarjeta pasa a «Hechos».`);
    })}/>;
  return <ChatReplyForm reply={reply} text={text} instructions={instructions} busy={busy} error={error} assistant={assistant} unsure={unsure}
    onText={value => { setText(value); setLocked(false); }} onInstructions={setInstructions} onCancel={onCancel}
    onPreview={() => void run('preview', async () => { setPreview(await previewChat(draft)); setLocked(false); })}
    onCompose={() => void run('compose', async () => {
      const answer = (await composeChat(item.id, instructions)).text;
      // What the user typed meanwhile stays; only Watson's previous text is replaced.
      setText(current => {
        const rest = written && current.startsWith(written) ? current.slice(written.length) : current;
        return rest.trim() ? `${answer}${rest.startsWith('\n') ? rest : `\n\n${rest}`}` : answer;
      });
      setWritten(answer);
    })}/>;
}
