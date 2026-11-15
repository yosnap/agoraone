import { useRef, useState } from 'react';
import {
  closeUpload, dismissReceipt, fileReceipt, getFiscalFolders, getReceipts, getUpload, openUpload,
  type Category, type FiscalFolder, type InvoiceFields, type Receipt, type UploadState,
} from '../api/core';
import { LoadError } from '../ui/load-state';
import { DocumentFields, FolderChoice, place } from '../inbox/filing-fields';
import { BotInbox } from './bot-inbox';
import '../inbox/inbox.css';

const suffixes: Record<string, string> = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic' };
const today = () => new Date().toLocaleDateString('sv-SE');

/** Invoices and tickets that do not come by mail: from the phone (a QR opens a one-time upload on the home
 * network for 10 minutes) or from the user's Hermes bot (it saves them in «Recibos por revisar» inside a fiscal
 * folder). They wait here until the user picks the folder, checks the data and files them. */
export function ReceiptsPanel({ onNote }: { onNote: (note: string) => void }) {
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [folders, setFolders] = useState<FiscalFolder[]>([]);
  const [error, setError] = useState('');
  const [inboxName, setInboxName] = useState('Recibos por revisar');
  const asked = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const live = useRef(true);
  const holder = useRef((node: HTMLDivElement | null) => { live.current = node !== null; if (!node) window.clearTimeout(timer.current); }).current;
  const load = () => Promise.all([getReceipts(), getFiscalFolders()]).then(([found, known]) => { if (live.current) { setReceipts(found.receipts); setFolders(known.folders); if (found.inbox) setInboxName(found.inbox); } })
    .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer los recibos.'));
  if (!asked.current) {
    asked.current = true;
    void load();
    // An upload still open (the panel was left and opened again) shows its QR again.
    getUpload().then(state => { if (live.current && state.open) { setUpload(state); follow(); } }).catch(() => undefined);
  }
  const follow = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (!live.current) return;
      getUpload().then(state => {
        if (!live.current) return;
        setUpload(state);
        if (state.open) follow();
        else { if (state.received) onNote('Recibo recibido desde el móvil: revísalo y archívalo.'); void load(); }
      }).catch(() => undefined);
    }, 2000);
  };
  const start = async () => {
    setError('');
    try { const state = await openUpload(); setUpload(state); follow(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo abrir la subida.'); }
  };
  const stop = async () => { window.clearTimeout(timer.current); setUpload(await closeUpload().catch(() => null)); };
  const minutes = upload?.expiresAt ? Math.max(0, Math.round((upload.expiresAt * 1000 - Date.now()) / 60000)) : 0;
  return <div className="inbox-group" ref={holder}>
    <div className="card-head"><h2>Recibos {receipts.length > 0 && <span className="muted">· {receipts.length}</span>}</h2>
      {upload?.open ? <button type="button" className="button" onClick={() => void stop()}>Cerrar la subida</button>
        : <button type="button" className="button" onClick={() => void start()}>Subir desde el móvil</button>}</div>
    {upload?.open && upload.qr && <div className="card receipt-upload">
      <img className="receipt-qr" alt="Código QR para subir el recibo" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(upload.qr)}`}/>
      <div>
        <p>Escanea el código con la cámara del móvil (en la misma wifi de casa), haz la foto del recibo o elige un PDF y pulsa «Enviar al Mac».</p>
        <p className="muted">El enlace sirve para una sola subida y se cierra solo en unos {minutes} minutos. Mientras esté abierto, solo esa página es accesible desde la red de casa. Si macOS pregunta si permites conexiones entrantes, acéptalo para esta subida.</p>
      </div>
    </div>}
    <BotInbox folders={folders} inbox={inboxName}/>
    {error && <LoadError message={error}/>}
    {receipts.length === 0 && !upload?.open && <p className="muted">No hay recibos esperando.</p>}
    {receipts.length > 0 && <ul className="inbox-cards">{receipts.map(receipt =>
      <ReceiptCard key={receipt.id} receipt={receipt} folders={folders} onDone={note => { onNote(note); void load(); }}/>)}</ul>}
  </div>;
}

function ReceiptCard({ receipt, folders, onDone }: { receipt: Receipt; folders: FiscalFolder[]; onDone: (note: string) => void }) {
  const [fields, setFields] = useState<InvoiceFields>({ supplier: receipt.fields.supplier ?? '', taxId: receipt.fields.taxId ?? null,
    issuedOn: receipt.fields.issuedOn ?? today(), total: receipt.fields.total ?? '', currency: receipt.fields.currency ?? 'EUR' });
  // One that came through a folder's «Recibos por revisar» starts in that folder.
  const [picked, setFolderId] = useState<number | null>(receipt.inboxFolder);
  const folderId = picked ?? (folders.length === 1 ? folders[0].id : null);
  const [category, setCategory] = useState<Category | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const folder = folders.find(item => item.id === folderId);
  const file = async () => {
    if (!folder) return;
    setBusy(true); setError('');
    try { onDone(`Recibo archivado en ${(await fileReceipt(receipt.id, folder.id, category, fields)).path}.`); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo archivar.'); } finally { setBusy(false); }
  };
  return <li className="card inbox-card">
    <div className="card-head"><div className="inbox-chips"><span className="chip warn">Recibo</span><span className="chip">{receipt.mediaType === 'application/pdf' ? 'PDF' : 'Foto'}</span>
      <span className="chip">{receipt.source === 'inbox' ? 'De tu bot' : 'Desde el móvil'}</span></div>
      <span className="muted">{new Date(receipt.uploadedAt).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div>
    {receipt.name && <p className="inbox-subject">{receipt.name}</p>}
    {receipt.mediaType !== 'application/pdf' && <p className="muted">De las fotos aún no se leen los datos: escríbelos mirando el recibo.</p>}
    {folders.length === 0 ? <p className="muted">Añade primero una carpeta fiscal en Ajustes.</p> : <>
      <FolderChoice folders={folders} folderId={folderId} category={category} onFolder={setFolderId} onCategory={setCategory}/>
      <DocumentFields fields={fields} onChange={setFields}/>
      {folder && <p className="muted">Irá a «{folder.name}»: <code>{place(fields, folder.kind, category, suffixes[receipt.mediaType]) ?? '—'}</code></p>}
    </>}
    <div className="inbox-actions">
      <button type="button" className="button primary" disabled={busy || !folder || (folder.kind === 'personal' && !category) || !fields.supplier.trim() || !fields.total.trim() || !fields.issuedOn}
        onClick={() => void file()}>{busy ? 'Archivando…' : 'Archivar el recibo'}</button>
      <button type="button" className="button" onClick={() => void dismissReceipt(receipt.id).then(() => onDone('Recibo descartado.')).catch(() => setError('No se pudo descartar.'))}>Descartar</button>
    </div>
    {error && <LoadError message={error}/>}
  </li>;
}
