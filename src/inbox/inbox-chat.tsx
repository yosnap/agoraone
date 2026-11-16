import { useRef, useState } from 'react';
import { askAssistant, createAssistantConversation } from '../api/core';
import { useAssistantName } from '../assistant/assistant-name';
import { CleanupProposals, useCleanupProposals } from '../assistant/cleanup-proposals';
import '../assistant/assistant.css';

type Line = { role: 'user' | 'assistant'; text: string; steps: string[]; failed?: boolean };
const examples = ['Busca el correo de la factura de Hostinger', 'Mueve a la Papelera la publicidad de hace más de 7 días', '¿Qué me ha pedido Ana esta semana?'];

/** A small chat with Watson inside the Bandeja: it searches the mail and proposes what to tidy. Nothing moves
 * until the user ticks the list Watson shows and presses its button; the mail text is data, never instructions. */
export function InboxChat({ discreet, onChanged }: { discreet: boolean; onChanged: () => void }) {
  const assistant = useAssistantName();
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const conversation = useRef<number | null>(null);
  const cleanups = useCleanupProposals(onChanged);
  const last = (change: (line: Line) => Line) => setLines(all => all.map((line, index) => index === all.length - 1 ? change(line) : line));
  const send = async (question: string) => {
    const asked = question.trim();
    if (!asked || busy) return;
    setText(''); setBusy(true);
    setLines(all => [...all, { role: 'user', text: asked, steps: [] }, { role: 'assistant', text: '', steps: [] }]);
    try {
      conversation.current ??= (await createAssistantConversation()).id;
      await askAssistant(conversation.current, asked, event => {
        if (event.kind === 'delta') last(line => ({ ...line, text: line.text + event.text }));
        else if (event.kind === 'tool' && event.tool === 'cleanup_proposal') {
          cleanups.add(event.id, event.action, event.messages);
          last(line => ({ ...line, steps: [...line.steps, `Preparó ${event.messages.length} correos para ${event.action === 'trash' ? 'la Papelera' : 'archivar'}`] }));
        } else if (event.kind === 'tool' && event.tool === 'inbox') last(line => ({ ...line, steps: [...line.steps, `Buscó en la Bandeja · ${event.count} correos`] }));
      });
    } catch (failure) {
      last(line => ({ ...line, failed: true, text: failure instanceof Error ? failure.message : 'No se pudo preguntar.' }));
    } finally { setBusy(false); }
  };
  return <aside className="card inbox-chat" aria-label={`Chat con ${assistant}`}>
    <strong>Pregunta a {assistant}</strong>
    <small className="muted">Busca correos o pídele que limpie: te enseña la lista y solo se mueve lo que apruebes.</small>
    <div className="inbox-chat-lines" aria-live="polite">
      {lines.length === 0 && <div className="inbox-chat-examples">{examples.map(example =>
        <button type="button" key={example} className="button" onClick={() => void send(example)}>{example}</button>)}</div>}
      {lines.map((line, index) => <div key={index} className={`inbox-chat-line ${line.role}${line.failed ? ' failed' : ''}`}>
        {line.steps.map(step => <small key={step} className="muted">{step}</small>)}
        <p>{discreet && line.role === 'assistant' && line.text ? 'Respuesta oculta en modo discreto.' : line.text || (busy && index === lines.length - 1 ? 'Pensando…' : '')}</p>
      </div>)}
      <CleanupProposals state={cleanups} discreet={discreet}/>
    </div>
    <form className="inbox-chat-form" onSubmit={event => { event.preventDefault(); void send(text); }}>
      <input value={text} onChange={event => setText(event.target.value)} maxLength={2000} placeholder={`Escribe a ${assistant}…`} aria-label={`Mensaje para ${assistant}`}/>
      <button type="submit" className="button primary" disabled={busy || !text.trim()}>{busy ? 'Enviando…' : 'Enviar'}</button>
    </form>
  </aside>;
}
