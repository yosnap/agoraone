import { useState } from 'react';
import { getCrmdevView, type CrmdevFilters, type CrmdevTask } from '../api/crmdev';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { Badge, CrmdevProblem, LongText, OrderNote, ReadAgain } from './crmdev-common';
import { dayLabel, filterOptions, priorityLabels, taskStatusLabels } from './crmdev-labels';
import { readKey, useCrmdevRead } from './use-crmdev-view';

/** Some tasks: title (and its description), state, priority, date, assignee's name only and, unless they all belong to
 * one project, the project. In discreet mode neither descriptions nor the assignee column are shown. */
export function TasksTable({ tasks, discreet, withProject = true }: { tasks: CrmdevTask[]; discreet: boolean; withProject?: boolean }) {
  if (!tasks.length) return <p className="muted">Ninguna tarea.</p>;
  return <table className="data-table central-table">
    <thead><tr><th>Tarea</th><th>Estado</th><th>Prioridad</th><th>Fecha</th>{!discreet && <th>Asignada a</th>}{withProject && <th>Proyecto</th>}</tr></thead>
    <tbody>{tasks.map((t, index) => <tr key={t.id ?? index}>
      <td className="crmdev-title"><strong>{t.title ?? '—'}</strong><LongText text={t.description} discreet={discreet}/></td>
      <td><Badge labels={taskStatusLabels} value={t.status}/></td>
      <td><Badge labels={priorityLabels} value={t.priority}/></td>
      <td className="central-date">{dayLabel(t.dueDate)}</td>
      {!discreet && <td>{t.assignee?.name ?? '—'}</td>}
      {withProject && <td>{t.project ?? '—'}</td>}
    </tr>)}</tbody>
  </table>;
}

/** Tareas: the 100 most recent, filtered by state and project in CRMDev itself. */
export function CrmdevTasks({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  const [filters, setFilters] = useState<CrmdevFilters['tareas']>({});
  const read = useCrmdevRead(readKey('tareas', filters), fresh => getCrmdevView('tareas', filters, fresh));
  const projects = useCrmdevRead(readKey('proyectos'), fresh => getCrmdevView('proyectos', {}, fresh));
  const projectOptions = [{ value: '', label: 'Todos' }, ...(projects.data?.items ?? [])
    .filter((p): p is typeof p & { id: string } => Boolean(p.id)).map(p => ({ value: p.id, label: p.name ?? p.id }))];
  return <>
    <div className="field-row central-filters">
      <label className="field">Estado<ModernSelect value={filters.estado ?? ''} onChange={value => setFilters({ ...filters, estado: value || undefined })}
        options={filterOptions(taskStatusLabels)}/></label>
      <label className="field">Proyecto<ModernSelect value={filters.proyecto ?? ''} onChange={value => setFilters({ ...filters, proyecto: value || undefined })}
        options={projectOptions}/></label>
      <ReadAgain times={[read.data?.readAt]}/>
    </div>
    {read.failure ? <CrmdevProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/>
      : !read.data ? <Loading label="Leyendo las tareas de CRMDev" lines={4}/>
      : <><OrderNote page={read.data}/><TasksTable tasks={read.data.items} discreet={discreet}/></>}
  </>;
}
