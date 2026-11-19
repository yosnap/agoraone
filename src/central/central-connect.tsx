import { openConnector } from '../connectors/open-connector';
import { openJobsTab } from '../jobs/jobs-tab';
import type { Section } from '../shell/shell-state';
import { LoadError } from '../ui/load-state';
import { readAtLabel, type CentralFailure } from './use-central-view';

/** Without a connection by address and key: where to connect and where the user's own clients are meanwhile. */
export function CentralConnect({ onOpen }: { onOpen: (section: Section) => void }) {
  return <article className="card central-connect" aria-labelledby="central-connect-title">
    <h2 id="central-connect-title">Conecta Central</h2>
    <p>Escribe la dirección de tu Central y una clave creada en sus Ajustes › Apps conectadas. La clave se guarda solo en el almacén de secretos del sistema.</p>
    <p>Mientras tanto, tus clientes propios están en Trabajos › Clientes, y la Bandeja, WhatsApp, las reuniones, Fiscal y Watson los usan igual.</p>
    <div className="actions central-actions">
      <button type="button" className="button" onClick={() => { openJobsTab('clients'); onOpen('jobs'); }}>Ver mis clientes</button>
      <button type="button" className="button primary" onClick={() => openConnector('central', onOpen)}>Ir a Conectores › Central</button>
    </div>
  </article>;
}

/** A failed read: the connection card, the module turned off, or Central's own problem with «Reintentar». */
export function CentralProblem({ failure, onRetry, onOpen }: { failure: CentralFailure; onRetry: () => void; onOpen: (section: Section) => void }) {
  if (failure.kind === 'not_connected') return <CentralConnect onOpen={onOpen}/>;
  if (failure.kind === 'off') return <p className="notice" role="status">El módulo Central está apagado: enciéndelo en su tarjeta de Conectores.</p>;
  return <LoadError message={failure.message} onRetry={onRetry}/>;
}

/** Central did not answer and what is shown comes from the last snapshot. */
export function FallbackNote({ fallback }: { fallback?: { readAt: string | null; problem: string } }) {
  if (!fallback) return null;
  const when = readAtLabel(fallback.readAt);
  return <p className="notice" role="status">{fallback.problem} Se muestra la última copia{when ? `, ${when}` : ''}: sin notas ni datos al día.</p>;
}
