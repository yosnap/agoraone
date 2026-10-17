import { useRef, useState } from 'react';
import { importDocument, type LibraryDocument } from '../api/client';

export function DocumentImport({ onImported }: { onImported: (document: LibraryDocument) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  return <section className="document-import" aria-label="Importar documento">
    <button className="primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Importando…' : 'Añadir documento'}</button>
    <input ref={input} type="file" accept=".txt,.md,.markdown,.pdf,.docx" aria-label="Archivo para importar" hidden onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      setBusy(true); setError(''); setNotice('');
      try { const document = await importDocument(file); onImported(document); setNotice(`Copia guardada: ${document.title}`); }
      catch (e) { setError(e instanceof Error ? e.message : 'No se pudo importar.'); }
      finally { setBusy(false); }
    }}/>
    <small>TXT/Markdown: 24 KiB. PDF/DOCX: 5 MiB y hasta 24 KiB de texto extraído; PDF de hasta 100 páginas. Sin OCR. Se guarda solo el texto, sin imágenes ni maquetación, privado para este navegador; el original no se modifica. Revisa la lectura antes de adjuntarla: solo entonces, al consultar a Luma, se envía a tu proveedor.</small>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
