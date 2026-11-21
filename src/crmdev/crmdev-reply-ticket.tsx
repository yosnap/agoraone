import { useState } from 'react';
import type { CrmdevFilters, CrmdevTicket } from '../api/crmdev';
import { CrmdevReview, EditActions, reviewing } from './crmdev-common';
import { changeKey, useCrmdevChange } from './use-crmdev-change';

export const REPLY_CHARS = 2000;

/** «Responder» a ticket: the exact text and who reads it, a note only the team sees or an answer the client reads in
 * its portal. There is no default: the user picks one each time. Sent only with «Guardar en CRMDev». */
export function CrmdevReplyTicket({ ticket, list, onDone }: { ticket: CrmdevTicket & { id: string }; list: CrmdevFilters['tickets'];
  onDone: (said: string) => void }) {
  const [content, setContent] = useState('');
  const [internal, setInternal] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const change = useCrmdevChange(changeKey('respuesta-ticket', ticket.id), said => { setContent(''); setInternal(null); setOpen(false); onDone(said); });
  const close = () => { change.reset(); setOpen(false); };
  if (!open) return <div className="crmdev-new"><button type="button" className="button" onClick={() => setOpen(true)}>Responder</button></div>;
  if (reviewing(change)) return <CrmdevReview change={change} onCancel={close} onReview={() => undefined} page={`tickets/${ticket.id}`}/>;
  return <form className="central-edit crmdev-edit" aria-label={`Responder al ticket ${ticket.title ?? ''}`}
    onSubmit={event => { event.preventDefault(); if (internal !== null) void change.ask({ kind: 'respuesta-ticket', id: ticket.id, list, content: content.trim(), internal }); }}>
    <strong>Responder al ticket «{ticket.title ?? '—'}»</strong>
    <div className="field">Quién la ve<div className="segmented" role="group" aria-label="Quién la ve">
      <button type="button" aria-pressed={internal === true} onClick={() => setInternal(true)}>Solo el equipo (nota interna)</button>
      <button type="button" aria-pressed={internal === false} onClick={() => setInternal(false)}>El cliente</button></div></div>
    <label className="field">Respuesta<textarea value={content} rows={4} maxLength={REPLY_CHARS} required onChange={event => setContent(event.target.value)}/></label>
    <div className="crmdev-edit-row"><EditActions busy={change.busy} disabled={!content.trim() || internal === null} onCancel={close}/></div>
    {change.error && <p className="error" role="alert">{change.error}</p>}
  </form>;
}
