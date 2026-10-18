import { useEffect, useMemo, useRef, useState } from 'react';
import { searchVault, type VaultListing, type VaultNote } from '../api/client';
import './library.css';

const inside = (folder: string, path: string) => !path || folder === path || folder.startsWith(`${path}/`);
const byTitle = (a: VaultNote, b: VaultNote) => a.title.localeCompare(b.title, 'es');

// Notes of a registered Obsidian vault, browsed like a library: folders and subfolders as shelves,
// notes as books that open in the book reader. Read-only; a note reaches the model only when the
// user picks «Consultar con…» in the book and then sends a message.
export function VaultPanel({ vaultId, listing, error, inside: inRoom, onEnter, folder, onFolder, onRead, reading }: {
  vaultId: string; listing: VaultListing | null; error: string; inside: boolean; onEnter: () => void;
  folder: string | null; onFolder: (folder: string | null) => void; onRead: (id: string) => void; reading: string | null;
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ id: string; title: string; folder: string; snippet: string }[] | null>(null);
  const [searched, setSearched] = useState('');
  const [status, setStatus] = useState('');
  const [failure, setFailure] = useState('');
  // Only the latest search may update the panel; slower earlier answers are dropped.
  const latest = useRef(0);
  useEffect(() => { setFound(null); setFailure(''); }, [vaultId]);
  const path = folder ?? '';
  const all = listing?.notes ?? [];
  // Direct subfolders of the current folder, each with the number of notes it holds at any depth.
  const shelves = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of all) {
      if (!inside(note.folder, path) || note.folder === path) continue;
      const rest = path ? note.folder.slice(path.length + 1) : note.folder;
      const name = rest.split('/')[0];
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => a[0].localeCompare(b[0], 'es'));
  }, [all, path]);
  const titleQuery = query.trim().toLocaleLowerCase('es');
  const books = titleQuery
    ? all.filter(note => inside(note.folder, path) && `${note.folder} ${note.title}`.toLocaleLowerCase('es').includes(titleQuery)).sort(byTitle)
    : all.filter(note => note.folder === path).sort(byTitle);
  const crumbs = path ? path.split('/') : [];
  const go = (depth: number) => { onFolder(depth < 0 ? null : crumbs.slice(0, depth + 1).join('/')); setFound(null); };
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
  const foundHere = found?.filter(item => inside(item.folder, path)) ?? [];
  return <div className="library-panel vault-panel">
    {!inRoom && <button className="enter-library" onClick={onEnter}>Entrar en el vault →</button>}
    <p className="notice">Solo lectura. Las notas se leen en tu equipo; una nota solo se envía al modelo si eliges consultarla y envías un mensaje. No se leen carpetas ocultas, adjuntos ni enlaces a otras carpetas.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {!listing && !error && <p role="status">Leyendo el vault…</p>}
    {listing && <section className="library-reader" aria-label={`Notas de ${listing.vault.name}`}>
      <p className="library-permissions">{all.length} notas · {new Set(all.map(note => note.folder).filter(Boolean)).size} carpetas{listing.truncated ? ' · listado limitado' : ''}</p>
      <nav className="vault-crumbs" aria-label="Carpeta actual">
        <button aria-current={!crumbs.length ? 'location' : undefined} onClick={() => go(-1)}>{listing.vault.name}</button>
        {crumbs.map((name, depth) => <span key={depth}>›<button aria-current={depth === crumbs.length - 1 ? 'location' : undefined} onClick={() => go(depth)}>{name}</button></span>)}
      </nav>
      <label htmlFor="vault-search">Buscar</label>
      <form className="vault-search" onSubmit={event => { event.preventDefault(); void search(); }}>
        <input id="vault-search" value={query} onChange={event => { setQuery(event.target.value); setFound(null); latest.current++; }} placeholder={path ? `Título o texto en ${crumbs.at(-1)}…` : 'Título o texto…'}/>
        <button type="submit">Buscar en el contenido</button>
      </form>
      {status && <p role="status">{status}</p>}
      {failure && <p className="error" role="alert">{failure}</p>}
      {found ? <div className="document-list">{foundHere.map(item => <button key={item.id} aria-pressed={reading === item.id} onClick={() => onRead(item.id)}>{item.title}<span>{item.folder || 'Notas sueltas'}</span>{item.snippet && <small>{item.snippet}</small>}</button>)}
        {!foundHere.length && <p>No hay notas que contengan «{searched}»{path ? ' en esta carpeta' : ''}.</p>}</div>
        : <>
          {!titleQuery && shelves.length > 0 && <div className="vault-shelves" aria-label="Carpetas">{shelves.map(([name, count]) =>
            <button key={name} onClick={() => onFolder(path ? `${path}/${name}` : name)}><span aria-hidden="true">▤</span><strong>{name}</strong><small>{count} {count === 1 ? 'nota' : 'notas'}</small></button>)}</div>}
          <div className="document-list vault-books" aria-label="Notas">{books.slice(0, 200).map(note => <button key={note.id} aria-pressed={reading === note.id} disabled={!note.readable} onClick={() => onRead(note.id)}>
            {note.title}<span>{titleQuery ? note.folder || 'Notas sueltas' : ''}{!note.readable && ' · demasiado grande para abrir'}</span></button>)}
            {!books.length && <p>{titleQuery ? 'No hay títulos coincidentes en esta carpeta.' : shelves.length ? '' : 'Esta carpeta no tiene notas.'}</p>}
            {books.length > 200 && <p>Se muestran 200 de {books.length}; afina la búsqueda.</p>}</div>
        </>}
    </section>}
  </div>;
}
