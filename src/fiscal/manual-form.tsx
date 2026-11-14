import { useState } from 'react';
import { removeManual, saveManual, type ManualFields, type ManualSaved } from '../api/core';
import { LoadError } from '../ui/load-state';

const percent = (rate: number | null | undefined) => rate === null || rate === undefined ? '' : String(Math.round(rate * 10000) / 100);

/** The data of an invoice AgoraOne could not read in any way, typed by the user. The file is never touched;
 * what is typed goes into the quarter and the Excel marked «Datos escritos a mano». */
export function ManualForm({ folderId, path, saved, onDone, onCancel }: {
  folderId: number; path: string; saved?: ManualSaved | null; onDone: (note: string) => void; onCancel: () => void;
}) {
  const issued = path.startsWith('Facturas Salientes/');
  const [form, setForm] = useState<ManualFields>({
    name: saved?.name ?? '', taxId: saved?.taxId ?? '', number: saved?.number ?? '', issuedOn: saved?.issuedOn ?? '',
    base: saved?.base ?? '', vatRate: percent(saved?.vatRate), vat: saved?.vat ?? '', withholdingRate: percent(saved?.withholdingRate),
    withholding: saved?.withholding ?? '', total: saved?.total ?? '', currency: saved?.currency ?? 'EUR',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key: keyof ManualFields) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  const run = async (work: () => Promise<unknown>, note: string) => {
    setBusy(true); setError('');
    try { await work(); onDone(note); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
    finally { setBusy(false); }
  };
  const field = (key: keyof ManualFields, label: string, extra: Record<string, unknown> = {}) =>
    <label className="field">{label}<input value={form[key] ?? ''} onChange={set(key)} {...extra}/></label>;
  return <form className="card fiscal-manual" aria-labelledby="fiscal-manual-title"
    onSubmit={event => { event.preventDefault(); void run(() => saveManual(folderId, path, form), `Datos guardados para ${path.split('/').pop()}.`); }}>
    <h2 id="fiscal-manual-title">Escribir los datos a mano</h2>
    <p className="muted">{path}. AgoraOne no ha podido leer esta factura. Lo que escribas entra en el trimestre y en el Excel con la nota «Datos escritos a mano»; el archivo no se toca. Si el archivo cambia, se vuelve a leer.</p>
    <div className="fiscal-manual-grid">
      {field('name', issued ? 'Cliente' : 'Proveedor', { maxLength: 120, autoFocus: true })}
      {field('taxId', 'NIF', { maxLength: 30 })}
      {field('number', 'Nº de factura', { maxLength: 40 })}
      {field('issuedOn', 'Fecha', { type: 'date', required: true })}
      {field('base', 'Base imponible', { inputMode: 'decimal', maxLength: 20 })}
      {field('vatRate', '% IVA', { inputMode: 'decimal', maxLength: 6 })}
      {field('vat', 'Cuota de IVA', { inputMode: 'decimal', maxLength: 20 })}
      {field('withholdingRate', '% IRPF', { inputMode: 'decimal', maxLength: 6 })}
      {field('withholding', 'IRPF retenido', { inputMode: 'decimal', maxLength: 20 })}
      {field('total', 'Total', { inputMode: 'decimal', required: true, maxLength: 20 })}
      {field('currency', 'Moneda', { maxLength: 3 })}
    </div>
    <p className="muted">Sin base ni IVA, se registra como un recibo sin IVA desglosado (base igual al total).</p>
    {error && <LoadError message={error}/>}
    <div className="field-row">
      <button type="submit" className="button primary" disabled={busy}>Guardar</button>
      <button type="button" className="button" disabled={busy} onClick={onCancel}>Cancelar</button>
      {saved && <button type="button" className="button" disabled={busy} onClick={() => void run(() => removeManual(folderId, path), 'Datos a mano quitados: vuelve a contar como sin leer.')}>Quitar los datos</button>}
    </div>
  </form>;
}
