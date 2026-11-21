import { useRef, useState } from 'react';
import { useAssistantName } from '../assistant/assistant-name';
import { composeReply, getMailAccounts, getReplyDraft, previewMail, sendMail, type InboxItem, type MailAccount, type MailDraft, type MailPreview } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { ActionButton } from '../ui/action-button';
import { hereLabel } from '../ui/platform';

/** A reply to a received mail: written by hand or drafted by Watson (only for mail the model may read),
 * then the exact preview, and it leaves only with «Enviar» on that preview. Nothing is sent otherwise. */
export function ReplyComposer({ item, onDone, onCancel }: { item: InboxItem; onDone: (note: string) => void; onCancel: () => void }) {
  const assistant = useAssistantName();
  const [draft, setDraft] = useState<MailDraft | null>(null);
  const [instructions, setInstructions] = useState('');
  const [preview, setPreview] = useState<MailPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  // Watson's last text, so a second «Redactar» replaces it instead of piling both up.
  const [written, setWritten] = useState('');
  // The mailbox that received it, and any sending-only account (Resend…) ready to send.
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    getReplyDraft(item.id).then(setDraft).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo preparar la respuesta.'));
    getMailAccounts().then(found => setAccounts(found.accounts)).catch(() => setAccounts([]));
  }
  const [received, setReceived] = useState<number | null>(null);
  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label); setError('');
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo completar.'); } finally { setBusy(''); }
  };
  const set = (key: keyof MailDraft) => (event: { target: { value: string } }) => { if (draft) { setDraft({ ...draft, [key]: event.target.value }); setPreview(null); } };
  const modelMay = item.confidentiality === 'normal';
  if (!draft) return error ? <div className="reply-composer"><LoadError message={error}/>
    <div className="inbox-actions"><ActionButton icon="close" label="Cancelar" onClick={onCancel}/></div></div>
    : <Loading label="Preparando la respuesta" lines={2}/>;
  if (preview) return <div className="reply-composer" aria-label="Vista previa del correo">
    <p className="muted">Esto es exactamente lo que se enviará. Solo sale si pulsas «Enviar».</p>
    <dl className="reply-preview">
      <dt>De</dt><dd>{preview.from}</dd>
      <dt>Para</dt><dd>{preview.draft.to.join(', ')}</dd>
      {preview.draft.cc.length > 0 && <><dt>Cc</dt><dd>{preview.draft.cc.join(', ')}</dd></>}
      <dt>Asunto</dt><dd>{preview.draft.subject || '(sin asunto)'}</dd>
      <dt>Adjuntos</dt><dd>Ninguno</dd>
    </dl>
    <pre className="reply-body">{preview.draft.body}</pre>
    {error && <LoadError message={error}/>}
    <div className="inbox-actions">
      <button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => void run('send', async () => {
        const sent = await sendMail(draft, preview.digest);
        const missing = sent.refused?.length ? ` El servidor no lo entregó a: ${sent.refused.join(', ')}.` : '';
        onDone(`Correo enviado a ${preview.draft.to.join(', ')}${sent.savedToSent ? '' : ' (no se pudo guardar la copia en «Enviados»)'}.${missing} La tarjeta pasa a «Hechos».`);
      })}>{busy === 'send' ? 'Enviando…' : 'Enviar'}</button>
      <ActionButton icon="edit" label="Volver a editar" disabled={Boolean(busy)} onClick={() => setPreview(null)}/>
    </div>
  </div>;
  const own = received ?? draft.accountId;
  if (received === null) setReceived(draft.accountId);
  const senders = accounts.filter(a => a.id === own || (a.kind === 'send' && a.enabled && a.hasPassword));
  return <form className="reply-composer" aria-label="Responder al correo" onSubmit={event => { event.preventDefault(); void run('preview', async () => setPreview(await previewMail(draft))); }}>
    {senders.length > 1 && <label className="field">Enviar desde<ModernSelect value={String(draft.accountId)} onChange={value => { setDraft({ ...draft, accountId: Number(value) }); setPreview(null); }}
      options={senders.map(a => ({ value: String(a.id), label: `${a.label ? `${a.label} <${a.address}>` : a.address}${a.kind === 'send' ? ' · solo envío' : ''}` }))}/></label>}
    <div className="project-note-grid">
      <label className="field">Para<input value={draft.to} onChange={set('to')} required/></label>
      <label className="field">Cc<input value={draft.cc} onChange={set('cc')}/></label>
    </div>
    <label className="field">Asunto<input value={draft.subject} onChange={set('subject')} maxLength={300}/></label>
    {modelMay ? <div className="field-row">
      <label className="field reply-instructions">Indicaciones para {assistant}<input value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={2000}
        placeholder="Por ejemplo: dile que lo tendré el lunes"/></label>
      <button type="button" className="button" disabled={Boolean(busy)} onClick={() => void run('compose', async () => {
        const answer = (await composeReply(item.id, instructions)).body;
        // What the user typed meanwhile stays; only Watson's previous text is replaced.
        setDraft(current => {
          if (!current) return current;
          const rest = written && current.body.startsWith(written) ? current.body.slice(written.length) : current.body;
          return { ...current, body: `${answer}${rest.startsWith('\n') ? rest : `\n\n${rest}`}` };
        });
        setWritten(answer); setPreview(null);
      })}>{busy === 'compose' ? 'Redactando…' : `Redactar con ${assistant}`}</button>
    </div> : <p className="muted">Este correo es {item.confidentiality === 'private' ? 'privado' : `solo de ${hereLabel}`}: {assistant} no lo lee, escribe la respuesta tú.</p>}
    <label className="field">Mensaje<textarea value={draft.body} onChange={set('body')} rows={12} required/></label>
    {error && <LoadError message={error}/>}
    <div className="inbox-actions">
      <button type="submit" className="button primary" disabled={Boolean(busy) || !draft.to.trim() || !draft.body.trim()}>{busy === 'preview' ? 'Preparando…' : 'Vista previa'}</button>
      <button type="button" className="button" disabled={Boolean(busy)} onClick={onCancel}>Cancelar</button>
    </div>
  </form>;
}
