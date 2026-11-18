import { getCentralView } from '../api/central';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { CentralProblem } from './central-connect';
import { dateLabel, useCentralRead, viewKey } from './use-central-view';

const kinds: Record<string, string> = { web: 'Webs', ssl: 'Certificados', server: 'Servidores', patches: 'Parches', deps: 'Dependencias' };

/** Alertas: what Central has open (webs down or slow, certificates, servers, patches, dependencies), critical first. */
export function CentralAlerts({ onOpen }: { onOpen: (section: Section) => void }) {
  const read = useCentralRead(viewKey('alertas'), () => getCentralView('alertas'));
  if (read.failure) return <CentralProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/>;
  if (!read.data) return <Loading label="Leyendo las alertas de Central" lines={4}/>;
  const alerts = read.data.alerts;
  if (!alerts.length) return <p className="ok-note" role="status">Central no tiene ninguna alerta abierta.</p>;
  return <table className="data-table central-table">
    <thead><tr><th>Nivel</th><th>Tipo</th><th>Qué</th><th>Detalle</th><th>Desde</th></tr></thead>
    <tbody>{alerts.map((alert, index) => <tr key={alert.key ?? index}>
      <td><span className={`status-badge ${alert.level === 'critical' ? 'bad' : 'waiting'}`}>{alert.level === 'critical' ? 'Crítica' : 'Aviso'}</span></td>
      <td>{kinds[alert.kind ?? ''] ?? alert.kind ?? '—'}</td>
      <td><strong>{alert.title ?? '—'}</strong></td>
      <td>{alert.detail ?? ''}</td>
      <td>{dateLabel(alert.at)}</td>
    </tr>)}</tbody>
  </table>;
}

/** Pendientes: active projects (or in maintenance) with information still missing, and what. */
export function CentralPending({ onOpen }: { onOpen: (section: Section) => void }) {
  const read = useCentralRead(viewKey('pendientes'), () => getCentralView('pendientes'));
  if (read.failure) return <CentralProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/>;
  if (!read.data) return <Loading label="Leyendo los pendientes de Central" lines={4}/>;
  const pending = read.data.pending;
  if (!pending.length) return <p className="ok-note" role="status">A ningún proyecto activo le falta información.</p>;
  return <table className="data-table central-table">
    <thead><tr><th>Proyecto</th><th>Cliente</th><th>Le falta</th></tr></thead>
    <tbody>{pending.map((p, index) => <tr key={p.id ?? index}>
      <td><strong>{p.name ?? '—'}</strong></td>
      <td>{p.client ?? '—'}</td>
      <td><span className="central-chips">{p.missing.map(m => <span key={m} className="chip warn">{m}</span>)}</span></td>
    </tr>)}</tbody>
  </table>;
}
