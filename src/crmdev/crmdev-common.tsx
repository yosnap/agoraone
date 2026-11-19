import type { ReactNode } from 'react';
import type { CrmdevWindowPage } from '../api/crmdev';
import { openConnector } from '../connectors/open-connector';
import { OpenInConnector } from '../connectors/open-in-connector';
import type { Section } from '../shell/shell-state';
import { ChangeReview } from '../ui/change-review';
import { statusTone, labelOf } from './crmdev-labels';
import type { useCrmdevChange } from './use-crmdev-change';
import { orderNote, readAgain, readAtLabel, useRereading, type CrmdevFailure } from './use-crmdev-view';
import { ActionButton } from '../ui/action-button';

// Pieces shared by the tabs and records of the «CRMDev» section. Everything from CRMDev is React text: never HTML, never
// Markdown, never a link, even when it looks like an address.

export const HIDDEN = 'Oculto en modo discreto';

/** «Abrir en CRMDev»: the page in CRMDev's own window (or the browser without the desktop app); nothing in discreet mode. */
export function OpenInCrmdev({ page, label, discreet, content }: { page: CrmdevWindowPage; label?: string; discreet: boolean; content?: ReactNode }) {
  return <OpenInConnector connector="crmdev" page={page} label={label} discreet={discreet} content={content}/>;
}

/** Without a connection: where to connect, and that nothing is ever deleted. */
export function CrmdevConnect({ onOpen }: { onOpen: (section: Section) => void }) {
  return <article className="card central-connect" aria-labelledby="crmdev-connect-title">
    <h2 id="crmdev-connect-title">Conecta CRMDev</h2>
    <p>Escribe la dirección de tu CRMDev y una clave de organización (<code>crm_…</code>) creada en sus Ajustes › API Keys. La clave se guarda solo en el almacén de secretos del sistema.</p>
    <p>AgoraOne lee tus proyectos, tareas, tickets y clientes, y solo crea o cambia algo después de enseñarte el cambio exacto y de que lo confirmes; nunca borra nada en CRMDev.</p>
    <div className="actions central-actions">
      <ActionButton icon="link" label="Ir a Conectores › CRMDev" tone="primary" onClick={() => openConnector('crmdev', onOpen)}/>
    </div>
  </article>;
}

const LEADS: Record<string, string> = {
  busy: 'CRMDev está ocupado.', auth: 'CRMDev no acepta la clave.', unreachable: 'CRMDev no responde.', forbidden: 'CRMDev no lo permite.',
};

/** A failed read: the connection card, the module off, or CRMDev's own problem in plain words with «Reintentar» (and,
 * when the key is the problem, the way to its card). */
export function CrmdevProblem({ failure, onRetry, onOpen }: { failure: CrmdevFailure; onRetry: () => void; onOpen: (section: Section) => void }) {
  if (failure.kind === 'not_connected') return <CrmdevConnect onOpen={onOpen}/>;
  if (failure.kind === 'off') return <p className="notice" role="status">El módulo CRMDev está apagado: enciéndelo en su tarjeta de Conectores.</p>;
  const lead = failure.kind ? LEADS[failure.kind] : undefined;
  return <div className="error load-error crmdev-problem" role="alert" data-kind={failure.kind ?? 'error'}>
    <span>{lead && <strong>{lead} </strong>}{failure.message}</span>
    <span className="actions">
      {(failure.kind === 'auth' || failure.kind === 'forbidden') && <ActionButton icon="link" label="Ir a Conectores › CRMDev" onClick={() => openConnector('crmdev', onOpen)}/>}
      <ActionButton icon="refresh" label="Reintentar" onClick={onRetry}/>
    </span>
  </div>;
}

/** «Los 100 más recientes…» when a list is full; nothing otherwise. */
export function OrderNote({ page }: { page: Parameters<typeof orderNote>[0] }) {
  const text = orderNote(page);
  return text ? <p className="muted crmdev-order" role="note">{text}</p> : null;
}

