import { useRef, useState } from 'react';
import { decideInbox, getAnnouncements, markAnnounced, type InboxItem } from '../api/core';
import { announcement, proposalLabels } from '../inbox/inbox-labels';

const YES = /^\s*(s[ií]|vale|ok|de acuerdo|hecho|hecha|hazlo|m[aá]rcala|m[aá]rcalo)[\s.!]*$/i;
const NO = /^\s*(no|desc[aá]rtala|desc[aá]rtalo|descartar|ignora(la|lo)?)[\s.!]*$/i;

/** A plain answer to an announcement: «sí» marks it done, «no» dismisses it, anything else is a question. */
export const replyState = (text: string) => (YES.test(text) ? 'done' : NO.test(text) ? 'dismissed' : null);

/** What the Bandeja has waiting, announced by the assistant when the chat opens. Each announcement is shown
 * once; the user answers with the buttons or with a plain «sí» / «no» when only one is open. The answer
 * is read here, never by a model, so no text in a message can answer for the user. */
export function useAnnouncements() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [note, setNote] = useState('');
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    getAnnouncements().then(data => {
      setItems(data.items.slice(0, 3));
      if (data.items.length) void markAnnounced(data.items.slice(0, 3).map(item => item.id)).catch(() => undefined);
    }).catch(() => undefined);
  }
  const decide = async (item: InboxItem, state: 'done' | 'dismissed' | null) => {
    try {
      if (state) await decideInbox(item.id, state);
      setItems(current => current.filter(other => other.id !== item.id));
      setNote(state === 'done' ? 'Marcado como hecho en la Bandeja.' : state === 'dismissed' ? 'Descartado en la Bandeja.' : 'Lo dejo en la Bandeja.');
    } catch { setNote('No se pudo guardar; inténtalo desde la Bandeja.'); }
  };
  /** A short «sí» or «no» answers the only open announcement; returns true when it did. */
  const answer = (text: string) => {
    if (items.length !== 1) return false;
    const state = replyState(text);
    if (!state) return false;
    void decide(items[0], state);
    return true;
  };
  return { items, note, decide, answer };
}

export function Announcements({ name, items, note, decide }: { name: string } & Pick<ReturnType<typeof useAnnouncements>, 'items' | 'note' | 'decide'>) {
  if (!items.length && !note) return null;
  return <>
    {items.map(item => <article key={item.id} className="assistant-message assistant announcement" aria-label="Aviso de la Bandeja">
      <strong>{name}</strong>
      <p>{announcement(item)}</p>
      {item.summary && <p className="muted">{item.summary}</p>}
      {item.proposal && <p className="muted">Eso aún no puedo hacerlo yo ({proposalLabels[item.proposal].arrives}). ¿Lo marco como hecho o lo descarto?</p>}
      <div className="actions">
        <button type="button" className="button primary" onClick={() => void decide(item, 'done')}>Marcar como hecho</button>
        <button type="button" className="button" onClick={() => void decide(item, 'dismissed')}>Descartar</button>
        <button type="button" className="button" onClick={() => void decide(item, null)}>Más tarde</button>
      </div>
    </article>)}
    {note && <p className="ok-note" role="status">{note}</p>}
  </>;
}
