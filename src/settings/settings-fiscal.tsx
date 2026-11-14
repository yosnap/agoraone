import { useRef, useState } from 'react';
import { applyFolderPlan, getFiscalFolder, getFolderPlan, putFiscalFolder, type FolderPlan } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';

const SHOWN = 30;

/** The fiscal folder: the only folder AgoraOne writes invoices to, and the plan to tidy it into
 * «Facturas Entrantes|Salientes/año/NT». Moving needs the user's confirmation of the exact list. */
export function FiscalSettingsCard() {
  const [folder, setFolder] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [plan, setPlan] = useState<FolderPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const asked = useRef(false);
  if (!asked.current) { asked.current = true; getFiscalFolder().then(data => setFolder(data.folder)).catch(() => setFolder(null)); }
  const fail = (failure: unknown, fallback: string) => setError(failure instanceof Error ? failure.message : fallback);
  const save = async (value: string | null) => {
    setError(''); setNote(''); setPlan(null);
    try { setFolder((await putFiscalFolder(value)).folder); setDraft(''); setNote(value ? 'Carpeta guardada.' : 'Carpeta olvidada (no se ha tocado nada en ella).'); }
    catch (failure) { fail(failure, 'No se pudo guardar.'); }
  };
  const calculate = async () => {
    setError(''); setNote(''); setPlanning(true); setConfirming(false);
    try { setPlan(await getFolderPlan()); } catch (failure) { fail(failure, 'No se pudo calcular el plan.'); } finally { setPlanning(false); }
  };
  const apply = async () => {
    if (!plan) return;
    setError(''); setNote('');
    try {
      const done = await applyFolderPlan(plan.moves.map(move => move.from));
      setNote(`${done.moved.length} archivos movidos. Copia previa en los datos de AgoraOne (${done.backup}).`); setPlan(null); setConfirming(false);
    } catch (failure) { fail(failure, 'No se pudo mover.'); }
  };
  return <article className="card" aria-labelledby="fiscal-title">
    <h2 id="fiscal-title">Carpeta fiscal</h2>
    <p>La subcarpeta de tu actividad donde se archivan las facturas, por trimestre. AgoraOne no toca nada fuera de ella (ni tu carpeta personal ni la raíz de iCloud Drive) y nunca sobrescribe ni borra.</p>
    {folder === undefined ? <Loading label="Leyendo la carpeta"/> : folder ? <>
      <p className="muted">Carpeta: <code>{folder}</code> <button type="button" className="button" onClick={() => void save(null)}>Olvidar</button></p>
      <div className="field-row"><button type="button" className="button" disabled={planning} onClick={() => void calculate()}>{planning ? 'Calculando…' : 'Proponer cómo ordenarla'}</button></div>
    </> : <form className="field-row" onSubmit={event => { event.preventDefault(); void save(draft.trim()); }}>
      <label className="field">Ruta de la carpeta<input value={draft} onChange={event => setDraft(event.target.value)} placeholder="~/Library/Mobile Documents/com~apple~CloudDocs/Trabajo/…" spellCheck={false} autoComplete="off"/></label>
      <button className="button primary" disabled={!draft.trim()}>Guardar</button>
    </form>}
    {plan && <div className="mail-new" aria-label="Plan de orden">
      {plan.moves.length === 0 ? <p>Todo está ya en su sitio{plan.undecided.length ? ', salvo lo que no se puede saber' : ''}.</p> : <>
        <p>{plan.moves.length}{plan.more ? `+${plan.more}` : ''} archivos irían a «Facturas Entrantes|Salientes/año/NT», deducido de los nombres de sus carpetas:</p>
        <ul className="fiscal-moves">{plan.moves.slice(0, SHOWN).map(move => <li key={move.from}><code>{move.from}</code> → <code>{move.to}</code></li>)}</ul>
        {plan.moves.length > SHOWN && <p className="muted">…y {plan.moves.length - SHOWN} más.</p>}
      </>}
      {plan.undecided.length > 0 && <p className="muted">{plan.undecided.length} archivos se quedan donde están porque su carpeta no dice el año o el trimestre.</p>}
      {plan.moves.length > 0 && (confirming ? <div className="field-row" role="group" aria-label="Confirmar movimientos">
        <button type="button" className="button primary" onClick={() => void apply()}>Mover {plan.moves.length} archivos (con copia previa)</button>
        <button type="button" className="button" onClick={() => setConfirming(false)}>Cancelar</button>
      </div> : <button type="button" className="button" onClick={() => setConfirming(true)}>Aplicar este plan…</button>)}
    </div>}
    {note && <span className="ok-note" role="status">{note}</span>}{error && <LoadError message={error}/>}
  </article>;
}
