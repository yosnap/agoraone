import { useState } from 'react';
import { getCrmdevView, type CrmdevFilters, type CrmdevTask } from '../api/crmdev';
import type { Section } from '../shell/shell-state';
import { Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { Badge, CrmdevProblem, LongText, OrderNote, ReadAgain, Said } from './crmdev-common';
import { CrmdevEditTask, CrmdevNewTask } from './crmdev-edit-task';
import { dayLabel, filterOptions, priorityLabels, taskStatusLabels } from './crmdev-labels';
import { changeKey, resetChange, useEditing } from './use-crmdev-change';
import { readKey, useCrmdevRead } from './use-crmdev-view';

/** Some tasks: title (and its description), state, priority, date, assignee's name only and, unless they all belong to
 * one project, the project; with `onEdit`, an «Editar» button on each. In discreet mode neither descriptions nor the
 * assignee column are shown. */
export function TasksTable({ tasks, discreet, withProject = true, onEdit }: {
  tasks: CrmdevTask[]; discreet: boolean; withProject?: boolean; onEdit?: (id: string) => void;
}) {
  if (!tasks.length) return <p className="muted">Ninguna tarea.</p>;
  return <table className="data-table central-table">
    <thead><tr><th>Tarea</th><th>Estado</th><th>Prioridad</th><th>Fecha</th>{!discreet && <th>Asignada a</th>}{withProject && <th>Proyecto</th>}
      {onEdit && <th><span className="visually-hidden">Acciones</span></th>}</tr></thead>
    <tbody>{tasks.map((t, index) => <tr key={t.id ?? index}>
      <td className="crmdev-title"><strong>{t.title ?? '—'}</strong><LongText text={t.description} discreet={discreet}/></td>
      <td><Badge labels={taskStatusLabels} value={t.status}/></td>
      <td><Badge labels={priorityLabels} value={t.priority}/></td>
      <td className="central-date">{dayLabel(t.dueDate)}</td>
      {!discreet && <td>{t.assignee?.name ?? '—'}</td>}
      {withProject && <td>{t.project ?? '—'}</td>}
      {onEdit && <td className="central-row-actions">{t.id && <button type="button" className="button" aria-label={`Editar la tarea ${t.title ?? ''}`}
        onClick={() => onEdit(t.id as string)}>Editar</button>}</td>}
    </tr>)}</tbody>
  </table>;
}

/** Some tasks with «Nueva tarea» and «Editar»: each change is shown exactly and only saved after «Guardar en CRMDev».
 * `list` is the filter the tasks were read with (the core reads a task again from that same list); `project` presets
 * the project of a new task. Members are read only to offer an assignee, never in discreet mode. */
export function EditableTasks({ tasks, list, discreet, withProject = true, project }: {
  tasks: CrmdevTask[]; list: CrmdevFilters['tareas']; discreet: boolean; withProject?: boolean; project?: string;
}) {
  const editing = useEditing(tasks);
  const [creating, setCreating] = useState(false);
  const [said, setSaid] = useState('');
  const projects = useCrmdevRead(creating ? readKey('proyectos') : null, fresh => getCrmdevView('proyectos', {}, fresh));
  const members = useCrmdevRead(creating && !discreet ? readKey('miembros') : null, fresh => getCrmdevView('miembros', {}, fresh));
  const close = () => { setCreating(false); editing.close(); };
  const open = (id: string) => { setSaid(''); setCreating(false); resetChange(changeKey('tarea', id)); editing.open(id, tasks.find(t => t.id === id)); };
  const create = () => { setSaid(''); editing.close(); resetChange(changeKey('tarea-nueva', project)); setCreating(true); };
  const done = (text: string) => { close(); setSaid(text); };
  const task = editing.row;
  return <>
    <Said text={said}/>
    {creating ? <CrmdevNewTask projects={projects.data?.items ?? []} members={members.data?.items ?? []} discreet={discreet} project={project}
      onDone={done} onCancel={close}/>
      // Keyed by id: a reread (after a conflict, say) never remounts it, so what was typed and the review stay.
      : task ? <CrmdevEditTask key={task.id} task={task} list={editing.gone ? {} : list} gone={editing.gone} discreet={discreet} onDone={done} onCancel={close}/>
      : <div className="crmdev-new"><button type="button" className="button" onClick={create}>Nueva tarea</button></div>}
    <TasksTable tasks={tasks} discreet={discreet} withProject={withProject} onEdit={open}/>
  </>;
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
      : <><OrderNote page={read.data}/><EditableTasks tasks={read.data.items} list={filters} discreet={discreet}/></>}
  </>;
}
