import { useState } from 'react';
import { projectStatusLabels, type CentralProjectRecord } from '../api/central';
import { ModernSelect } from '../ui/modern-select';
import { ChangeReview, useCentralChange } from './central-change';
import { ActionButton } from '../ui/action-button';

// Archiving is done in Central only (it removes the project's audits, alerts and uptime monitor): not offered here.
const EDITABLE = ['ACTIVE', 'MAINTENANCE', 'DORMANT'];

/** A project's state and phase in Central, changed from its record after seeing exactly what changes. A fixed state
 * stays fixed; a state not fixed may be fixed here (it can only be unfixed in Central). */
export function CentralEditProject({ project, onDone, onCancel, onReview }: {
  project: CentralProjectRecord & { id: string; revision: string }; onDone: (said: string) => void; onCancel: () => void; onReview: () => void;
}) {
  const [status, setStatus] = useState(project.status ?? '');
  const [phase, setPhase] = useState(project.phase ?? '');
  const [lock, setLock] = useState(false);
  const change = useCentralChange(onDone);
  const changes = {
    ...(status && status !== project.status ? { status } : {}),
    ...(phase.trim() !== (project.phase ?? '') ? { phase: phase.trim() || null } : {}),
    ...(lock && !project.statusLocked ? { statusLocked: true as const } : {}),
  };
  const options = [...(project.status && !EDITABLE.includes(project.status) ? [project.status] : []), ...EDITABLE]
    .map(value => ({ value, label: projectStatusLabels[value] ?? value }));
  if (change.preview || change.conflict) return <ChangeReview change={change} onCancel={() => { change.reset(); onCancel(); }} onReview={onReview}/>;
  return <form className="central-edit" onSubmit={event => { event.preventDefault(); void change.ask({ kind: 'proyecto', id: project.id, revision: project.revision, changes }); }}>
    <div className="central-edit-grid">
      <label className="field">Estado<ModernSelect value={status} onChange={setStatus} options={options}/></label>
      <label className="field">Fase<input value={phase} maxLength={80} placeholder="Desarrollo, Entrega…" onChange={event => setPhase(event.target.value)}/></label>
    </div>
    {project.statusLocked ? <small className="muted">El estado está fijado a mano en Central: seguirá fijado. Archivar o dejar de fijarlo se hace en Central.</small>
      : <label className="central-check"><input type="checkbox" checked={lock} onChange={event => setLock(event.target.checked)}/>
        Fijar el estado para que el escáner de Central no lo cambie (dejar de fijarlo solo se puede en Central)</label>}
    {change.error && <p className="error" role="alert">{change.error}</p>}
    <div className="actions central-actions">
      <ActionButton icon="close" label="Cancelar" onClick={onCancel}/>
      <ActionButton icon="check" label="Revisar el cambio" tone="primary" busyLabel={change.busy && 'Preparando…'} type="submit" disabled={!Object.keys(changes).length || change.busy}/>
    </div>
  </form>;
}
