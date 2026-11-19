import { useRef, useState } from 'react';
import { downloadFromQonto, getFiscalFolders, getQuarter, makeQuarterExcel, openFiscalFile, type FiscalIssue, type FiscalFolder, type ManualSaved, type QuarterView } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { ReceiptsPanel } from './receipts-panel';
import { ModernSelect } from '../ui/modern-select';
import { ManualForm } from './manual-form';
import './fiscal.css';
import { ActionButton } from '../ui/action-button';

function money(value: number | string | null | undefined, currency = 'EUR') {
  if (value === null || value === undefined || value === '') return '—';
  try { return Number(value).toLocaleString('es-ES', { style: 'currency', currency }); }
  catch { return `${Number(value).toLocaleString('es-ES', { minimumFractionDigits: 2 })} ${currency}`; }  // an unknown currency code
}
const day = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const TYPES: Record<string, string> = { pdf: 'PDF', png: 'IMG', jpg: 'IMG', jpeg: 'IMG', heic: 'IMG', html: 'HTML', htm: 'HTML', xlsx: 'XLS', xls: 'XLS', zip: 'ZIP' };
const fileType = (path: string) => TYPES[(path.split('.').pop() ?? '').toLowerCase()] ?? (path.split('.').pop() ?? '').toUpperCase();
const FILE_ICON = <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" d="M6 2h8l5 5v15H6zM14 2v5h5M9 13h6M9 17h6"/></svg>;
const FOLDER_ICON = <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" d="M3 6h6l2 2h10v11H3z"/></svg>;

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
  const [detail, setDetail] = useState<FiscalIssue | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // An invoice nothing could be read from, being typed by hand (only those: the rest go in exactly as read).
  const [editing, setEditing] = useState<{ path: string; saved?: ManualSaved | null } | null>(null);
  const asked = useRef(false);
  const request = useRef(0);
  // While invoices are still being read, the quarter refreshes itself every few seconds (no need to press anything).
  const timer = useRef<number | undefined>(undefined);
  const live = useRef(true);
  const holder = useRef((node: HTMLElement | null) => { live.current = node !== null; if (!node) window.clearTimeout(timer.current); }).current;
  const load = async (folder: number, year: number, quarter: number, quiet = false) => {
    const mine = ++request.current;
    window.clearTimeout(timer.current);
    if (!quiet) setView(null);
    setError('');
    try {
      const found = await getQuarter(folder, year, quarter);
      if (mine !== request.current || !live.current) return;
      setView(found);
      if (found.reading > 0) timer.current = window.setTimeout(() => void load(folder, year, quarter, true), 5000);
    } catch (failure) { if (mine === request.current) setError(failure instanceof Error ? failure.message : 'No se pudo leer el trimestre.'); }
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
  const manualForm = editing && folderId ? <ManualForm key={editing.path} folderId={folderId} path={editing.path} saved={editing.saved}
    onCancel={() => setEditing(null)} onDone={done => {
      setDetail(current => current && { ...current, items: current.items.filter(item => item.path !== editing.path) });
      setEditing(null); setError(''); setNote(done); void load(folderId, period.year, period.quarter, true);
    }}/> : null;
  const editButton = (path: string | undefined, saved: ManualSaved | null | undefined) => path && saved
    ? <button type="button" className="button fiscal-edit" onClick={() => setEditing({ path, saved })}>Editar datos</button> : null;
  // Each invoice opens with its app or shows in the Finder, to check it against what was read.
  const fileButtons = (path: string | undefined) => path ? <span className="fiscal-file">
    <span className="chip fiscal-type">{fileType(path)}</span>
    <button type="button" className="icon-button" title={`Abrir el archivo · ${path.split('/').pop()}`} aria-label="Abrir el archivo" onClick={() => void reveal(path, false)}>{FILE_ICON}</button>
    <button type="button" className="icon-button" title="Mostrar en su carpeta" aria-label="Mostrar en su carpeta" onClick={() => void reveal(path, true)}>{FOLDER_ICON}</button></span> : null;
  const years = Array.from({ length: 4 }, (_, i) => currentQuarter().year - i);
  const totalIn = view?.income.reduce((sum, row) => sum + (row.base ?? 0), 0) ?? 0;
  // Spent, in euros: foreign-currency invoices count with their ECB rate (when it could be fetched).
  const euros = (row: { currency: string; total: string | number; totalEur?: number }) => row.currency === 'EUR' ? Number(row.total) : row.totalEur ?? 0;
  const totalOut = view?.expenses.reduce((sum, row) => sum + euros(row as never), 0) ?? 0;
  const totalBase = view?.income.reduce((sum, row) => sum + (row.total !== null ? Number(row.total) : 0), 0) ?? 0;
  // One invoice at a time, so the screen can say «2 of 7» and each one leaves the list as soon as it is saved.
  const fetchFromQonto = async (numbers: string[]) => {
    if (!folderId || !detail) return;
    setDownloading(true); setError(''); setNote('');
    let saved = 0;
    const failed: string[] = [];
    for (const [index, number] of numbers.entries()) {
      setProgress({ done: index, total: numbers.length });
      try {
        const done = await downloadFromQonto(folderId, period.year, period.quarter, [number]);
        if (done.saved.length) {
          saved += 1;
          setDetail(current => current && { ...current, items: current.items.filter(item => item.qonto !== number) });
        } else failed.push(`${number}: ${done.failed[0]?.error ?? 'no se pudo'}`);
      } catch (failure) { failed.push(`${number}: ${failure instanceof Error ? failure.message : 'no se pudo'}`); }
    }
    setProgress(null); setDownloading(false);
    setNote(`${saved} de ${numbers.length} facturas descargadas de Qonto en «Facturas Salientes».`);
    if (failed.length) setError(`No se pudieron descargar: ${failed.join('; ')}`);
    void load(folderId, period.year, period.quarter, true);
  };
  if (detail) return <section className="page fiscal" aria-labelledby="fiscal-detail" ref={holder}>
    <button type="button" className="button" onClick={() => { setDetail(null); setEditing(null); }}>‹ Volver a Fiscal</button>
    <div className="eyebrow">FISCAL · {folder?.name} · {period.quarter}T {period.year}</div>
    <h1 id="fiscal-detail">Detalle del aviso</h1>
    <p className="page-lead">{detail.key === 'qonto' ? `Qonto tiene ${detail.items.length} facturas emitidas este trimestre que no están en «Facturas Salientes».` : detail.text}</p>
    {detail.key === 'qonto' && detail.items.length > 0 && <p><button type="button" className="button primary" disabled={downloading}
      onClick={() => void fetchFromQonto(detail.items.map(item => item.qonto!).filter(Boolean))}>{downloading ? 'Descargando…' : `Descargar de Qonto las ${detail.items.length}`}</button></p>}
    {progress && <div className="fiscal-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-label="Descargando de Qonto">
      <span>Descargando {progress.done + 1} de {progress.total}… (quedan {progress.total - progress.done})</span>
      <span className="fiscal-progress-bar"><i style={{ width: `${Math.round(100 * progress.done / progress.total)}%` }}/></span></div>}
    {note && <p className="ok-note" role="status">{note}</p>}
    {detail.items.length === 0 && <p className="muted">No queda nada pendiente en este aviso.</p>}
    {error && <LoadError message={error}/>}
    {manualForm}
    <div className="fiscal-table"><table><thead><tr><th>Documento</th><th>Detalle</th><th><span className="visually-hidden">Acciones</span></th></tr></thead>
      <tbody>{detail.items.map((item, index) => <tr key={index}><td>{discreet ? '•••' : item.label}</td><td className="fiscal-detail-path">{discreet && ['qonto', 'foreign', 'foreignIncome'].includes(detail.key) ? '•••' : item.detail}</td>
        <td>{item.qonto ? <ActionButton icon="download" label="Descargar" disabled={downloading} onClick={() => void fetchFromQonto([item.qonto!])}/>
          : <span className="fiscal-file">{fileButtons(item.path ?? undefined)}{['unreadable', 'images'].includes(detail.key) && item.path
            && <button type="button" className="button fiscal-edit" onClick={() => setEditing({ path: item.path! })}>Escribir los datos</button>}</span>}</td></tr>)}</tbody></table></div>
    {detail.items.length >= 500 && <p className="muted">Se muestran los 500 primeros.</p>}
  </section>;
  return <section className="page fiscal" aria-labelledby="fiscal-title" ref={holder}>
    <div className="eyebrow">FISCAL{discreet ? ' · MODO DISCRETO' : ''}</div>
    <h1 id="fiscal-title">Fiscal</h1>
    <p className="page-lead">El trimestre de cada carpeta profesional, leído de las facturas que ya tienes en ella (Facturas Salientes y Entrantes, estén ordenadas o no) y de las que archiva AgoraOne: lo que conviene revisar y el Excel para el gestor con su formato.</p>
    <ReceiptsPanel onNote={done => { setNote(done); if (folderId) void load(folderId, period.year, period.quarter, true); }}/>
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
          <article className="card"><span className="muted">Facturado (base)</span><strong>{discreet ? '•••' : money(totalIn)}</strong><small className="muted">{view.income.length} facturas emitidas · {discreet ? '•••' : money(totalBase)} cobrado con IVA e IRPF</small></article>
          <article className="card"><span className="muted">Gastado (total en euros, con el cambio del BCE)</span><strong>{discreet ? '•••' : money(totalOut)}</strong><small className="muted">{view.expenses.length} facturas recibidas</small></article>
        </div>
        {view.reading > 0 && <div className="fiscal-progress" role="progressbar" aria-valuemin={0} aria-valuemax={view.readingTotal} aria-valuenow={view.readingTotal - view.reading}
          aria-label="Leyendo facturas de la carpeta">
          <span>Leyendo facturas de la carpeta: {view.readingTotal - view.reading} de {view.readingTotal}. Se completa solo.</span>
          <span className="fiscal-progress-bar"><i style={{ width: `${Math.round(100 * (view.readingTotal - view.reading) / Math.max(1, view.readingTotal))}%` }}/></span>
        </div>}
        {view.incomeProblem && <p className="fiscal-warning">{view.incomeProblem}</p>}
        {view.notes.filter(n => !view.issues.some(i => i.text === n)).map(n => <p key={n} className="fiscal-warning">{n}</p>)}
        {view.issues.map(issue => <button key={issue.key} type="button" className="fiscal-warning fiscal-issue" onClick={() => setDetail(issue)}>
          <span>{issue.text}</span><span className="fiscal-issue-more">Ver el detalle ›</span></button>)}
        <div className="fiscal-actions">{confirming ? <span className="field-row" role="group" aria-label="Confirmar Excel">
          <span>Se guardará en «{folder?.name}» como <code>Registro-{period.quarter}T-{period.year}-….xlsx</code> (si existe, con un número; nunca se sobrescribe).</span>
          <button type="button" className="button primary" onClick={() => void excel()}>Generar</button>
          <ActionButton icon="close" label="Cancelar" onClick={() => setConfirming(false)}/></span>
          : <span className="field-row"><button type="button" className="button primary" onClick={() => setConfirming(true)}>Generar el Excel del {period.quarter}T</button>
            <ActionButton icon="refresh" label="Actualizar" onClick={() => folderId && void load(folderId, period.year, period.quarter)}/>
            <button type="button" className="button" onClick={() => void reveal(null, false)}>Abrir la carpeta</button></span>}</div>
        {!discreet && <>
          {manualForm}
          <h2>Ingresos · facturas emitidas</h2>
          {view.income.length === 0 ? <p className="muted">Ninguna en este trimestre.</p> : <div className="fiscal-table"><table><thead><tr><th>Fecha</th><th>Nº</th><th>Cliente</th><th className="num">Base</th><th className="num">IVA</th><th className="num">Total</th><th><span className="visually-hidden">Archivo</span></th></tr></thead>
            <tbody>{view.income.map((row, index) => <tr key={index}><td>{day(row.date)}</td><td>{row.number}</td><td>{row.client}{row.knownClient && row.knownClient !== row.client && <small className="muted"> · {discreet ? '•••' : row.knownClient}</small>}</td><td className="num">{money(row.base, row.currency)}</td>
              <td className="num">{row.vatRate !== null ? `${Math.round((row.vatRate > 1 ? row.vatRate : row.vatRate * 100))} %` : '—'}</td><td className="num">{money(row.total, row.currency)}</td><td><span className="fiscal-file">{fileButtons(row.file)}{editButton(row.file, row.manual)}</span></td></tr>)}</tbody></table></div>}
          <h2>Gastos · facturas recibidas</h2>
          {view.expenses.length === 0 ? <p className="muted">Ninguna archivada en este trimestre.</p> : <div className="fiscal-table"><table><thead><tr><th>Fecha</th><th>Proveedor</th><th>NIF</th><th className="num">Total</th><th>Dudas</th><th><span className="visually-hidden">Archivo</span></th></tr></thead>
            <tbody>{view.expenses.map(row => <tr key={row.id}><td>{day(row.issuedOn)}</td><td>{row.supplier}</td><td>{row.taxId ?? '—'}</td><td className="num">{money(row.total, row.currency)}{(row as { totalEur?: number }).totalEur !== undefined && <small className="muted fiscal-eur">≈ {money((row as { totalEur?: number }).totalEur)}</small>}</td>
              <td>{row.doubts.length ? row.doubts.join(' ') : '—'}</td><td><span className="fiscal-file">{fileButtons(row.file ?? row.path)}{editButton(row.file, row.manual)}</span></td></tr>)}</tbody></table></div>}
        </>}
      </>}
    </>}
  </section>;
}
