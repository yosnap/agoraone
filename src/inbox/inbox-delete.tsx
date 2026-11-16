import { useState } from 'react';
import { moveInboxMail } from '../api/core';
import { LoadError } from '../ui/load-state';

export type Doomed = { id: number; from: string; subject: string; date: string | null; hidden: boolean };
const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) : '';

/** The confirmation before deleting: the exact list, each with its box, and nothing moves until «Mover a la
 * Papelera». They go to the trash of their own account (recoverable from there), never deleted for good. */
export function InboxDelete({ title, messages, onDone, onCancel }: {
  title: string; messages: Doomed[]; onDone: (note: string) => void; onCancel: () => void;
}) {
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(messages.map(m => m.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toggle = (id: number) => setChosen(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const run = async () => {
    setBusy(true); setError('');
    try {
      const done = await moveInboxMail([...chosen], 'trash');
      onDone(`${done.moved} ${done.moved === 1 ? 'correo movido' : 'correos movidos'} a la Papelera de su cuenta.${done.problems.length ? ` ${done.problems.join('. ')}.` : ''}`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo mover.'); setBusy(false); }
  };
  return <div className="card inbox-delete" role="group" aria-label={title}>
    <strong>{title}</strong>
    <small className="muted">Van a la Papelera de su cuenta y se pueden recuperar desde allí; nunca se borran del todo. Desmarca los que quieras conservar.</small>
    {messages.length > 1 && <div className="inbox-actions">
      <button type="button" className="button" onClick={() => setChosen(new Set())}>Ninguno</button>
      <button type="button" className="button" onClick={() => setChosen(new Set(messages.map(m => m.id)))}>Todos</button></div>}
    <ul className="cleanup-list">{messages.map(message => <li key={message.id}><label className="check">
      <input type="checkbox" checked={chosen.has(message.id)} onChange={() => toggle(message.id)}/>
      <span className="cleanup-text"><strong>{message.hidden ? 'Correo reservado' : message.subject || '(sin asunto)'}</strong>
        <small>{message.hidden ? '' : `${message.from} · `}{day(message.date)}</small></span>
    </label></li>)}</ul>
    {error && <LoadError message={error}/>}
    <div className="inbox-actions">
      <button type="button" className="button act-delete" disabled={busy || chosen.size === 0} onClick={() => void run()}>
        {busy ? 'Moviendo…' : `Mover ${chosen.size} a la Papelera`}</button>
      <button type="button" className="button" disabled={busy} onClick={onCancel}>Cancelar</button>
    </div>
  </div>;
}
