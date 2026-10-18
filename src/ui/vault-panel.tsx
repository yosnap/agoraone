import { useEffect, useMemo, useRef, useState } from 'react';
import { readVaultNote, searchVault, type DocumentSource, type VaultListing } from '../api/client';
import { ago } from '../data/activity-format';
import { ConsultWith, type ConsultTarget } from './consult-with';
import './library.css';

type Note = VaultListing['notes'][number] & { content: string; revision: string };

// Notes of a registered Obsidian vault: read-only. Reading stays local; a note reaches the
// model only when the user picks "Consultar con…" (Luma or a profile) and then sends a message.
export function VaultPanel({ vaultId, listing, error, inside, onEnter, folder, onFolder, targets, onConsult }: {
  vaultId: string; listing: VaultListing | null; error: string; inside: boolean; onEnter: () => void;
  folder: string | null; onFolder: (folder: string | null) => void; targets: ConsultTarget[]; onConsult: (document: DocumentSource, target: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ id: string; title: string; folder: string; snippet: string }[] | null>(null);
  const [searched, setSearched] = useState('');
  const [reading, setReading] = useState<Note | null>(null);
  const [status, setStatus] = useState('');
  const [failure, setFailure] = useState('');
  // Only the latest read or search may update the panel; slower earlier answers are dropped.
  const latest = useRef(0);
  useEffect(() => { setFound(null); setReading(null); setFailure(''); }, [vaultId]);
  const folders = useMemo(() => [...new Set(listing?.notes.map(note => note.folder.split('/')[0]) ?? [])].sort((a, b) => a.localeCompare(b, 'es')), [listing]);
  const titleMatch = (text: string) => text.toLocaleLowerCase('es').includes(query.trim().toLocaleLowerCase('es'));
  const notes = (listing?.notes ?? []).filter(note => (folder === null || note.folder.split('/')[0] === folder) && titleMatch(`${note.folder} ${note.title}`));
  async function open(id: string) {
    const turn = ++latest.current;
    setStatus('Leyendo nota…'); setFailure('');
    try { const note = await readVaultNote(vaultId, id); if (turn === latest.current) { setReading(note); setStatus(''); } }
    catch (e) { if (turn === latest.current) { setStatus(''); setFailure(e instanceof Error ? e.message : 'No se pudo leer la nota.'); } }
  }
  async function search() {
    if (query.trim().length < 2) return setFailure('Escribe al menos 2 caracteres para buscar en el contenido.');
    const turn = ++latest.current, asked = query.trim();
    setStatus('Buscando en el contenido…'); setFailure('');
    try {
      const data = await searchVault(vaultId, asked);
      if (turn !== latest.current) return;
      setFound(data.results); setSearched(asked); setStatus(data.truncated ? 'Resultados limitados: afina la búsqueda.' : '');
    } catch (e) { if (turn === latest.current) { setStatus(''); setFailure(e instanceof Error ? e.message : 'No se pudo buscar.'); } }
  }
  return <div className="library-panel vault-panel">
    {!inside && <button className="enter-library" onClick={onEnter}>Entrar en el vault →</button>}
    <p className="notice">Solo lectura. Las notas se leen en tu equipo; una nota solo se envía al modelo si eliges consultarla y envías un mensaje. No se leen carpetas ocultas, adjuntos ni enlaces a otras carpetas.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {!listing && !error && <p role="status">Leyendo el vault…</p>}
    {listing && <section className="library-reader" aria-label={`Notas de ${listing.vault.name}`}>
      <p className="library-permissions">{listing.notes.length} notas · {folders.filter(Boolean).length} carpetas{listing.truncated ? ' · listado limitado' : ''}</p>
      <label htmlFor="vault-folder">Carpeta</label>
      <select id="vault-folder" value={folder ?? '*'} onChange={event => onFolder(event.target.value === '*' ? null : event.target.value)}>
        <option value="*">Todas</option>{folders.map(name => <option key={name} value={name}>{name || 'Notas sueltas'}</option>)}
      </select>
      <label htmlFor="vault-search">Buscar</label>
      <form className="vault-search" onSubmit={event => { event.preventDefault(); void search(); }}>
        <input id="vault-search" value={query} onChange={event => { setQuery(event.target.value); setFound(null); latest.current++; }} placeholder="Título o texto…"/>
        <button type="submit">Buscar en el contenido</button>
      </form>
      {found ? <div className="document-list">{found.filter(item => folder === null || item.folder.split('/')[0] === folder).map(item => <button key={item.id} aria-pressed={reading?.id === item.id} onClick={() => open(item.id)}>{item.title}<span>{item.folder || 'Notas sueltas'}</span>{item.snippet && <small>{item.snippet}</small>}</button>)}
        {!found.some(item => folder === null || item.folder.split('/')[0] === folder) && <p>No hay notas que contengan «{searched}»{folder !== null ? ' en esta carpeta' : ''}.</p>}</div>
        : <div className="document-list">{notes.slice(0, 200).map(note => <button key={note.id} aria-pressed={reading?.id === note.id} onClick={() => open(note.id)}>{note.title}<span>{note.folder || 'Notas sueltas'}{!note.readable && ' · demasiado grande para abrir'}</span></button>)}
          {!notes.length && <p>No hay títulos coincidentes en esta carpeta.</p>}
          {notes.length > 200 && <p>Se muestran 200 de {notes.length}; afina la búsqueda.</p>}</div>}
      {status && <p role="status">{status}</p>}
      {failure && <p className="error" role="alert">{failure}</p>}
      {reading && <article className="document-preview"><h3>{reading.title}</h3>
        <small>{reading.folder || 'Notas sueltas'} · {reading.bytes} bytes · modificada {ago(reading.modifiedAt)}</small><pre>{reading.content}</pre>
        <ConsultWith what="esta nota" targets={targets} onConsult={target => onConsult({ id: reading.id, title: `${listing.vault.name} · ${reading.folder ? `${reading.folder}/` : ''}${reading.title}`, revision: reading.revision }, target)}/>
        {reading.bytes > 24 * 1024 && <small>La consulta envía los primeros 24 KiB de la nota.</small>}
      </article>}
    </section>}
  </div>;
}
