import { useState } from 'react';
import { phaseStatusLabels, type PhaseStatus, type QuotePhase } from '../api/quotes';
import { ModernSelect } from '../ui/modern-select';
import { ChangeReview, useCentralChange } from '../central/central-change';
import { ActionButton } from '../ui/action-button';

/** The state and due date of a payment milestone of a quote in Central, changed after seeing exactly what changes. */
export function QuotePhaseEdit({ quoteId, phase, onDone, onCancel, onReview }: {
  quoteId: string; phase: QuotePhase & { id: string; revision: string }; onDone: (said: string) => void; onCancel: () => void; onReview: () => void;
}) {
  const [status, setStatus] = useState<string>(phase.status ?? '');
  const [due, setDue] = useState(phase.dueDate?.slice(0, 10) ?? '');
  const change = useCentralChange(onDone);
  const changes = {
    ...(status && status !== phase.status ? { status } : {}),
    ...(due !== (phase.dueDate?.slice(0, 10) ?? '') ? { dueDate: due || null } : {}),
  };
  if (change.preview || change.conflict) return <ChangeReview change={change} onCancel={() => { change.reset(); onCancel(); }} onReview={onReview}/>;
  return <form className="central-edit" onSubmit={event => {
    event.preventDefault();
    void change.ask({ kind: 'fase', id: quoteId, phaseId: phase.id, revision: phase.revision, changes });
  }}>
    <div className="central-edit-grid">
      <label className="field">Estado<ModernSelect value={status} onChange={setStatus}
        options={(Object.keys(phaseStatusLabels) as PhaseStatus[]).map(value => ({ value, label: phaseStatusLabels[value] }))}/></label>
      <label className="field">Fecha prevista<input type="date" value={due} min="2000-01-01" max="2100-12-31" onChange={event => setDue(event.target.value)}/></label>
    </div>
    {change.error && <p className="error" role="alert">{change.error}</p>}
    <div className="actions central-actions">
      <ActionButton icon="close" label="Cancelar" onClick={onCancel}/>
      <ActionButton icon="check" label="Revisar el cambio" tone="primary" busyLabel={change.busy && 'Preparando…'} type="submit" disabled={!Object.keys(changes).length || change.busy}/>
    </div>
  </form>;
}
