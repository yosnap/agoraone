import { useState } from 'react';
import type { CrmdevFilters, CrmdevProject } from '../api/crmdev';
import { ModernSelect } from '../ui/modern-select';
import { CrmdevReview, EditActions, reviewing } from './crmdev-common';
import { optionsOf } from './crmdev-edit-ticket';
import { projectStatusLabels } from './crmdev-labels';
import { changeKey, useCrmdevChange } from './use-crmdev-change';

export type ProjectForm = { name: string; status: string; progress: string };
/** Whether the progress typed is not a whole number from 0 to 100 (empty is «not changed»). */
export const badProgress = (progress: string) => {
  const number = progress.trim() === '' ? null : Number(progress);
  return number !== null && !(Number.isInteger(number) && number >= 0 && number <= 100);
};
/** What a project's form sends: only what differs from CRMDev, never its description. */
export function projectChanges(project: CrmdevProject, values: ProjectForm): { name?: string; status?: string; progress?: number } {
  const name = values.name.trim(), number = values.progress.trim() === '' || badProgress(values.progress) ? null : Number(values.progress);
  return {
    ...(name && name !== (project.name ?? '') ? { name } : {}),
    ...(values.status && values.status !== project.status ? { status: values.status } : {}),
    ...(number !== null && number !== project.progress ? { progress: number } : {}),
  };
}

/** A project's name, state and progress, changed after seeing exactly what changes. Its description is not offered
 * (CRMDev's list does not give it, so its current value could not be shown), and a project is created in CRMDev. */
export function CrmdevEditProject({ project, list, onDone, onCancel }: {
  project: CrmdevProject & { id: string }; list: CrmdevFilters['proyectos']; onDone: (said: string) => void; onCancel: () => void;
}) {
  const [values, setValues] = useState<ProjectForm>({ name: project.name ?? '', status: project.status ?? '',
    progress: project.progress == null ? '' : String(project.progress) });
  const change = useCrmdevChange(changeKey('proyecto', project.id), onDone);
  const changes = projectChanges(project, values), wrong = badProgress(values.progress);
  if (reviewing(change)) return <CrmdevReview change={change} onCancel={onCancel} onReview={() => undefined}/>;
  return <form className="central-edit crmdev-edit" aria-label="Cambiar el proyecto"
    onSubmit={event => { event.preventDefault(); void change.ask({ kind: 'proyecto', id: project.id, list, changes }); }}>
    <div className="crmdev-edit-row">
      <label className="field">Nombre<input value={values.name} maxLength={300} required onChange={event => setValues({ ...values, name: event.target.value })}/></label>
      <label className="field">Estado<ModernSelect value={values.status} onChange={status => setValues({ ...values, status })} options={optionsOf(projectStatusLabels, project.status)}/></label>
      <label className="field">Progreso (%)<input type="number" min={0} max={100} step={1} value={values.progress}
        onChange={event => setValues({ ...values, progress: event.target.value })}/></label>
      <EditActions busy={change.busy} disabled={!Object.keys(changes).length || wrong} onCancel={onCancel}/>
    </div>
    {wrong && <p className="error" role="alert">El progreso va de 0 a 100, sin decimales.</p>}
    <small className="muted">La descripción del proyecto se cambia en CRMDev: aquí no se ve.</small>
    {change.error && <p className="error" role="alert">{change.error}</p>}
  </form>;
}
