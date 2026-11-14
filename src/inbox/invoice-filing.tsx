import { useRef, useState } from 'react';
import { fileInvoice, prepareInvoice, type InvoiceFields, type InvoicePrepared, type InvoiceSource } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';

/** The total as the core writes it in the name (same rule as its `amount`): «1.234,5» → «1234,50». */
function shownTotal(value: string) {
  let text = value.replace(/[^\d,.-]/g, '');
  if (/^-?\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, '');
  else if (text.includes(',') && text.includes('.')) text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  else if (text.includes(',')) text = /,\d{1,2}$/.test(text) ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  const number = Number(text);
  return text && Number.isFinite(number) ? number.toFixed(2).replace('.', ',') : null;
}

/** Where the core will put it, from the fields as edited (the core decides; this is the same rule). */
function place(fields: InvoiceFields) {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(fields.issuedOn);
  if (!match) return null;
  const total = shownTotal(fields.total);
  // eslint-disable-next-line no-control-regex
  const supplier = fields.supplier.replace(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 60) || 'Proveedor';
  return total ? `Facturas Entrantes/${match[1]}/${Math.floor((Number(match[2]) - 1) / 3) + 1}T/${fields.issuedOn} ${supplier} ${total}.pdf` : null;
}

/** Filing a payment notice's invoice: what was found (attached PDF or links), the fields read from it, what
 * does not match, and the exact place it goes. Nothing is downloaded or written until «Archivar». */
export function InvoiceFiling({ messageId, onFiled, onReady }: {
  messageId: number; onFiled: (path: string) => void;
  /** Lets a caller (Watson's announcement) know whether a plain «sí» may file it: attached, no doubts. */
  onReady?: (file: (() => Promise<void>) | null) => void;
}) {
  const [prepared, setPrepared] = useState<InvoicePrepared | null>(null);
  const [fields, setFields] = useState<InvoiceFields | null>(null);
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);
  // What is on screen now: a «sí» files these values, never the ones first proposed.
  const current = useRef<{ fields: InvoiceFields | null; source: string; busy: boolean }>({ fields: null, source: '', busy: false });
  current.current = { fields, source, busy };
  const chosen = (value: string, found: InvoicePrepared | null = prepared): InvoiceSource | null =>
    value.startsWith('part:') && found?.sources.some(item => `part:${item.part}` === value) ? { kind: 'attachment', part: Number(value.slice(5)) }
      : value.startsWith('https://') ? { kind: 'link', url: value } : null;
  const file = async (pick: InvoiceSource | null, values: InvoiceFields | null, found: InvoicePrepared | null) => {
    if (!pick || !values || !found || current.current.busy) return;
    current.current.busy = true;
    setBusy(true); setError('');
    try { onFiled((await fileInvoice(messageId, pick, values, found.doubts)).path); onReady?.(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo archivar.'); }
    finally { setBusy(false); }
  };
  if (!asked.current) {
    asked.current = true;
    prepareInvoice(messageId).then(found => {
      setPrepared(found); setFields(found.proposal);
      const first = found.source ? `part:${found.source.part}` : found.links[0]?.url ?? '';
      setSource(first);
      // A plain «sí» may file it only when it is attached and nothing needs checking; it files what is on screen.
      onReady?.(found.source && found.doubts.length === 0
        ? () => file(chosen(current.current.source, found), current.current.fields, found) : null);
    }).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo preparar la factura.'));
  }
  if (error && !prepared) return <LoadError message={error}/>;
  if (!prepared || !fields) return <Loading label="Buscando la factura en el correo" lines={2}/>;
  const options = [
    ...prepared.sources.map(item => ({ value: `part:${item.part}`, label: `Adjunto: ${item.name}` })),
    ...prepared.links.map(link => ({ value: link.url, label: `Descargar de ${link.host}` })),
  ];
  const set = (key: keyof InvoiceFields) => (event: { target: { value: string } }) => setFields({ ...fields, [key]: event.target.value });
  return <div className="invoice-filing">
    {options.length ? <label className="field">De dónde sale<ModernSelect value={source} options={options} onChange={setSource}/></label>
      : <p className="muted">No hay PDF adjunto ni enlace de descarga: entra en la web del proveedor, descárgala y vuelve a intentarlo cuando llegue por correo.</p>}
    {source.startsWith('https://') && <p className="muted">Se descargará solo al pulsar «Archivar», desde {new URL(source).host}, y únicamente si es un PDF. Si pide iniciar sesión, <a href={source} target="_blank" rel="noreferrer">ábrela en el navegador</a>.</p>}
    <div className="mail-account-fields">
      <label className="field">Proveedor<input value={fields.supplier} onChange={set('supplier')} maxLength={120}/></label>
      <label className="field">NIF<input value={fields.taxId ?? ''} onChange={set('taxId')} maxLength={20}/></label>
      <label className="field">Fecha<input type="date" value={fields.issuedOn} onChange={set('issuedOn')}/></label>
      <label className="field">Total<input value={fields.total} onChange={set('total')} maxLength={20} inputMode="decimal"/></label>
      <label className="field">Moneda<input value={fields.currency} onChange={set('currency')} maxLength={3}/></label>
    </div>
    {prepared.doubts.length > 0 && <ul className="invoice-doubts" aria-label="Dudas">{prepared.doubts.map((doubt, index) => <li key={index}>{doubt}</li>)}</ul>}
    <p className="muted">Irá a <code>{place(fields) ?? prepared.destination}</code> (si el nombre existe, se añade un número; nunca se sobrescribe).</p>
    {options.length > 0 && <button type="button" className="button primary" disabled={busy || !fields.supplier.trim() || !fields.total.trim() || !fields.issuedOn}
      onClick={() => void file(chosen(source), fields, prepared)}>{busy ? 'Archivando…' : 'Archivar la factura'}</button>}
    {error && <LoadError message={error}/>}
  </div>;
}
