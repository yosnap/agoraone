import { openConnector } from '../connectors/open-connector';
import type { Section } from '../shell/shell-state';
import { statusTone, labelOf } from './crmdev-labels';
import { orderNote, readAgain, readAtLabel, type CrmdevFailure } from './use-crmdev-view';

// Pieces shared by the tabs and records of the «CRMDev» section. Everything from CRMDev is React text: never HTML, never
// Markdown, never a link, even when it looks like an address.

export const HIDDEN = 'Oculto en modo discreto';

/** Without a connection: where to connect, and that nothing is ever deleted. */
export function CrmdevConnect({ onOpen }: { onOpen: (section: Section) => void }) {
  return <article className="card central-connect" aria-labelledby="crmdev-connect-title">
    <h2 id="crmdev-connect-title">Conecta CRMDev</h2>
    <p>Escribe la dirección de tu CRMDev y una clave de organización (<code>crm_…</code>) creada en sus Ajustes › API Keys. La clave se guarda solo en el almacén de secretos del sistema.</p>
    <p>AgoraOne solo lee tus proyectos, tareas, tickets y clientes; nunca borra nada en CRMDev.</p>
    <div className="actions central-actions">
      <button type="button" className="button primary" onClick={() => openConnector('crmdev', onOpen)}>Ir a Conectores › CRMDev</button>
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
      {(failure.kind === 'auth' || failure.kind === 'forbidden') && <button type="button" onClick={() => openConnector('crmdev', onOpen)}>Ir a Conectores › CRMDev</button>}
      <button type="button" onClick={onRetry}>Reintentar</button>
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
  return <div className="actions central-actions crmdev-read">
    {when && <small className="muted">{when}</small>}
    <button type="button" className="button" onClick={readAgain}>Volver a leer</button>
  </div>;
}
