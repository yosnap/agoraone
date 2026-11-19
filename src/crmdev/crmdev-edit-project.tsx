import { useState } from 'react';
import type { CrmdevFilters, CrmdevProject } from '../api/crmdev';
import { ModernSelect } from '../ui/modern-select';
import { CrmdevReview, EditActions } from './crmdev-common';
import { optionsOf } from './crmdev-edit-ticket';
import { projectStatusLabels } from './crmdev-labels';
import { useCrmdevChange } from './use-crmdev-change';

/** A project's name, state and progress, changed after seeing exactly what changes. Its description is not offered
 * (CRMDev's list does not give it, so its current value could not be shown), and a project is created in CRMDev. */
export function CrmdevEditProject({ project, list, onDone, onCancel }: {
  project: CrmdevProject & { id: string }; list: CrmdevFilters['proyectos']; onDone: (said: string) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(project.name ?? '');
  const [status, setStatus] = useState(project.status ?? '');
  const [progress, setProgress] = useState(project.progress == null ? '' : String(project.progress));
  const change = useCrmdevChange(onDone);
  const number = progress.trim() === '' ? null : Number(progress);
  const badProgress = number !== null && !(Number.isInteger(number) && number >= 0 && number <= 100);
  const changes = {
    ...(name.trim() && name.trim() !== (project.name ?? '') ? { name: name.trim() } : {}),
    ...(status && status !== project.status ? { status } : {}),
    ...(number !== null && !badProgress && number !== project.progress ? { progress: number } : {}),
  };
  if (change.preview || change.conflict) return <CrmdevReview change={change} onCancel={onCancel} onReview={() => undefined}/>;
  return <form className="central-edit crmdev-edit" aria-label="Cambiar el proyecto"
    onSubmit={event => { event.preventDefault(); void change.ask({ kind: 'proyecto', id: project.id, list, changes }); }}>
    <div className="crmdev-edit-row">
      <label className="field">Nombre<input value={name} maxLength={300} required onChange={event => setName(event.target.value)}/></label>
      <label className="field">Estado<ModernSelect value={status} onChange={setStatus} options={optionsOf(projectStatusLabels, project.status)}/></label>
      <label className="field">Progreso (%)<input type="number" min={0} max={100} step={1} value={progress} onChange={event => setProgress(event.target.value)}/></label>
      <EditActions busy={change.busy} disabled={!Object.keys(changes).length || badProgress} onCancel={onCancel}/>
    </div>
    {badProgress && <p className="error" role="alert">El progreso va de 0 a 100, sin decimales.</p>}
    <small className="muted">La descripción del proyecto se cambia en CRMDev: aquí no se ve.</small>
    {change.error && <p className="error" role="alert">{change.error}</p>}
  </form>;
}
