import { useState } from 'react';
import { dismissProposal, openChatReplyProposal, type ProposedChatReply } from '../api/core';
import { ChatReply } from '../inbox/chat-reply';
import { windowText } from '../inbox/chat-reply-text';

type State = 'open' | 'busy' | 'reviewing' | 'done' | 'dismissed';
type ChatReplyProposal = { id: string; reply: ProposedChatReply; state: State; text?: string; result?: string };

/** WhatsApp replies Watson proposed. A proposal only opens the reply composer with its text: from there it is the same
 * path as from the card (exact preview, the window checked again in the core, and «Enviar»). Watson cannot send, and
 * a «sí» in the chat sends nothing. */
export function useChatReplyProposals() {
  const [list, setList] = useState<ChatReplyProposal[]>([]);
  const settle = (id: string, change: Partial<ChatReplyProposal>) => setList(all => all.map(p => p.id === id ? { ...p, ...change } : p));
  const review = async (proposal: ChatReplyProposal) => {
    settle(proposal.id, { state: 'busy', result: undefined });
    try {
      const opened = await openChatReplyProposal(proposal.id);
      settle(proposal.id, { state: 'reviewing', text: opened.text });
    } catch (failure) { settle(proposal.id, { state: 'dismissed', result: failure instanceof Error ? failure.message : 'No se pudo abrir la respuesta.' }); }
  };
  const dismiss = (proposal: ChatReplyProposal) => {
    settle(proposal.id, { state: 'dismissed', result: 'Respuesta descartada: no se ha enviado nada.' });
    void dismissProposal(proposal.id).catch(() => undefined);
  };
  const finish = (proposal: ChatReplyProposal, result: string | null) =>
    settle(proposal.id, result ? { state: 'done', result } : { state: 'dismissed', result: 'Respuesta cancelada: no se ha enviado nada.' });
  return {
    list, review, dismiss, finish,
    add: (id: string, reply: ProposedChatReply) => setList(all => all.some(p => p.id === id) ? all : [...all, { id, reply, state: 'open' }]),
    clear: () => setList([]),
  };
}

export function ChatReplyProposals({ state, discreet = false }: { state: ReturnType<typeof useChatReplyProposals>; discreet?: boolean }) {
  if (!state.list.length) return null;
  return <>{state.list.map(proposal => {
    const { reply } = proposal;
    const waiting = proposal.state === 'open' || proposal.state === 'busy';
    return <article key={proposal.id} className="card note-proposal" aria-label="Respuesta de WhatsApp propuesta">
      <strong>{discreet ? 'Respuesta de WhatsApp propuesta' : `Respuesta de WhatsApp propuesta para ${reply.contact}`}</strong>
      {discreet ? <small className="muted">Detalles ocultos en modo discreto.</small> : <>
        {reply.summary && <small className="muted">Conversación: {reply.summary}</small>}
        <small className="muted">Ventana de 24 h: {windowText(reply.window)}. No se ha enviado nada.</small>
        {proposal.state !== 'reviewing' && <pre className="issue-body">{reply.text}</pre>}
      </>}
      {proposal.state === 'reviewing' && !discreet && <ChatReply item={{ id: reply.conversationId }} initialText={proposal.text ?? reply.text}
        onDone={note => state.finish(proposal, note)} onCancel={() => state.finish(proposal, null)}/>}
      {proposal.state === 'reviewing' && discreet && <small className="muted">Sal del modo discreto para seguir revisando la respuesta.</small>}
      {waiting && <div className="inbox-actions">
        <button type="button" className="button primary" disabled={proposal.state === 'busy' || discreet} title={discreet ? 'Sal del modo discreto para responder' : undefined}
          onClick={() => void state.review(proposal)}>{proposal.state === 'busy' ? 'Abriendo…' : 'Revisar y enviar…'}</button>
        <button type="button" className="button" disabled={proposal.state === 'busy'} onClick={() => state.dismiss(proposal)}>Descartar</button>
      </div>}
      {proposal.result && <small className={proposal.state === 'done' ? 'ok-note' : 'muted'} role="status">{proposal.result}</small>}
    </article>;
  })}</>;
}
