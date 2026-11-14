import { useRef, useState } from 'react';
import { fileInvoice, prepareInvoice, type Category, type InvoiceFields, type InvoicePrepared, type InvoiceSource } from '../api/core';
import { DocumentFields, FolderChoice, place } from './filing-fields';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';

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
  const [folderId, setFolderId] = useState<number | null>(null);
  const [category, setCategory] = useState<Category | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);
  // What is on screen now: a «sí» files these values, never the ones first proposed.
  const current = useRef<{ fields: InvoiceFields | null; source: string; busy: boolean; folderId: number | null; category: Category | null }>(
    { fields: null, source: '', busy: false, folderId: null, category: null });
  current.current = { fields, source, busy, folderId, category };
  const chosen = (value: string, found: InvoicePrepared | null = prepared): InvoiceSource | null =>
    value.startsWith('part:') && found?.sources.some(item => `part:${item.part}` === value) ? { kind: 'attachment', part: Number(value.slice(5)) }
      : value.startsWith('https://') ? { kind: 'link', url: value } : null;
  const file = async (pick: InvoiceSource | null, values: InvoiceFields | null, found: InvoicePrepared | null) => {
    const { folderId: folder, category: kind } = current.current;
    if (!pick || !values || !found || !folder || current.current.busy) return;
    current.current.busy = true;
    setBusy(true); setError('');
    try { onFiled((await fileInvoice(messageId, folder, kind, pick, values, found.doubts)).path); onReady?.(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo archivar.'); }
    finally { setBusy(false); }
  };
  if (!asked.current) {
    asked.current = true;
    prepareInvoice(messageId).then(found => {
      setPrepared(found); setFields(found.proposal); setFolderId(found.folderId);
      const first = found.source ? `part:${found.source.part}` : found.links[0]?.url ?? '';
      setSource(first);
      // A plain «sí» may file it only when it is attached and nothing needs checking; it files what is on screen.
      const suggested = found.folders.find(item => item.id === found.folderId);
      onReady?.(found.source && found.doubts.length === 0 && suggested && suggested.kind !== 'personal'
        ? () => file(chosen(current.current.source, found), current.current.fields, found) : null);
    }).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo preparar la factura.'));
  }
  if (error && !prepared) return <LoadError message={error}/>;
  if (!prepared || !fields) return <Loading label="Buscando la factura en el correo" lines={2}/>;
  const options = [
    ...prepared.sources.map(item => ({ value: `part:${item.part}`, label: `Adjunto: ${item.name}` })),
    ...prepared.links.map(link => ({ value: link.url, label: `Descargar de ${link.host}` })),
  ];
  const folder = prepared.folders.find(item => item.id === folderId);
  return <div className="invoice-filing">
    {options.length ? <label className="field">De dónde sale<ModernSelect value={source} options={options} onChange={setSource}/></label>
      : <p className="muted">No hay PDF adjunto ni enlace de descarga: entra en la web del proveedor, descárgala y vuelve a intentarlo cuando llegue por correo.</p>}
    {source.startsWith('https://') && <p className="muted">Se descargará solo al pulsar «Archivar», desde {new URL(source).host}, y únicamente si es un PDF. Si pide iniciar sesión, <a href={source} target="_blank" rel="noreferrer">ábrela en el navegador</a>.</p>}
    <FolderChoice folders={prepared.folders} folderId={folderId} category={category} onFolder={setFolderId} onCategory={setCategory}/>
    <DocumentFields fields={fields} onChange={setFields}/>
    {prepared.doubts.length > 0 && <ul className="invoice-doubts" aria-label="Dudas">{prepared.doubts.map((doubt, index) => <li key={index}>{doubt}</li>)}</ul>}
    {folder && <p className="muted">Irá a «{folder.name}»: <code>{place(fields, folder.kind, category) ?? prepared.destination}</code> (si el nombre existe, se añade un número; nunca se sobrescribe).</p>}
    {options.length > 0 && <button type="button" className="button primary"
      disabled={busy || !folder || (folder.kind === 'personal' && !category) || !fields.supplier.trim() || !fields.total.trim() || !fields.issuedOn}
      onClick={() => void file(chosen(source), fields, prepared)}>{busy ? 'Archivando…' : 'Archivar la factura'}</button>}
    {error && <LoadError message={error}/>}
  </div>;
}
