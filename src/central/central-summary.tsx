import { getCentralView, type CentralViewName } from '../api/central';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { CentralProblem } from './central-connect';
import { useCentralRead, viewKey } from './use-central-view';

/** Resumen: open alerts by level, projects with missing information, clients and active projects; each figure opens its tab. */
export function CentralSummary({ onTab, onOpen }: { onTab: (tab: CentralViewName) => void; onOpen: (section: Section) => void }) {
  const read = useCentralRead(viewKey('resumen'), () => getCentralView('resumen'));
  if (read.failure) return <CentralProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/>;
  if (!read.data) return <Loading label="Leyendo el resumen de Central" lines={3}/>;
  const s = read.data;
  const figures: { tab: CentralViewName; label: string; value: string; detail: string; tone: string }[] = [
    { tab: 'alertas', label: 'Alertas', value: String(s.alerts.critical + s.alerts.warning),
      detail: `${s.alerts.critical} ${s.alerts.critical === 1 ? 'crítica' : 'críticas'} · ${s.alerts.warning} ${s.alerts.warning === 1 ? 'aviso' : 'avisos'}`,
      tone: s.alerts.critical ? 'bad' : s.alerts.warning ? 'warn' : 'good' },
    { tab: 'pendientes', label: 'Pendientes', value: String(s.pending), detail: s.pending === 1 ? 'proyecto con información por completar' : 'proyectos con información por completar', tone: s.pending ? 'warn' : 'good' },
    { tab: 'clientes', label: 'Clientes', value: String(s.clients), detail: 'en Central', tone: 'neutral' },
    { tab: 'proyectos', label: 'Proyectos activos', value: `${s.activeProjects}${s.activeProjectsMore ? '+' : ''}`, detail: 'en estado Activo', tone: 'neutral' },
  ];
  return <div className="central-figures" aria-label="Resumen de Central">
    {figures.map(f => <button key={f.tab} type="button" className={`central-figure ${f.tone}`} onClick={() => onTab(f.tab)}>
      <span className="central-figure-label">{f.label}</span>
      <strong className="central-figure-value">{f.value}</strong>
      <small>{f.detail}</small>
    </button>)}
  </div>;
}
