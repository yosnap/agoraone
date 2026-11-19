import { useState } from 'react';
import { getCrmdevHours, getCrmdevView, type CrmdevFilters, type CrmdevHours, type CrmdevProject } from '../api/crmdev';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { Block, Facts, RecordLayout } from '../ui/record-layout';
import { Badge, CrmdevProblem, OpenInCrmdev, OrderNote, ReadAgain } from './crmdev-common';
import { dayLabel, filterOptions, labelOf, minutesLabel, projectStatusLabels, projectTypeLabels } from './crmdev-labels';
import { TasksTable } from './crmdev-tasks';
import { readKey, useCrmdevRead, type CrmdevRead } from './use-crmdev-view';

const progressLabel = (progress: number | null) => (progress == null ? '—' : `${progress} %`);

/** The minutes of each person over the rows shown, most first. */
export function hoursByPerson(rows: CrmdevHours['rows']): [string, number][] {
  const sums = new Map<string, number>();
  for (const row of rows) sums.set(row.user ?? 'Sin nombre', (sums.get(row.user ?? 'Sin nombre') ?? 0) + (row.minutes ?? 0));
  return [...sums.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'));
}

/** A project's hours: CRMDev's total, the time of each person and the rows by task and person. When only the first
 * rows came, it says so: the total is CRMDev's, the sums per person only those rows'. In discreet mode only the totals:
 * no person's name. */
export function ProjectHours({ read, discreet, onOpen }: { read: CrmdevRead<CrmdevHours> & { reload: () => void }; discreet: boolean; onOpen: (section: Section) => void }) {
  if (read.failure) return <CrmdevProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/>;
  if (!read.data) return <Loading label="Leyendo las horas del proyecto" lines={3}/>;
  const h = read.data;
  return <>
    <Facts items={[['Total', h.total ?? '—'], ['Registros', h.entries == null ? '—' : String(h.entries)]]}/>
    {discreet ? <p className="muted">Las horas por persona y tarea se ocultan en modo discreto.</p> : <HoursDetail hours={h}/>}
  </>;
}

/** The time of each person and the rows by task and person (never in discreet mode). */
function HoursDetail({ hours }: { hours: CrmdevHours }) {
  if (!hours.rows.length) return <p className="muted">Sin horas registradas.</p>;
  return <>
    {hours.cut && <p className="notice" role="note">Solo se ven los primeros {hours.rows.length} registros: el total es el de CRMDev y las sumas por persona son solo de esos registros. El resto, en CRMDev.</p>}
    <table className="data-table central-table">
      <thead><tr><th>Persona</th><th className="num">Tiempo</th></tr></thead>
      <tbody>{hoursByPerson(hours.rows).map(([name, minutes]) => <tr key={name}><td>{name}</td><td className="num">{minutesLabel(minutes)}</td></tr>)}</tbody>
    </table>
    <table className="data-table central-table">
      <thead><tr><th>Tarea</th><th>Persona</th><th className="num">Tiempo</th></tr></thead>
      <tbody>{hours.rows.map((row, index) => <tr key={index}><td>{row.task ?? '—'}</td><td>{row.user ?? '—'}</td><td className="num">{minutesLabel(row.minutes)}</td></tr>)}</tbody>
    </table>
  </>;
}

/** A project's record, built from the list just read (CRMDev has no read by id), with its tasks and its hours. */
export function ProjectRecord({ project, readAt, discreet, onBack, onOpen }: {
  project: CrmdevProject & { id: string }; readAt: string | null; discreet: boolean; onBack: () => void; onOpen: (section: Section) => void;
}) {
  const tasks = useCrmdevRead(readKey('tareas', { proyecto: project.id }), fresh => getCrmdevView('tareas', { proyecto: project.id }, fresh));
  const hours = useCrmdevRead(`horas:${project.id}`, fresh => getCrmdevHours(project.id, fresh));
  return <RecordLayout titleId="crmdev-project-title" title={project.name ?? 'Proyecto sin nombre'} badges={<span className="chip">De CRMDev</span>}
    actions={<span className="actions"><ReadAgain times={[readAt, tasks.data?.readAt, hours.data?.readAt]}/>
      <OpenInCrmdev page={`proyectos/${project.id}`} discreet={discreet}/>
      <button type="button" className="button" onClick={onBack}>Volver a la lista</button></span>}>
    <Block title="Estado">
      <Facts items={[['Estado', labelOf(projectStatusLabels, project.status)], ['Progreso', progressLabel(project.progress)],
        ['Tipo', labelOf(projectTypeLabels, project.type)], ['Fecha límite', dayLabel(project.deadline)]]}/>
    </Block>
    <Block title="Horas"><ProjectHours read={hours} discreet={discreet} onOpen={onOpen}/></Block>
    <Block title="Tareas" wide>
      {tasks.failure ? <CrmdevProblem failure={tasks.failure} onRetry={tasks.reload} onOpen={onOpen}/>
        : !tasks.data ? <Loading label="Leyendo las tareas del proyecto" lines={3}/>
        : <><OrderNote page={tasks.data}/><TasksTable tasks={tasks.data.items} discreet={discreet} withProject={false}/></>}
    </Block>
  </RecordLayout>;
}

/** Proyectos: the 100 most recent, filtered by state in CRMDev, and each project's record. */
export function CrmdevProjects({ discreet, onOpen }: { discreet: boolean; onOpen: (section: Section) => void }) {
  const [filters, setFilters] = useState<CrmdevFilters['proyectos']>({});
  const [open, setOpen] = useState<string | null>(null);
  const read = useCrmdevRead(readKey('proyectos', filters), fresh => getCrmdevView('proyectos', filters, fresh));
  const picked = open ? read.data?.items.find(p => p.id === open) : undefined;
  if (picked?.id) return <ProjectRecord project={{ ...picked, id: picked.id }} readAt={read.data?.readAt ?? null} discreet={discreet} onBack={() => setOpen(null)} onOpen={onOpen}/>;
  return <>
    <div className="field-row central-filters">
      <label className="field">Estado<ModernSelect value={filters.estado ?? ''} onChange={value => setFilters({ estado: value || undefined })}
        options={filterOptions(projectStatusLabels)}/></label>
      <ReadAgain times={[read.data?.readAt]}/>
    </div>
    {read.failure ? <CrmdevProblem failure={read.failure} onRetry={read.reload} onOpen={onOpen}/>
      : !read.data ? <Loading label="Leyendo los proyectos de CRMDev" lines={4}/>
      : <>
        <OrderNote page={read.data}/>
        {!read.data.items.length ? <p className="muted">Ningún proyecto{filters.estado ? ' con este estado' : ''}.</p> : <table className="data-table central-table">
          <thead><tr><th>Proyecto</th><th>Estado</th><th className="num">Progreso</th><th>Tipo</th><th>Fecha límite</th>
            <th><span className="visually-hidden">Acciones</span></th></tr></thead>
          <tbody>{read.data.items.map((p, index) => <tr key={p.id ?? index}>
            <td className="crmdev-title"><strong>{p.name ?? '—'}</strong></td>
            <td><Badge labels={projectStatusLabels} value={p.status}/></td>
            <td className="num">{progressLabel(p.progress)}</td>
            <td>{labelOf(projectTypeLabels, p.type)}</td>
            <td className="central-date">{dayLabel(p.deadline)}</td>
            <td className="central-row-actions">{p.id && <span className="actions">
              <button type="button" className="button" aria-label={`Ver ficha de ${p.name ?? 'proyecto sin nombre'}`} onClick={() => setOpen(p.id)}>Ver ficha</button>
              <OpenInCrmdev page={`proyectos/${p.id}`} discreet={discreet}/></span>}</td>
          </tr>)}</tbody>
        </table>}
      </>}
  </>;
}
