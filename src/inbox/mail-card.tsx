import type { MouseEvent } from 'react';
import type { InboxItem, InboxState, OrcaProject } from '../api/core';
import { EventForm } from '../calendar/event-form';
import { OrcaLaunch } from '../orca/orca-launch';
import { clientProjects } from '../orca/orca-projects';
import { firstDate, mailOrigin } from './inbox-cards';
import { actionLabels, kindLabels, levelNotes, orcaTask, proposalLabels, sender, when, type CardAction } from './inbox-labels';
import { InvoiceFiling } from './invoice-filing';
import { IssueFromSource } from './issue-from-source';
import { ProjectNote } from './project-note';
import { ReplyComposer } from './reply-composer';

/** One mail's card in the Bandeja: its summary, what it asks and its actions. Only proposes: every action opens a
 * form the user checks, and nothing is moved, sent or written without the button. */
export function MailCard({ item, discreet, selected, editing, isOpen, show, orcaProjects, onPick, onPickWord, onToggle, onDecide, onRule, onDelete, onNote }: {
  item: InboxItem; discreet: boolean; selected: boolean; editing: boolean; isOpen: (action: CardAction) => boolean; show: (action: CardAction, on: boolean) => void;
  orcaProjects: OrcaProject[]; onPick: (event: MouseEvent) => void; onPickWord: (event: MouseEvent) => void; onToggle: () => void;
  onDecide: (state: InboxState) => void; onRule: () => void; onDelete: () => void; onNote: (note: string) => void;
}) {
  const close = (action: CardAction) => show(action, false);
  return <li className={`card inbox-card${selected ? ' chosen' : ''}${!item.moved && !editing ? ' pickable' : ''}${(isOpen('noting') || isOpen('issue')) && !discreet ? ' wide' : ''}`}
    onClick={item.moved ? undefined : onPick} onDoubleClick={item.moved ? undefined : onPickWord}>
    <div className="card-head">
      <div className="inbox-chips">{item.moved ? <span className="chip">{item.moved === 'trash' ? 'En la Papelera' : 'Archivado'}</span> : <label className="check inbox-pick" title="Seleccionar"><input type="checkbox" checked={selected} onChange={onToggle}
        aria-label={`Seleccionar ${discreet ? 'este correo' : item.subject || 'correo sin asunto'}`}/></label>}<span className={`chip kind-${item.kind}`}>{kindLabels[item.kind]}</span>
        {item.source === 'rule' && item.ruleName && <span className="chip">Regla: {item.ruleName}</span>}
        {item.client && <span className="chip good" title={!discreet && item.client.projects.length ? `Proyectos activos: ${item.client.projects.join(', ')}` : undefined}>
          {discreet ? 'Cliente de Central' : `Cliente: ${item.client.name}`}{!discreet && item.client.projects.length ? ` · ${item.client.projects.length} proyecto${item.client.projects.length > 1 ? 's' : ''}` : ''}</span>}
        {levelNotes[item.confidentiality] && <span className="chip warn">{levelNotes[item.confidentiality]}</span>}</div>
      <span className="muted">{when(item.sentAt)}</span>
    </div>
    <p className="inbox-from"><strong>{sender(item)}</strong>{item.from.address && item.from.name ? ` · ${item.from.address}` : ''} <span className="muted">→ {item.account.address}</span></p>
    {discreet ? <p className="muted">Asunto y resumen ocultos en modo discreto.</p> : <>
      <p className="inbox-subject">{item.subject || '(sin asunto)'}{item.attachments > 0 ? ` · ${item.attachments} adjunto${item.attachments > 1 ? 's' : ''}` : ''}</p>
      {item.summary && <p className="inbox-summary">{item.summary}</p>}
      {(item.details.asks?.length || item.details.amounts?.length || item.details.dates?.length) ? <ul className="inbox-details">
        {item.details.asks?.map((ask, index) => <li key={index}>Piden: {ask}</li>)}
        {item.details.amounts?.length ? <li>Importes: {item.details.amounts.join(', ')}</li> : null}
        {item.details.dates?.length ? <li>Fechas: {item.details.dates.join(', ')}</li> : null}
      </ul> : null}
    </>}
    {item.proposal === 'archive_invoice' && item.state === 'pending' ? (isOpen('filing')
      ? <InvoiceFiling messageId={item.id} onFiled={path => { close('filing'); onNote(`Factura archivada en ${path}.`); }}/>
      : <p className="inbox-proposal"><button type="button" className="button" onClick={() => show('filing', true)}>{proposalLabels.archive_invoice.label}…</button></p>)
      : (item.proposal === 'add_to_project' || item.client) && item.state === 'pending' ? (isOpen('noting') && !discreet
        ? <ProjectNote origin={mailOrigin(item)} onCancel={() => close('noting')} onDone={done => { close('noting'); onNote(done); }}/>
        : <p className="inbox-proposal"><button type="button" className="button" disabled={discreet} title={discreet ? 'Sal del modo discreto para ver y escribir la nota' : undefined}
          onClick={() => show('noting', true)}>{proposalLabels.add_to_project.label}…</button></p>)
      : item.proposal === 'create_event' && item.state === 'pending' && (isOpen('scheduling') && !discreet
        ? <EventForm inboxId={item.id} initial={{ title: (item.subject ?? '').slice(0, 200), start: firstDate(item.details), notes: (item.summary ?? '').slice(0, 4000) }}
          onCancel={() => close('scheduling')} onDone={done => { close('scheduling'); onNote(`${done} La tarjeta pasa a «Hechos».`); }}/>
        : <p className="inbox-proposal"><button type="button" className="button" disabled={discreet} title={discreet ? 'Sal del modo discreto para crear el evento' : undefined}
          onClick={() => show('scheduling', true)}>{proposalLabels.create_event.label}…</button></p>)}
    {isOpen('replying') && !discreet && <ReplyComposer item={item} onCancel={() => close('replying')}
      onDone={done => { close('replying'); onNote(done); }}/>}
    {isOpen('orca') && !discreet && <OrcaLaunch choices={clientProjects(orcaProjects, item.client?.name)} client={item.client?.name} project={item.client?.projects[0]}
      source={{ kind: 'mail', id: item.id }} task={orcaTask} onClose={() => close('orca')}/>}
    {isOpen('issue') && !discreet && <IssueFromSource source={{ kind: 'mail', id: item.id }} client={item.client?.name} project={item.client?.projects[0]}
      title={item.subject?.replace(/^\s*((re|rv|fw|fwd)\s*:\s*)+/i, '').trim() || 'Petición del cliente'}
      body={[item.summary ?? '', ...(item.details.asks?.length ? ['', 'Lo que pide:', ...item.details.asks.map(ask => `- ${ask}`)] : []),
        '', `(Correo de ${item.from.name || 'el cliente'} del ${new Date(item.sentAt).toLocaleDateString('es-ES')}.)`].join('\n').trim()}
      onClose={done => { close('issue'); if (done) onNote(done); }}/>}
    <div className="inbox-actions">
      {item.state === 'pending' ? <>
        <button type="button" className="button primary" onClick={() => onDecide('done')}>Hecho</button>
        <button type="button" className="button" onClick={() => onDecide('dismissed')}>Descartar</button>
        {!isOpen('replying') && <button type="button" className="button" disabled={discreet} title={discreet ? 'Sal del modo discreto para responder' : undefined}
          onClick={() => show('replying', true)}>Responder…</button>}
        {!isOpen('orca') && item.confidentiality === 'normal' && !item.moved && clientProjects(orcaProjects, item.client?.name).length > 0
          && <button type="button" className="button" disabled={discreet} title={discreet ? 'Sal del modo discreto para ver qué se enviará' : 'Crear un espacio de trabajo en Orca con un agente para este correo'}
            onClick={() => show('orca', true)}>Llevar a Orca…</button>}
        {!isOpen('issue') && item.confidentiality === 'normal' && !item.moved && item.client
          && <button type="button" className="button" disabled={discreet} title={discreet ? 'Sal del modo discreto para escribir la issue' : 'Crear una issue en el repositorio del proyecto'}
            onClick={() => show('issue', true)}>Crear issue…</button>}
      </> : <button type="button" className="button" onClick={() => onDecide('pending')}>Volver a Pendientes</button>}
      {!item.moved && <button type="button" className="button act-delete" onClick={onDelete}>Eliminar…</button>}
      {item.suggestion && <button type="button" className="button" onClick={onRule}
        title={`${actionLabels[item.suggestion.action]} para todo lo que venga de ${item.suggestion.sender}`}>Crear regla «{item.suggestion.name}»</button>}
    </div>
  </li>;
}
