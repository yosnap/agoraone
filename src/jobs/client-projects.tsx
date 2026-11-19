import { Fragment, useRef, useState } from 'react';
import { getHermesSummary } from '../api/client';
import { getClientProjects, type ClientProjects } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { OrcaLaunch } from '../orca/orca-launch';
import { useOrcaState } from '../orca/orca-projects';
import { projectKey } from './project-key';
import { count } from './work-format';
import { ActionButton } from '../ui/action-button';

type Period = '24h' | '7d' | '30d';
const statuses: Record<string, string> = { ACTIVE: 'activo', MAINTENANCE: 'mantenimiento', DORMANT: 'parado', ARCHIVED: 'archivado' };
const status = (value: string | null) => value ? statuses[value] ?? value.toLowerCase() : 'sin estado';

/** Clients' projects from Central with what the agents spent on each: CostGuard's tokens in the period and
 * Hermes' in 30 days, matched only when the folder has the project's name. What does not match is listed
 * apart, never guessed. */
export function ClientProjectsSection({ period, discreet }: { period: Period; discreet: boolean }) {
  const [data, setData] = useState<ClientProjects | null>(null);
  const [hermes, setHermes] = useState<Map<string, number> | null>(null);
  const [hermesFailed, setHermesFailed] = useState(false);
  const [error, setError] = useState('');
  const [onlyActive, setOnlyActive] = useState(true);
  const [orca, setOrca] = useState<string | null>(null);
  const { projects: orcaProjects, problem: orcaProblem } = useOrcaState();
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    getClientProjects().then(setData).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer los proyectos.'));
    getHermesSummary().then(summary => {
      const byKey = new Map<string, number>();
      for (const p of summary.projects) if (projectKey(p.project)) byKey.set(projectKey(p.project), (byKey.get(projectKey(p.project)) ?? 0) + p.tokens);
      setHermes(byKey);
    }).catch(() => setHermesFailed(true));
  }
  const label = period === '24h' ? '24 h' : period === '7d' ? '7 días' : '30 días';
  if (error) return <LoadError message={error}/>;
  if (!data) return <Loading label="Leyendo los proyectos de Central" lines={3}/>;
  const open = (s: string | null) => !s || ['ACTIVE', 'MAINTENANCE'].includes(s);
  const clients = data.clients.map(c => ({ ...c, projects: c.projects.filter(p => !onlyActive || open(p.status)) })).filter(c => c.projects.length);
  const usable = data.costguard && !data.problem;
  if (!data.clients.length) return <p className="muted">No hay clientes de Central. Configura Central en Conectores y pulsa «Actualizar» en su tarjeta.</p>;
  return <div className="client-projects">
    <div className="fiscal-bar">
      <label className="check"><input type="checkbox" checked={onlyActive} onChange={event => setOnlyActive(event.target.checked)}/> Solo activos o en mantenimiento</label>
      {!data.costguard && <span className="muted">CostGuard sin configurar: no hay consumo de los agentes de código.</span>}
      {data.problem && <span className="fiscal-warning">{data.problem}</span>}
      {orcaProblem && <span className="muted">Sin botones de Orca: {orcaProblem}</span>}
    </div>
    {discreet ? <p className="muted">{clients.length === 1 ? '1 cliente' : `${clients.length} clientes`} con proyectos; nombres ocultos en modo discreto.</p>
      : <table className="work-table projects-table">
        <thead><tr><th>Cliente y proyecto</th><th>Estado</th><th title="CostGuard: tokens de entrada y salida, sin caché">Agentes de código ({label})</th><th title="Hermes: tokens de sus sesiones en esa carpeta, con caché">Hermes (30 días)</th>{orcaProjects.length > 0 && <th>Orca</th>}</tr></thead>
        <tbody>{clients.map(client => client.projects.map((project, index) => {
          const fromHermes = project.ambiguous || !projectKey(project.name) ? undefined : hermes?.get(projectKey(project.name));
          const key = JSON.stringify([client.name, project.name, index]);
          const ready = orcaProjects.some(p => p.client === client.name && p.project === project.name);
          return <Fragment key={key}><tr>
            <td>{index === 0 && <strong>{client.name}</strong>}{index === 0 && <br/>}{project.name}</td>
            <td>{status(project.status)}{project.phase ? ` · ${project.phase}` : ''}</td>
            <td>{!usable ? <span className="muted">—</span> : project.ambiguous ? <span className="muted" title="Otro proyecto se llama igual: no se puede saber de cuál es la carpeta">nombre repetido</span> : project.usage ? (project.usage[period].tokens ? `${count(project.usage[period].tokens)} tokens · ${project.usage[period].turns === 1 ? '1 turno' : `${project.usage[period].turns} turnos`}` : '0')
              : <span className="muted">sin carpeta</span>}</td>
            <td>{fromHermes ? `${count(fromHermes)} tokens` : <span className="muted">{project.ambiguous ? 'nombre repetido' : '—'}</span>}</td>
            {orcaProjects.length > 0 && <td>{ready ? <ActionButton icon="external" label="Abrir en Orca…" disabled={orca === key} onClick={() => setOrca(key)}/>
              : <span className="muted" title="Sin repositorio de GitHub en Central, o ese repositorio no está en Orca">—</span>}</td>}
          </tr>
          {orca === key && orcaProjects.length > 0 && <tr><td colSpan={5}><OrcaLaunch choices={orcaProjects.filter(p => p.client === client.name && p.project === project.name)} client={client.name} project={project.name} source={{ kind: 'project' }}
            task="" onClose={() => setOrca(null)}/></td></tr>}</Fragment>;
        }))}</tbody>
      </table>}
    {!discreet && data.unmatched.some(u => u.usage[period].tokens) && <details className="projects-unmatched"><summary>Otras carpetas con consumo en {label} (no son proyectos de Central)</summary>
      <ul>{data.unmatched.filter(u => u.usage[period].tokens).map(u => <li key={u.name}>{u.name} · {count(u.usage[period].tokens)} tokens</li>)}</ul>
    </details>}
    <p className="muted">El consumo se asocia a un proyecto solo cuando la carpeta en la que trabajó el agente se llama igual (sin contar tildes, mayúsculas ni signos) y ningún otro proyecto se llama así. Las dos columnas no se suman: los agentes de código cuentan sin caché y Hermes con ella. Hermes da sus 20 repositorios con más consumo{hermesFailed ? '; ahora no se ha podido leer' : ''}.</p>
  </div>;
}
