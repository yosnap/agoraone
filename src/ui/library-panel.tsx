import { useEffect, useState } from 'react';
import { listDocuments, readDocument, type DocumentSource, type LibraryDocument, type Status, type CatalogEntry } from '../api/client';
import { ChatPanel } from './chat-panel';
import { DocumentImport } from './document-import';
import { DocumentActions } from './document-actions';
import './library.css';

export function LibraryPanel({ status, onConnected, inside, onEnter, tab, onTab, document, onDocument }: {
  status: Status | null; onConnected: () => void; inside: boolean; onEnter: () => void;
  tab: 'chat' | 'documents'; onTab: (tab: 'chat' | 'documents') => void;
  document?: DocumentSource; onDocument: (document?: DocumentSource) => void;
}) {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [query, setQuery] = useState('');
  const [reading, setReading] = useState<LibraryDocument | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    listDocuments().then(data => { if (active) setCatalog(data.documents); })
      .catch(() => { if (active) setError('No se pudo cargar el catálogo. Comprueba el backend.'); });
    return () => { active = false; };
  }, []);
  async function open(id: string) {
    setLoading(true); setError(''); setNotice(''); setReading(null);
    try { setReading(await readDocument(id)); }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo leer el documento.'); }
    finally { setLoading(false); }
  }
  return <div className="library-panel">
    {!inside && <button className="enter-library" onClick={onEnter}>Entrar en la biblioteca →</button>}
    <nav className="library-tabs" aria-label="Panel de biblioteca">
      <button aria-pressed={tab === 'chat'} onClick={() => onTab('chat')}>Conversación</button>
      <button aria-pressed={tab === 'documents'} onClick={() => onTab('documents')}>Documentos</button>
    </nav>
    <div className="chat-slot" style={{ display: tab === 'chat' ? 'flex' : 'none' }}>
      <ChatPanel status={status} onConnected={onConnected} document={document} onDetach={() => onDocument(undefined)}/>
    </div>
    {tab === 'documents' && <section className="library-reader" aria-label="Catálogo de biblioteca">
      <DocumentImport onImported={document => {
        setCatalog(items => [...items, { id: document.id, title: document.title, kind: 'private' }]);
        setQuery(''); setReading(document); setError('');
      }}/>
      <p className="library-permissions">Lectura con Luma · {catalog.filter(item => item.kind === 'example').length} ejemplos · {catalog.filter(item => item.kind === 'private').length} documentos propios</p>
      <label htmlFor="document-search">Buscar por título</label>
      <input id="document-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar en la biblioteca…"/>
      <div className="document-list">{catalog.filter(item => item.title.toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es'))).map(item =>
        <button key={item.id} disabled={loading} aria-pressed={reading?.id === item.id} onClick={() => open(item.id)}>{item.title}<span>{item.kind === 'private' ? 'Propio' : 'Ejemplo'} ↗</span></button>)}</div>
      {catalog.length > 0 && !catalog.some(item => item.title.toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es'))) && <p>No hay títulos coincidentes.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">Leyendo documento…</p>}
      {reading && <article className="document-preview"><h3>{reading.title}</h3><small>ID: {reading.id} · versión {reading.revision.slice(0, 8)}</small><pre>{reading.content}</pre>
        {catalog.some(item => item.id === reading.id && item.kind === 'private') && <DocumentActions key={reading.id} document={reading} onRenamed={updated => {
          setReading(updated); setCatalog(items => items.map(item => item.id === updated.id ? { ...item, title: updated.title } : item));
          if (document?.id === updated.id) onDocument(updated);
          setNotice('Nombre actualizado. El contenido y el original no han cambiado.');
        }} onDeleted={() => {
          setCatalog(items => items.filter(item => item.id !== reading.id));
          if (document?.id === reading.id) onDocument(undefined);
          setReading(null); setNotice('Copia eliminada de la biblioteca. El original y las conversaciones se conservan.');
        }}/>} 
        <button className="primary" onClick={() => { onDocument(reading); onTab('chat'); }}>Consultar este documento con Luma</button>
      </article>}
    </section>}
  </div>;
}
