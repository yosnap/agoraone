import { useState } from 'react';
import type { CrmdevFilters, CrmdevMember, CrmdevProject, CrmdevTask, CrmdevTaskValues } from '../api/crmdev';
import { ModernSelect } from '../ui/modern-select';
import { CrmdevReview, EditActions } from './crmdev-common';
import { optionsOf } from './crmdev-edit-ticket';
import { priorityLabels, taskStatusLabels } from './crmdev-labels';
import { useCrmdevChange } from './use-crmdev-change';

const withNone = (none: string, options: { value: string; label: string }[]) => [{ value: '', label: none }, ...options];

/** A new task in CRMDev: title, description, project, assignee, state, priority and due date. In discreet mode no
 * person is offered (their names are hidden), so the task is created without an assignee. */
export function CrmdevNewTask({ projects, members, discreet, project, onDone, onCancel }: {
  projects: CrmdevProject[]; members: CrmdevMember[]; discreet: boolean; project?: string; onDone: (said: string) => void; onCancel: () => void;
}) {
  const [values, setValues] = useState<Required<CrmdevTaskValues>>({ title: '', description: '', projectId: project ?? '', assigneeId: '', status: '',
    priority: '', dueDate: '' });
  const change = useCrmdevChange(onDone);
  const set = (field: keyof CrmdevTaskValues) => (value: string) => setValues({ ...values, [field]: value });
  const sent = Object.fromEntries(Object.entries({ ...values, assigneeId: discreet ? '' : values.assigneeId })
    .map(([field, value]) => [field, value.trim()]).filter(([, value]) => value)) as CrmdevTaskValues;
  const projectOptions = projects.filter((p): p is CrmdevProject & { id: string } => Boolean(p.id)).map(p => ({ value: p.id, label: p.name ?? p.id }));
  const memberOptions = members.filter((m): m is CrmdevMember & { id: string } => Boolean(m.id)).map(m => ({ value: m.id, label: m.name ?? m.id }));
  if (change.preview || change.conflict) return <CrmdevReview change={change} onCancel={onCancel} onReview={() => undefined}/>;
  return <form className="central-edit crmdev-edit" aria-label="Nueva tarea en CRMDev"
    onSubmit={event => { event.preventDefault(); void change.ask({ kind: 'tarea-nueva', values: sent }); }}>
    <strong>Nueva tarea en CRMDev</strong>
    <div className="central-edit-grid">
      <label className="field central-edit-wide">Título<input value={values.title} maxLength={300} required onChange={event => set('title')(event.target.value)}/></label>
      <label className="field central-edit-wide">Descripción<textarea value={values.description} maxLength={4000} rows={3} onChange={event => set('description')(event.target.value)}/></label>
      <label className="field">Proyecto<ModernSelect value={values.projectId} onChange={set('projectId')} options={withNone('Sin proyecto', projectOptions)}/></label>
      {!discreet && <label className="field">Asignada a<ModernSelect value={values.assigneeId} onChange={set('assigneeId')} options={withNone('Sin asignar', memberOptions)}/></label>}
      <label className="field">Estado<ModernSelect value={values.status} onChange={set('status')} options={withNone('Por defecto (Por hacer)', optionsOf(taskStatusLabels, null))}/></label>
      <label className="field">Prioridad<ModernSelect value={values.priority} onChange={set('priority')} options={withNone('Por defecto (Media)', optionsOf(priorityLabels, null))}/></label>
      <label className="field">Fecha límite<input type="date" value={values.dueDate} min="2000-01-01" max="2100-12-31" onChange={event => set('dueDate')(event.target.value)}/></label>
    </div>
    {discreet && <small className="muted">En modo discreto no se ven los nombres de las personas: la tarea se crea sin asignar.</small>}
    {change.error && <p className="error" role="alert">{change.error}</p>}
    <EditActions busy={change.busy} disabled={!values.title.trim()} onCancel={onCancel}/>
  </form>;
}

/** A task's title, description, state and priority, changed after seeing exactly what changes. In discreet mode its
 * description is neither shown nor offered. */
export function CrmdevEditTask({ task, list, discreet, onDone, onCancel }: {
  task: CrmdevTask & { id: string }; list: CrmdevFilters['tareas']; discreet: boolean; onDone: (said: string) => void; onCancel: () => void;
}) {
  const [values, setValues] = useState({ title: task.title ?? '', description: task.description ?? '', status: task.status ?? '', priority: task.priority ?? '' });
  const change = useCrmdevChange(onDone);
  const description = values.description.trim();
  const changes = {
    ...(values.title.trim() && values.title.trim() !== (task.title ?? '') ? { title: values.title.trim() } : {}),
    ...(!discreet && description !== (task.description ?? '') ? { description: description || null } : {}),
    ...(values.status && values.status !== task.status ? { status: values.status } : {}),
    ...(values.priority && values.priority !== task.priority ? { priority: values.priority } : {}),
  };
  if (change.preview || change.conflict) return <CrmdevReview change={change} onCancel={onCancel} onReview={() => undefined}/>;
  return <form className="central-edit crmdev-edit" aria-label="Cambiar la tarea"
    onSubmit={event => { event.preventDefault(); void change.ask({ kind: 'tarea', id: task.id, list, changes }); }}>
    <div className="central-edit-grid">
      <label className="field central-edit-wide">Título<input value={values.title} maxLength={300} required onChange={event => setValues({ ...values, title: event.target.value })}/></label>
      {!discreet && <label className="field central-edit-wide">Descripción<textarea value={values.description} maxLength={4000} rows={3}
        onChange={event => setValues({ ...values, description: event.target.value })}/></label>}
      <label className="field">Estado<ModernSelect value={values.status} onChange={status => setValues({ ...values, status })} options={optionsOf(taskStatusLabels, task.status)}/></label>
      <label className="field">Prioridad<ModernSelect value={values.priority} onChange={priority => setValues({ ...values, priority })} options={optionsOf(priorityLabels, task.priority)}/></label>
    </div>
    {discreet && <small className="muted">La descripción se oculta en modo discreto: cámbiala fuera de él.</small>}
    {change.error && <p className="error" role="alert">{change.error}</p>}
    <EditActions busy={change.busy} disabled={!Object.keys(changes).length} onCancel={onCancel}/>
  </form>;
}
