import { quoteStatusLabels, quoteStatusTone, type QuoteStatus } from '../api/quotes';
import type { Section } from '../shell/shell-state';
import { LoadError } from '../ui/load-state';
import { openCentralSettings } from '../central/central-connect';
import type { CentralFailure } from '../central/use-central-view';

// Pieces shared by the list, the record and the draft form of «Presupuestos».

export const HIDDEN = '•••';

/** Why the quotes cannot be read: no connection or a key without the permission lead to Ajustes › Central. */
export function QuotesProblem({ failure, onRetry, onOpen }: { failure: CentralFailure; onRetry: () => void; onOpen: (section: Section) => void }) {
  if (failure.kind === 'off') return <p className="notice" role="status">El módulo Presupuestos está apagado en Ajustes › Instalación › Módulos.</p>;
  if (failure.kind === 'not_connected' || failure.kind === 'forbidden' || failure.kind === 'auth') {
    return <article className="card central-connect" aria-labelledby="quotes-connect-title">
      <h2 id="quotes-connect-title">{failure.kind === 'not_connected' ? 'Conecta Central' : failure.kind === 'auth' ? 'Central no acepta la clave' : 'Falta el permiso de presupuestos'}</h2>
      <p>{failure.message}</p>
      <p>Los presupuestos viven en Central (numeración, marca, PDF y Word). AgoraOne los lee con una clave que tenga el permiso «presupuestos», aunque el módulo Central esté apagado.</p>
      <div className="actions central-actions"><button type="button" className="button primary" onClick={() => openCentralSettings(onOpen)}>Ir a Ajustes › Central</button></div>
    </article>;
  }
  return <LoadError message={failure.message} onRetry={onRetry}/>;
}

/** The badge of a quote's state, with Central's own words. */
export const StatusBadge = ({ status }: { status: QuoteStatus | null }) =>
  <span className={`status-badge ${status ? quoteStatusTone[status] : 'neutral'}`}>{status ? quoteStatusLabels[status] : 'Sin estado'}</span>;
