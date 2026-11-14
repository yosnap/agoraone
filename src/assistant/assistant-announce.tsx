import { useRef, useState } from 'react';
import { claimAnnouncements, decideInbox, type InboxItem } from '../api/core';
import { announcement, proposalLabels } from '../inbox/inbox-labels';
import { InvoiceFiling } from '../inbox/invoice-filing';
import { replyState } from './assistant-reply';

/** What the Bandeja has waiting, announced by the assistant when the chat opens. Each announcement is shown
 * once; the user answers with the buttons or with a plain «sí» / «no» when only one is open. The answer
 * is read here, never by a model, so no text in a message can answer for the user. */
export function useAnnouncements() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [note, setNote] = useState('');
  const asked = useRef(false);
  // Invoices ready to file with a plain «sí» (attached PDF, nothing that does not match).
  const filers = useRef(new Map<number, () => Promise<void>>());
  if (!asked.current) {
    asked.current = true;
    claimAnnouncements().then(data => setItems(data.items)).catch(() => undefined);
  }
  const decide = async (item: InboxItem, state: 'done' | 'dismissed' | null) => {
    try {
      if (state) await decideInbox(item.id, state);
      setItems(current => current.filter(other => other.id !== item.id));
      const what = `«${item.subject || 'sin asunto'}»`;
      setNote(state === 'done' ? `${what}: marcado como hecho en la Bandeja.` : state === 'dismissed' ? `${what}: descartado en la Bandeja.` : `${what}: lo dejo en la Bandeja.`);
    } catch { setNote('No se pudo guardar; inténtalo desde la Bandeja.'); }
  };
  /** A short «sí» or «no» answers the only open announcement, and only before anything else was said in the
   * chat (afterwards it may be the answer to Watson's own question); returns true when it did. */
  const answer = (text: string, chatStarted: boolean) => {
    if (items.length !== 1 || chatStarted) return false;
    const state = replyState(text);
    if (!state) return false;
    const item = items[0];
    if (state === 'done' && item.proposal === 'archive_invoice') {
      const file = filers.current.get(item.id);
      if (file) void file();
      else setNote('Antes de archivarla revisa los datos de la factura: hay dudas o hay que descargarla. Usa el botón «Archivar la factura».');
      return true;
    }
    void decide(item, state);
    return true;
  };
  const ready = (id: number, file: (() => Promise<void>) | null) => { if (file) filers.current.set(id, file); else filers.current.delete(id); };
  const filed = (item: InboxItem, path: string) => {
    filers.current.delete(item.id);
    setItems(current => current.filter(other => other.id !== item.id));
    setNote(`Factura archivada en ${path}.`);
  };
  return { items, note, decide, answer, ready, filed };
}

export function Announcements({ name, items, note, decide, ready, filed, discreet = false }: { name: string; discreet?: boolean }
  & Pick<ReturnType<typeof useAnnouncements>, 'items' | 'note' | 'decide' | 'ready' | 'filed'>) {
  if (!items.length && !note) return null;
  return <>
    {items.map(item => <article key={item.id} className="assistant-message assistant announcement" aria-label="Aviso de la Bandeja">
      <strong>{name}</strong>
      <p>{discreet ? 'Tienes un correo pendiente en la Bandeja (detalles ocultos en modo discreto).' : announcement(item)}</p>
      {item.summary && !discreet && <p className="muted">{item.summary}</p>}
      {item.proposal === 'archive_invoice' && !discreet
        ? <InvoiceFiling messageId={item.id} onReady={file => ready(item.id, file)} onFiled={path => filed(item, path)}/>
        : item.proposal && item.proposal !== 'archive_invoice' && <p className="muted">Eso aún no puedo hacerlo yo ({proposalLabels[item.proposal].arrives}). ¿Lo marco como hecho o lo descarto?</p>}
      <div className="actions">
        <button type="button" className="button primary" onClick={() => void decide(item, 'done')}>Marcar como hecho</button>
        <button type="button" className="button" onClick={() => void decide(item, 'dismissed')}>Descartar</button>
        <button type="button" className="button" onClick={() => void decide(item, null)}>Más tarde</button>
      </div>
    </article>)}
    {note && <p className="ok-note" role="status">{note}</p>}
  </>;
}