/** A state or priority as a badge, in Spanish (or as CRMDev says it when unknown). */
export function Badge({ labels, value }: { labels: Record<string, string>; value: string | null }) {
  return value ? <span className={`status-badge ${statusTone(value)}`}>{labelOf(labels, value)}</span> : <span>—</span>;
}

/** A long text of CRMDev (a description), as plain text with its line breaks. In discreet mode nothing at all, so not
 * even which rows have one shows. */
export function LongText({ text, discreet }: { text: string | null; discreet: boolean }) {
  return !text || discreet ? null : <small className="crmdev-text">{text}</small>;
}

/** «Volver a leer» (asks CRMDev now for what is on screen) and when the oldest answer on screen was given; one per
 * screen, on the right of its filters or in the head of a record. */
export function ReadAgain({ times }: { times: (string | null | undefined)[] }) {
  const when = readAtLabel(times);
  const busy = useRereading();
  return <div className="actions central-actions crmdev-read">
    {when && <small className="muted">{when}</small>}
    <ActionButton icon="refresh" label="Volver a leer" busyLabel={busy && 'Leyendo…'} disabled={busy} onClick={readAgain}/>
  </div>;
}

/** The two buttons of a form that changes CRMDev, in a row of their own or on the right of its last field. */
export function EditActions({ busy, disabled, onCancel }: { busy: boolean; disabled: boolean; onCancel: () => void }) {
  return <div className="actions central-actions crmdev-edit-actions">
    <ActionButton icon="close" label="Cancelar" onClick={onCancel}/>
    <ActionButton icon="check" label="Revisar el cambio" tone="primary" busyLabel={busy && 'Preparando…'} type="submit" disabled={disabled || busy}/>
  </div>;
}

/** The exact change to CRMDev and «Guardar en CRMDev»; after a conflict, what CRMDev has now. `onReview` goes back to
 * the form (closing the review), `onLink` opens the existing record of a new client CRMDev already has. After a creation
 * whose answer never came, it asks to look in CRMDev (`page`) and offers «Crear de todos modos». */
export function CrmdevReview({ change, onCancel, onReview, onLink, linkLabel, page, discreet = false }: {
  change: ReturnType<typeof useCrmdevChange>; onCancel: () => void; onReview: () => void; onLink?: (id: string) => void; linkLabel?: string;
  page?: CrmdevWindowPage; discreet?: boolean;
}) {
  const cancel = () => { change.reset(); onCancel(); };
  if (change.doubtful) {
    return <div className="central-change" role="alert">
      <p className="notice">{change.doubtful.message}</p>
      {change.error && <p className="error" role="alert">{change.error}</p>}
      <div className="actions central-actions">
        <ActionButton icon="close" label="Cancelar" disabled={change.busy} onClick={cancel}/>
        {page && <OpenInCrmdev page={page} label="Revisar en CRMDev" discreet={discreet}/>}
        <ActionButton icon="plus" label="Crear de todos modos" tone="primary" disabled={change.busy} onClick={() => void change.anyway()}/>
      </div>
    </div>;
  }
  return <ChangeReview change={change} where="CRMDev" onCancel={cancel} onReview={() => { change.reset(); onReview(); }}
    onLink={onLink && (id => { change.reset(); onLink(id); })} linkLabel={linkLabel}/>;
}

/** The record being changed left the list it was shown in (another change in CRMDev, or this one): said, never closed silently. */
export function Gone() {
  return <p className="notice" role="status">Ya no está en esta lista de CRMDev (puede haber cambiado de estado). Sigue aquí con lo último que se leyó: vuelve a la lista o ábrelo en CRMDev.</p>;
}

/** Whether a form shows its review instead of its fields. */
export const reviewing = (change: ReturnType<typeof useCrmdevChange>) => Boolean(change.preview || change.conflict || change.exists || change.doubtful);

/** What was just done in CRMDev (or a warning about it). */
export function Said({ text }: { text: string }) {
  return text ? <p className="ok-note central-wide" role="status">{text}</p> : null;
}
