import { useState } from 'react';
import { deleteDocument, renameDocument, type LibraryDocument } from '../api/client';

export function DocumentActions({ document, onRenamed, onDeleted }: {
  document: LibraryDocument; onRenamed: (document: LibraryDocument) => void; onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [title, setTitle] = useState(document.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo completar la operación.'); }
    finally { setBusy(false); }
  }
  return <section className="document-actions" aria-label="Gestionar copia importada">
    {!editing && !confirming && <div className="document-action-buttons">
      <button onClick={() => { setTitle(document.title); setEditing(true); setError(''); }}>Renombrar</button>
      <button onClick={() => { setConfirming(true); setError(''); }}>Eliminar copia</button>
    </div>}
    {editing && <form onSubmit={event => {
      event.preventDefault();
      if (!busy) void run(async () => { onRenamed(await renameDocument(document.id, title)); setEditing(false); });
    }}>
      <label htmlFor="document-title">Nuevo nombre</label>
      <input id="document-title" value={title} maxLength={160} disabled={busy} onChange={e => setTitle(e.target.value)} autoFocus/>
      <div className="document-action-buttons"><button disabled={busy || !title.trim()} type="submit">Guardar nombre</button><button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancelar</button></div>
    </form>}
    {confirming && <div role="group" aria-label="Confirmar eliminación">
      <p>¿Eliminar la copia «{document.title}» de AgoraOne?</p>
      <small>El original no se modifica. No se borran las conversaciones ni los textos ya enviados a Hermes; una consulta en curso puede terminar.</small>
      <div className="document-action-buttons"><button disabled={busy} onClick={() => void run(async () => { await deleteDocument(document.id); onDeleted(); })}>Confirmar eliminación</button><button disabled={busy} onClick={() => setConfirming(false)}>Cancelar</button></div>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
