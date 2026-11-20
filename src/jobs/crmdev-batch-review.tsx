import { useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { confirmBatch, previewBatch, type BatchOutcome, type BatchPreview, type BatchResult, type BatchSkipped } from '../api/clients';
import { invalidateClients } from '../data/clients-store';
import { ActionButton } from '../ui/action-button';
import { LoadError } from '../ui/load-state';

export const OUTCOMES: Record<BatchOutcome, string> = {
  sent: 'Enviado', already: 'Ya estaba así', conflict: 'No enviado: cambió en CRMDev', skipped: 'No enviado: ya apareció en CRMDev',
  unknown: 'Sin respuesta: puede haberse creado', error: 'No enviado', waiting: 'No enviado: CRMDev pide esperar',
};

/** The exact batch of «Enviar a CRMDev» for the ticked warnings: each operation with its fields before and after (as
 * the core will send them), what cannot go and why, and one «Enviar a CRMDev» for all of it. Nothing is sent before
 * that press; the review expires in 15 minutes. Afterwards it says what happened to each one. */
export function CrmdevBatchReview({ keys, onClose, onDone }: { keys: string[]; onClose: () => void; onDone: () => void }) {
  const [shown, setShown] = useState<BatchPreview | null>(null);
  const [skipped, setSkipped] = useState<BatchSkipped[]>([]);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);
  const review = async (anyway: string[] = []) => {
    setBusy(true); setError('');
    try { const found = await previewBatch(keys, anyway); setShown(found); setSkipped(found.skipped); }
    catch (failure) {
      setShown(null);
      if (failure instanceof ApiError && Array.isArray(failure.data?.skipped)) setSkipped(failure.data.skipped as BatchSkipped[]);
      setError(failure instanceof Error ? failure.message : 'No se pudo revisar el envío.');
    } finally { setBusy(false); }
  };
  if (!asked.current) { asked.current = true; void review(); }
  const send = async () => {
    if (!shown) return;
    setBusy(true); setError('');
    try { setResult(await confirmBatch(shown.token)); invalidateClients(); onDone(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo enviar a CRMDev.'); }
    finally { setBusy(false); }
  };
  const doubtful = skipped.filter(s => s.reason.startsWith('Un envío anterior')).map(s => s.key);
  return <section className="card crmdev-batch" aria-label="Revisar el envío a CRMDev">
    <div className="card-head"><h3>{result ? 'Envío a CRMDev' : 'Revisa lo que se enviará a CRMDev'}</h3></div>
    {error && <LoadError message={error}/>}
    {result ? <>
      <p role="status" className="task-done">{result.sent === 1 ? 'Un cambio enviado.' : `${result.sent} cambios enviados.`}{result.warning ? ` ${result.warning}` : ''}</p>
      <ul className="plain-list">{result.results.map(r => <li key={r.key}><strong>{r.title}</strong> <small className="muted">· {OUTCOMES[r.outcome]}{r.message && r.outcome === 'error' ? `: ${r.message}` : ''}</small></li>)}</ul>
      <span className="actions"><ActionButton icon="check" label="Cerrar" onClick={onClose}/></span>
    </> : <>
      {busy && !shown && <p className="muted">Leyendo CRMDev para preparar el envío…</p>}
      {shown && <ol className="plain-list">{shown.operations.map(op => <li key={op.key}>
        <strong>{op.title}</strong>
        <table className="work-table"><tbody>{op.rows.map(row => <tr key={row.field}>
          <th scope="row">{row.label}</th><td className="muted">{row.before ?? '—'}</td><td>→ {row.after ?? '—'}</td></tr>)}</tbody></table>
        {op.notes.map(note => <small key={note} className="muted">{note} </small>)}
      </li>)}</ol>}
      {shown?.warnings.map(w => <p key={w} className="notice">{w}</p>)}
      {skipped.length > 0 && <div><small>No se envía:</small>
        <ul className="plain-list muted">{skipped.map(s => <li key={s.key}><small>{s.name}: {s.reason}</small></li>)}</ul></div>}
      <span className="actions">
        <ActionButton icon="close" label="Cancelar" disabled={busy} onClick={onClose}/>
        {doubtful.length > 0 && <button type="button" className="button" disabled={busy} onClick={() => void review(doubtful)}>Revisado en CRMDev: incluirlos</button>}
        {shown && <ActionButton icon="send" label={`Enviar a CRMDev (${shown.operations.length})`} tone="primary" disabled={busy} onClick={() => void send()}/>}
      </span>
    </>}
  </section>;
}
