import { useRef, useState } from 'react';
import { getFiscalFolders, getQuarter, makeQuarterExcel, openFiscalFile, type FiscalFolder, type QuarterView } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import './fiscal.css';

function money(value: number | string | null | undefined, currency = 'EUR') {
  if (value === null || value === undefined || value === '') return '—';
  try { return Number(value).toLocaleString('es-ES', { style: 'currency', currency }); }
  catch { return `${Number(value).toLocaleString('es-ES', { minimumFractionDigits: 2 })} ${currency}`; }  // an unknown currency code
}
const day = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

function currentQuarter() {
  const now = new Date();
  return { year: now.getFullYear(), quarter: Math.floor(now.getMonth() / 3) + 1 };
}

/** Fiscal: each professional folder's quarter, with the invoices issued (Qonto, read-only) and received
 * (filed by AgoraOne), what to check, and the register for the accountant. */
export function FiscalView({ discreet }: { discreet: boolean }) {
  const [folders, setFolders] = useState<FiscalFolder[] | null>(null);
  const [folderId, setFolderId] = useState<number | null>(null);
  const [period, setPeriod] = useState(currentQuarter);
  const [view, setView] = useState<QuarterView | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [made, setMade] = useState<string | null>(null);
  const asked = useRef(false);
  const request = useRef(0);
  const load = async (folder: number, year: number, quarter: number) => {
    const mine = ++request.current;
    setView(null); setError('');
    try { const found = await getQuarter(folder, year, quarter); if (mine === request.current) setView(found); }
    catch (failure) { if (mine === request.current) setError(failure instanceof Error ? failure.message : 'No se pudo leer el trimestre.'); }
  };
  if (!asked.current) {
    asked.current = true;
    getFiscalFolders().then(found => {
      const professional = found.folders.filter(f => f.kind !== 'personal');
      setFolders(professional);
      if (professional[0]) { setFolderId(professional[0].id); void load(professional[0].id, period.year, period.quarter); }
    }).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer las carpetas.'));
  }
  const reveal = async (path: string | null, show: boolean) => {
    if (!folderId) return;
    try { await openFiscalFile(folderId, path, show); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo abrir.'); }
  };
  const choose = (folder: number, year = period.year, quarter = period.quarter) => { setFolderId(folder); setPeriod({ year, quarter }); setConfirming(false); setNote(''); setMade(null); void load(folder, year, quarter); };
  const excel = async () => {
    if (!folderId) return;
    setConfirming(false); setNote(''); setError('');
    try { const path = (await makeQuarterExcel(folderId, period.year, period.quarter)).path; setMade(path); setNote(`Excel guardado en la carpeta: ${path}`); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo generar el Excel.'); }
  };
  const folder = folders?.find(f => f.id === folderId);
  const years = Array.from({ length: 4 }, (_, i) => currentQuarter().year - i);
  const totalIn = view?.income.reduce((sum, row) => sum + (row.base ?? 0), 0) ?? 0;
  const totalOut = view?.expenses.filter(e => e.currency === 'EUR').reduce((sum, row) => sum + Number(row.total), 0) ?? 0;
  return <section className="page fiscal" aria-labelledby="fiscal-title">
    <div className="eyebrow">FISCAL{discreet ? ' · MODO DISCRETO' : ''}</div>
    <h1 id="fiscal-title">Fiscal</h1>
    <p className="page-lead">El trimestre de cada carpeta profesional, leído de las facturas que ya tienes en ella (Facturas Salientes y Entrantes, estén ordenadas o no) y de las que archiva AgoraOne: lo que conviene revisar y el Excel para el gestor con su formato.</p>
    {folders === null && !error ? <Loading label="Leyendo las carpetas fiscales"/> : folders?.length === 0 ? <p className="muted">Añade una carpeta de tipo autónomo o empresa en Ajustes › Carpetas fiscales.</p> : <>
      <div className="fiscal-bar">
        <label className="field">Carpeta<ModernSelect value={folderId ? String(folderId) : ''} options={(folders ?? []).map(f => ({ value: String(f.id), label: f.name }))} onChange={value => choose(Number(value))}/></label>
        <label className="field">Año<ModernSelect value={String(period.year)} options={years.map(y => ({ value: String(y), label: String(y) }))} onChange={value => folderId && choose(folderId, Number(value))}/></label>
        <div className="segmented" role="group" aria-label="Trimestre">{[1, 2, 3, 4].map(q =>
          <button key={q} aria-pressed={period.quarter === q} onClick={() => folderId && choose(folderId, period.year, q)}>{q}T</button>)}</div>
      </div>
      {error && <LoadError message={error}/>}
      {note && <p className="ok-note" role="status">{note}</p>}
      {made && <div className="field-row fiscal-made">
        <button type="button" className="button primary" onClick={() => void reveal(made, false)}>Abrir el Excel</button>
        <button type="button" className="button" onClick={() => void reveal(made, true)}>Mostrar en Finder</button></div>}
      {folderId && !view && !error ? <Loading label="Leyendo el trimestre" lines={4}/> : view && <>
        <div className="fiscal-totals">
          <article className="card"><span className="muted">Facturado (base)</span><strong>{discreet ? '•••' : money(totalIn)}</strong><small className="muted">{view.income.length} facturas emitidas</small></article>
          <article className="card"><span className="muted">Gastado (total en euros)</span><strong>{discreet ? '•••' : money(totalOut)}</strong><small className="muted">{view.expenses.length} facturas recibidas</small></article>
        </div>
        {view.incomeProblem && <p className="fiscal-warning">{view.incomeProblem}</p>}
        {view.notes.map(n => <p key={n} className="fiscal-warning">{n}</p>)}
        <div className="fiscal-actions">{confirming ? <span className="field-row" role="group" aria-label="Confirmar Excel">
          <span>Se guardará en «{folder?.name}» como <code>Registro-{period.quarter}T-{period.year}-….xlsx</code> (si existe, con un número; nunca se sobrescribe).</span>
          <button type="button" className="button primary" onClick={() => void excel()}>Generar</button>
          <button type="button" className="button" onClick={() => setConfirming(false)}>Cancelar</button></span>
          : <span className="field-row"><button type="button" className="button primary" onClick={() => setConfirming(true)}>Generar el Excel del {period.quarter}T</button>
            <button type="button" className="button" onClick={() => folderId && void load(folderId, period.year, period.quarter)}>Actualizar</button>
            <button type="button" className="button" onClick={() => void reveal(null, false)}>Abrir la carpeta</button></span>}</div>
        {!discreet && <>
          <h2>Ingresos · facturas emitidas</h2>
          {view.income.length === 0 ? <p className="muted">Ninguna en este trimestre.</p> : <div className="fiscal-table"><table><thead><tr><th>Fecha</th><th>Nº</th><th>Cliente</th><th>Base</th><th>IVA</th><th>Total</th></tr></thead>
            <tbody>{view.income.map((row, index) => <tr key={index}><td>{day(row.date)}</td><td>{row.number}</td><td>{row.client}</td><td>{money(row.base, row.currency)}</td>
              <td>{row.vatRate !== null ? `${Math.round((row.vatRate > 1 ? row.vatRate : row.vatRate * 100))} %` : '—'}</td><td>{money(row.total, row.currency)}</td></tr>)}</tbody></table></div>}
          <h2>Gastos · facturas recibidas</h2>
          {view.expenses.length === 0 ? <p className="muted">Ninguna archivada en este trimestre.</p> : <div className="fiscal-table"><table><thead><tr><th>Fecha</th><th>Proveedor</th><th>NIF</th><th>Total</th><th>Dudas</th></tr></thead>
            <tbody>{view.expenses.map(row => <tr key={row.id}><td>{day(row.issuedOn)}</td><td>{row.supplier}</td><td>{row.taxId ?? '—'}</td><td>{money(row.total, row.currency)}</td>
              <td>{row.doubts.length ? row.doubts.join(' ') : '—'}</td></tr>)}</tbody></table></div>}
        </>}
      </>}
    </>}
  </section>;
}
