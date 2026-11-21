import { useRef, useState } from 'react';
import { ApiError } from '../api/client';
import type { BatchOutcome, BatchPreview, BatchResult, BatchSkipped } from '../api/clients';
import { invalidateClients } from '../data/clients-store';
import { ActionButton } from '../ui/action-button';
import { LoadError } from '../ui/load-state';
import './sync.css';

export const OUTCOMES: Record<BatchOutcome, string> = {
  sent: 'Hecho', already: 'Ya estaba así', conflict: 'No enviado: cambió desde la revisión', skipped: 'No enviado: ya apareció',
  unknown: 'Sin respuesta: puede haberse creado', error: 'No enviado', waiting: 'No enviado: pide esperar',
};

/** Where a batch goes and how: «CRMDev» with «Enviar a CRMDev», «Central» with «Crear en Central». */
export type BatchDest = {
  name: 'CRMDev' | 'Central'; action: string;
  preview: (anyway: string[]) => Promise<BatchPreview>; confirm: (token: string) => Promise<BatchResult>;
};

/** The exact batch for what the user ticked: each operation with its fields before and after (as the core will send
 * them), what cannot go and why, and one button for all of it («Enviar a CRMDev», «Crear en Central»). Nothing is sent
 * before that press; the review expires in 15 minutes. Afterwards it says what happened to each one. */
export function BatchReview({ dest, onClose, onDone }: { dest: BatchDest; onClose: () => void; onDone: () => void }) {
  const [shown, setShown] = useState<BatchPreview | null>(null);
  const [skipped, setSkipped] = useState<BatchSkipped[]>([]);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);
  const review = async (anyway: string[] = []) => {
    setBusy(true); setError('');
    try { const found = await dest.preview(anyway); setShown(found); setSkipped(found.skipped); }
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
    try { setResult(await dest.confirm(shown.token)); invalidateClients(); onDone(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : `No se pudo enviar a ${dest.name}.`); }
    finally { setBusy(false); }
  };
  const doubtful = skipped.filter(s => s.reason.startsWith('Un envío anterior')).map(s => s.key);
  return <section className="card batch-review" aria-label={`Revisar el envío a ${dest.name}`}>
    <div className="card-head"><h3>{result ? `Envío a ${dest.name}` : `Revisa lo que se enviará a ${dest.name}`}</h3></div>
    {error && <LoadError message={error}/>}
    {!result && shown?.org && <p className="sync-org">Se enviará a la organización de {dest.name} <strong>«{shown.org.name}»</strong>.</p>}
    {result ? <>
      <p role="status" className="task-done">{result.sent === 1 ? `Un cambio hecho en ${dest.name}.` : `${result.sent} cambios hechos en ${dest.name}.`}{result.warning ? ` ${result.warning}` : ''}</p>
      <table className="data-table"><thead><tr><th>Cambio</th><th>Resultado</th></tr></thead>
        <tbody>{result.results.map(r => <tr key={r.key}><td><strong>{r.title}</strong></td>
          <td>{OUTCOMES[r.outcome]}{r.message && r.outcome === 'error' ? `: ${r.message}` : ''}</td></tr>)}</tbody></table>
      <span className="actions"><ActionButton icon="check" label="Cerrar" onClick={onClose}/></span>
    </> : <>
      {busy && !shown && <p className="muted">Leyendo {dest.name} para preparar el envío…</p>}
      {shown && <ol className="batch-review-list">{shown.operations.map(op => <li key={op.key}>
        <strong>{op.title}</strong>{op.origin && <small className="muted"> · {op.origin}</small>}
        <table className="data-table"><thead><tr><th>Campo</th><th>Ahora</th><th>Quedará</th></tr></thead>
          <tbody>{op.rows.map(row => <tr key={row.field}>
            <th scope="row">{row.label}</th><td className="sync-before">{row.before ?? '—'}</td><td><strong>{row.after ?? '—'}</strong></td></tr>)}</tbody></table>
        {(op.notes ?? []).map(note => <small key={note} className="muted">{note} </small>)}
      </li>)}</ol>}
      {shown?.warnings.map(w => <p key={w} className="notice">{w}</p>)}
      {skipped.length > 0 && <div><small>No se envía:</small>
        <ul className="batch-review-skipped muted">{skipped.map(s => <li key={s.key}><strong>{s.name}</strong>: {s.reason}</li>)}</ul></div>}
      <span className="actions">
        <ActionButton icon="close" label="Cancelar" disabled={busy} onClick={onClose}/>
        {doubtful.length > 0 && <button type="button" className="button" disabled={busy} onClick={() => void review(doubtful)}>Revisado en {dest.name}: incluirlos</button>}
        {shown && <ActionButton icon="send" label={`${dest.action} (${shown.operations.length})`} tone="primary" disabled={busy} onClick={() => void send()}/>}
      </span>
    </>}
  </section>;
}
