import { useRef, useState } from 'react';
import { chooseLibraryFolder, getLibrary, putLibraryFolders } from '../api/core';
import { LoadError } from '../ui/load-state';
import { isWindows } from '../ui/platform';

/** The folders of the user's own music (1.5): AgoraOne indexes them by artist, album and title and plays them in
 * its own player; it only reads them. On macOS they are picked with the system's chooser. */
export function MusicSettingsCard() {
  const [folders, setFolders] = useState<string[] | null>(null);
  const [total, setTotal] = useState(0);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const asked = useRef(false);
  const load = () => getLibrary('').then(found => { setFolders(found.folders); setTotal(found.total); }).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo leer.'));
  if (!asked.current) { asked.current = true; void load(); }
  const save = async (next: string[]) => {
    setError('');
    try { await putLibraryFolders(next); await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo guardar.'); }
  };
  const pick = async () => {
    setError('');
    try { const { path } = await chooseLibraryFolder(); if (path) await save([...(folders ?? []), path]); } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo.'); }
  };
  return <article className="card" aria-labelledby="music-title">
    <div className="card-head"><h2 id="music-title">Tu música</h2>
      {folders && <span className={`status-badge ${folders.length ? 'good' : 'paused'}`}>{folders.length ? `${total} canciones` : 'Sin carpeta'}</span>}</div>
    <p>Las carpetas con tu música (MP3, M4A, FLAC, WAV, AAC u OGG). AgoraOne las ordena por artista, álbum y título y las reproduce en el Cerebro; «pon …» busca aquí primero. Solo las lee.</p>
    {folders && <ul className="apps-list">{folders.map(folder => <li key={folder}><span title={folder}>{folder}</span>{' '}
      <button type="button" className="button" onClick={() => void save(folders.filter(f => f !== folder))}>Quitar</button></li>)}</ul>}
    <div className="field-row">
      <button type="button" className="button" onClick={() => void pick()}>Añadir una carpeta…</button>
      <form className="field-row" onSubmit={event => { event.preventDefault(); if (typed.trim()) void save([...(folders ?? []), typed.trim()]).then(() => setTyped('')); }}>
        <input value={typed} onChange={event => setTyped(event.target.value)} placeholder={isWindows ? 'o escribe la ruta: C:\\…\\Música' : 'o escribe la ruta: /ruta/a/Música'} aria-label="Ruta de una carpeta de música"/>
        <button type="submit" className="button">Añadir</button>
      </form>
    </div>
    {error && <LoadError message={error}/>}
  </article>;
}
