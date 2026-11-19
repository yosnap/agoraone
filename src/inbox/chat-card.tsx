import { useState } from 'react';
import { getChatMessages, type ChatMessage, type ChatSummary, type InboxState, type OrcaProject } from '../api/core';
import { EventForm } from '../calendar/event-form';
import { OrcaLaunch } from '../orca/orca-launch';
import { clientProjects } from '../orca/orca-projects';
import { attachmentName, attachmentsText, chatName, chatOrigin, firstDate } from './inbox-cards';
import { kindLabels, levelNotes, orcaChatTask, proposalLabels, when, type CardAction } from './inbox-labels';
import { IssueFromSource } from './issue-from-source';
import { ProjectNote } from './project-note';

const hidden = { content: 'Sal del modo discreto para ver y escribir la nota', event: 'Sal del modo discreto para crear el evento',
  orca: 'Sal del modo discreto para ver qué se enviará', issue: 'Sal del modo discreto para escribir la issue', messages: 'Sal del modo discreto para ver los mensajes' };

/** One WhatsApp conversation's card in the Bandeja. Its latest messages come from AgoraOne's database, never from
 * Zernio, so opening them cannot mark anything as read; their text is shown as plain text. The actions are the
 * mail's (note, event, issue, Orca), each with its form; issue, Orca and a note in the repository only for what is
 * normal (the core checks it again). Nothing is deleted, archived or changed in WhatsApp; there is no reply yet. */
