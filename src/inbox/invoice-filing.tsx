import { useRef, useState } from 'react';
import { fileInvoice, prepareInvoice, type InvoiceFields, type InvoicePrepared, type InvoiceSource } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';

/** Where the core will put it, from the fields as edited (the core decides; this is the same rule). */
function place(fields: InvoiceFields) {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(fields.issuedOn);
  if (!match) return null;
  const supplier = fields.supplier.replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Proveedor';
  return `Facturas Entrantes/${match[1]}/${Math.floor((Number(match[2]) - 1) / 3) + 1}T/${fields.issuedOn} ${supplier} ${fields.total.trim().replace(/\.(\d{2})$/, ",$1")}.pdf`;
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
  const chosen = (value: string, found: InvoicePrepared | null = prepared): InvoiceSource | null =>
    value === 'attachment' && found?.source ? { kind: 'attachment', part: found.source.part } : value.startsWith('https://') ? { kind: 'link', url: value } : null;
  const file = async (pick: InvoiceSource | null, values: InvoiceFields | null, found: InvoicePrepared | null) => {
    if (!pick || !values || !found) return;
    setBusy(true); setError('');
    try { onFiled((await fileInvoice(messageId, pick, values, found.doubts)).path); onReady?.(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo archivar.'); }
    finally { setBusy(false); }
  };
  if (!asked.current) {
    asked.current = true;
    prepareInvoice(messageId).then(found => {
      setPrepared(found); setFields(found.proposal);
      const first = found.source ? 'attachment' : found.links[0]?.url ?? '';
      setSource(first);
      onReady?.(found.source && found.doubts.length === 0 ? () => file(chosen('attachment', found), found.proposal, found) : null);
    }).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo preparar la factura.'));
  }
  if (error && !prepared) return <LoadError message={error}/>;
  if (!prepared || !fields) return <Loading label="Buscando la factura en el correo" lines={2}/>;
  const options = [
    ...(prepared.source ? [{ value: 'attachment', label: `Adjunto: ${prepared.source.name}` }] : []),
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
