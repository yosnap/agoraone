import { useState } from 'react';
import { ApiError } from '../api/client';
import { confirmCentralChange, getWritePermissions, previewCentralChange, type ChangePreview, type ChangeRequest, type CurrentRow } from '../api/central-write';
import { useCentralRead } from './use-central-view';

// The two steps of every change to Central: «Revisar el cambio» asks the core for the exact change (before and after,
// field by field) and «Guardar en Central» sends exactly that, once. A conflict (changed in Central meanwhile) shows
// what Central has now and offers to review again; nothing is retried by itself.

type Conflict = { message: string; current: CurrentRow[] };
type State = { preview: ChangePreview | null; busy: boolean; error: string; conflict: Conflict | null };
const IDLE: State = { preview: null, busy: false, error: '', conflict: null };
const CONFLICTS = new Set(['conflict', 'status_locked', 'duplicate']);

const messageOf = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
const conflictOf = (error: unknown): Conflict | null => {
  if (!(error instanceof ApiError) || error.status !== 409 || !CONFLICTS.has(String(error.data?.status))) return null;
  const current = Array.isArray(error.data?.current) ? (error.data.current as CurrentRow[]) : [];
  return { message: error.message, current };
};

/** The state of one change: `ask` shows its preview, `send` saves it in Central and calls `onDone` with what to say. */
export function useCentralChange(onDone: (said: string) => void) {
  const [state, setState] = useState<State>(IDLE);
  const ask = async (change: ChangeRequest) => {
    setState({ ...IDLE, busy: true });
    try { setState({ ...IDLE, preview: await previewCentralChange(change) }); }
    catch (error) {
      const conflict = conflictOf(error);
      setState({ ...IDLE, conflict, error: conflict ? '' : messageOf(error, 'No se pudo preparar el cambio.') });
    }
  };
  const send = async () => {
    const preview = state.preview;
    if (!preview || state.busy) return;
    setState({ ...state, busy: true, error: '' });
    try {
      const done = await confirmCentralChange(preview.token);
      setState(IDLE);
      onDone(done.warning ?? `${done.title}: guardado en Central.`);
    } catch (error) {
      const conflict = conflictOf(error);
      const kind = error instanceof ApiError ? String(error.data?.status ?? '') : '';
      // Central busy (nothing written) keeps the preview so the user may press again; anything else is reviewed anew.
      const keep = kind === 'busy' || kind === 'unreachable';
      setState({ preview: keep && !conflict ? preview : null, busy: false, conflict, error: conflict ? '' : messageOf(error, 'No se pudo guardar en Central.') });
    }
  };
  return { ...state, ask, send, reset: () => setState(IDLE) };
}

/** Whether the saved key may change Central (read once per visit of the section, with the other readings). */
export function useWritePermissions() {
  const read = useCentralRead('permisos-escritura', getWritePermissions);
  return { central: read.data?.central === true, quotes: read.data?.quotes === true, problem: read.data?.problem ?? null };
}

const shown = (value: string | null) => (value === null || value === '' ? <em className="muted">vacío</em> : value);

/** The exact change, field by field, and the buttons to save it or not; or, after a conflict, what Central has now. */
export function ChangeReview({ change, onCancel, onReview }: { change: ReturnType<typeof useCentralChange>; onCancel: () => void; onReview: () => void }) {
  if (change.conflict) {
    return <div className="central-change" role="alert">
      <p className="notice">{change.conflict.message}</p>
      {change.conflict.current.length > 0 && <table className="data-table central-table">
        <thead><tr><th>Campo</th><th>Lo que hay ahora en Central</th></tr></thead>
        <tbody>{change.conflict.current.map(row => <tr key={row.field}><td>{row.label}</td><td className="central-text">{shown(row.value)}</td></tr>)}</tbody>
      </table>}
      <div className="actions central-actions">
        <button type="button" className="button" onClick={onCancel}>Cerrar</button>
        <button type="button" className="button primary" onClick={onReview}>Volver a revisar</button>
      </div>
    </div>;
  }
  const preview = change.preview;
  if (!preview) return change.error ? <p className="error" role="alert">{change.error}</p> : null;
  return <div className="central-change" aria-label="Cambio que se hará en Central">
    <strong>{preview.title}</strong>
    <table className="data-table central-table">
      <thead><tr><th>Campo</th><th>Ahora en Central</th><th>Después</th></tr></thead>
      <tbody>{preview.rows.map(row => <tr key={row.field} className={row.emptied ? 'central-emptied' : undefined}>
        <td>{row.label}</td><td className="central-text">{shown(row.before)}</td><td className="central-text"><strong>{shown(row.after)}</strong></td>
      </tr>)}</tbody>
    </table>
    {preview.warnings.map(text => <p key={text} className="notice">{text}</p>)}
    {preview.notes.map(text => <p key={text} className="muted">{text}</p>)}
    {change.error && <p className="error" role="alert">{change.error}</p>}
    <div className="actions central-actions">
      <button type="button" className="button" disabled={change.busy} onClick={onCancel}>Cancelar</button>
      <button type="button" className="button primary" disabled={change.busy} onClick={() => void change.send()}>{change.busy ? 'Guardando…' : 'Guardar en Central'}</button>
    </div>
  </div>;
}