export function ChatCard({ item, discreet, isOpen, show, orcaProjects, onDecide, onNote }: {
  item: ChatSummary; discreet: boolean; isOpen: (action: CardAction) => boolean; show: (action: CardAction, on: boolean) => void;
  orcaProjects: OrcaProject[]; onDecide: (state: InboxState) => void; onNote: (note: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [problem, setProblem] = useState('');
  const close = (action: CardAction) => show(action, false);
  const name = chatName(item);
  const normal = item.confidentiality === 'normal';
  const pending = item.state === 'pending';
  const projects = clientProjects(orcaProjects, item.client?.name);
  const start = firstDate(item.details);
  const attachments = attachmentsText(item.attachments);
  const phone = discreet || item.confidentiality === 'private' ? null : item.participant?.phone;  // never in discreet mode
  const openMessages = async () => {
    if (isOpen('messages')) { close('messages'); return; }
    show('messages', true); setProblem('');
    try { setMessages((await getChatMessages(item.id)).messages); }
    catch (failure) { setProblem(failure instanceof Error ? failure.message : 'No se pudieron leer los mensajes.'); }
  };
  const issueBody = [item.summary ?? '', ...(item.details.asks?.length ? ['', 'Lo que pide:', ...item.details.asks.map(ask => `- ${ask}`)] : []),
    '', `(Conversación de WhatsApp con ${name}${item.lastIncomingAt ? ` del ${new Date(item.lastIncomingAt).toLocaleDateString('es-ES')}` : ''}.)`].join('\n').trim();
  return <li className={`card inbox-card chat-card${(isOpen('noting') || isOpen('issue')) && !discreet ? ' wide' : ''}`}>
    <div className="card-head">
      <div className="inbox-chips"><span className="chip source-whatsapp">WhatsApp</span>
        {item.label && <span className="chip">{item.label}</span>}
        <span className={`chip kind-${item.kind}`}>{kindLabels[item.kind]}</span>
        {item.source === 'rule' && item.ruleName && <span className="chip">Regla: {item.ruleName}</span>}
        {item.client && <span className="chip good" title={!discreet && item.client.projects.length ? `Proyectos activos: ${item.client.projects.join(', ')}` : undefined}>
          {discreet ? 'Cliente de Central' : `Cliente: ${item.client.name}`}{!discreet && item.client.projects.length ? ` · ${item.client.projects.length} proyecto${item.client.projects.length > 1 ? 's' : ''}` : ''}</span>}
        {levelNotes[item.confidentiality] && <span className="chip warn">{levelNotes[item.confidentiality]}</span>}</div>
      <span className="muted">{when(item.lastIncomingAt ?? item.updatedAt)}</span>
    </div>
    <p className="inbox-from"><strong>{name}</strong>{phone ? ` · ${phone}` : ''}
      {item.account.label && <span className="muted"> → {item.account.label}</span>}</p>
    {discreet ? <p className="muted">Resumen y mensajes ocultos en modo discreto.</p> : <>
      {item.summary && <p className="inbox-summary">{item.summary}</p>}
      {(item.details.asks?.length || item.details.amounts?.length || item.details.dates?.length || attachments) ? <ul className="inbox-details">
        {item.details.asks?.map((ask, index) => <li key={index}>Piden: {ask}</li>)}
        {item.details.amounts?.length ? <li>Importes: {item.details.amounts.join(', ')}</li> : null}
        {item.details.dates?.length ? <li>Fechas: {item.details.dates.join(', ')}</li> : null}
        {attachments ? <li>Adjuntos: {attachments}</li> : null}
      </ul> : null}
    </>}
    {isOpen('messages') && !discreet && <div className="chat-messages" aria-label="Últimos mensajes">
      {problem ? <p className="dictation-error" role="alert">{problem}</p>
        : messages === null ? <p className="muted">Leyendo los mensajes…</p>
        : messages.length === 0 ? <p className="muted">No hay mensajes guardados.</p>
        : <ol>{messages.map(message => <li key={message.id} className={`chat-message ${message.direction}`}>
          <span className="muted">{message.direction === 'outgoing' ? 'Tú' : name} · {message.at ? when(message.at) : ''}</span>
          {message.unsupported ? <p className="muted">Mensaje no disponible</p> : <>
            {message.text && <p>{message.text}</p>}
            {message.attachments.length > 0 && <p className="muted">{message.attachments.map(kind => attachmentName(kind)).join(', ')}</p>}
            {!message.text && message.attachments.length === 0 && <p className="muted">Sin texto</p>}</>}
        </li>)}</ol>}
    </div>}
    {isOpen('noting') && !discreet && <ProjectNote origin={chatOrigin(item)} onCancel={() => close('noting')} onDone={done => { close('noting'); onNote(done); }}/>}
    {isOpen('scheduling') && !discreet && <EventForm chatId={item.id} initial={{ title: (item.kind === 'appointment' ? `Cita con ${name}` : `WhatsApp de ${name}`).slice(0, 200),
      start, notes: (item.summary ?? '').slice(0, 4000) }} onCancel={() => close('scheduling')}
      onDone={done => { close('scheduling'); onNote(`${done} La conversación pasa a «Hechos».`); }}/>}
    {isOpen('orca') && !discreet && <OrcaLaunch choices={projects} client={item.client?.name} project={item.client?.projects[0]}
      source={{ kind: 'chat', id: item.id }} task={orcaChatTask} onClose={() => close('orca')}/>}
    {isOpen('issue') && !discreet && <IssueFromSource source={{ kind: 'chat', id: item.id }} client={item.client?.name} project={item.client?.projects[0]}
      title={(item.details.asks?.[0] ?? 'Petición del cliente por WhatsApp').slice(0, 200)} body={issueBody}
      onClose={done => { close('issue'); if (done) onNote(done); }}/>}
    <div className="inbox-actions">
      {pending ? <>
        <button type="button" className="button primary" onClick={() => onDecide('done')}>Hecho</button>
        <button type="button" className="button" onClick={() => onDecide('dismissed')}>Descartar</button>
      </> : <button type="button" className="button" onClick={() => onDecide('pending')}>Volver a Pendientes</button>}
      <button type="button" className="button" aria-pressed={isOpen('messages')} disabled={discreet} title={discreet ? hidden.messages : 'Los últimos 10 mensajes, como los guarda AgoraOne'}
        onClick={() => void openMessages()}>{isOpen('messages') ? 'Ocultar mensajes' : 'Ver mensajes'}</button>
      {pending && item.client && !isOpen('noting') && <button type="button" className="button" disabled={discreet} title={discreet ? hidden.content : undefined}
        onClick={() => show('noting', true)}>{proposalLabels.add_to_project.label}…</button>}
      {pending && (start || item.kind === 'appointment') && !isOpen('scheduling') && <button type="button" className="button" disabled={discreet}
        title={discreet ? hidden.event : undefined} onClick={() => show('scheduling', true)}>Crear evento…</button>}
      {pending && normal && item.client && item.client.projects.length > 0 && !isOpen('issue') && <button type="button" className="button" disabled={discreet}
        title={discreet ? hidden.issue : 'Crear una issue en el repositorio del proyecto'} onClick={() => show('issue', true)}>Crear issue…</button>}
      {pending && normal && projects.length > 0 && !isOpen('orca') && <button type="button" className="button" disabled={discreet}
        title={discreet ? hidden.orca : 'Crear un espacio de trabajo en Orca con un agente para esta conversación'} onClick={() => show('orca', true)}>Llevar a Orca…</button>}
    </div>
  </li>;
}
