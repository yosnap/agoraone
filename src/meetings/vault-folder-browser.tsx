import { useRef, useState } from 'react';
import { listVaultNotes } from '../api/client';
import { clientFolder, projectsBase, vaultName } from '../inbox/project-note-text';

const parentOf = (folder: string) => folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';

/** Every folder of the vault, the ancestors of the notes' folders included («A/B/C» gives A, A/B and A/B/C). */
function allFolders(noteFolders: string[]): string[] {
  const all = new Set<string>();
  for (const folder of noteFolders) {
    const parts = folder.split('/').filter(Boolean);
    parts.forEach((_, n) => all.add(parts.slice(0, n + 1).join('/')));
  }
  return [...all];
}

/** Where a meeting's note goes first: the client's folder (under the clients' «Proyectos»), else a folder named
 * «Reuniones», else the vault's top level. */
function suggested(folders: string[], client: string | null): string {
  const base = projectsBase(folders);
  if (client && base) return clientFolder(folders, base, client).folder;
  return folders.filter(f => f.split('/').pop()?.toLowerCase() === 'reuniones').sort((a, b) => a.length - b.length)[0] ?? '';
}

/** Browsing the vault's folders to pick where the note goes: into a folder, back up, or a new folder inside the
 * one open (the vault only creates a new folder inside an existing one). Nothing is created until the note is. */
export function VaultFolderBrowser({ vaultId, vaultName: label, client, value, onChange: tell }: {
  vaultId: string; vaultName: string; client: string | null; value: string | null; onChange: (vaultId: string, folder: string) => void;
}) {
  const [folders, setFolders] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [naming, setNaming] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string[]>([]);  // new folders, made only with the note (none inside them)
  const asked = useRef('');
  // Every choice says which vault it is for: the parent drops one that arrives late from another vault.
  const onChange = (folder: string) => tell(vaultId, folder);
  if (asked.current !== vaultId) {
    asked.current = vaultId;
    setFolders(null); setError(''); setFresh([]);
    void listVaultNotes(vaultId).then(listing => {
      if (asked.current !== vaultId) return;
      const found = allFolders(listing.notes.map(note => note.folder));
      setFolders(found);
      if (value === null) {
        const first = suggested(found, client);
        if (first && !found.includes(first)) setFresh([first]);  // the client's new folder stays reachable while browsing
        onChange(first);
      }
    }).catch(failure => { if (asked.current === vaultId) setError(failure instanceof Error ? failure.message : 'No se pudieron leer las carpetas del vault.'); });
  }
  if (error) return <p className="dictation-error" role="alert">{error} <button type="button" className="button" onClick={() => { asked.current = ''; setError(''); }}>Reintentar</button></p>;
  if (!folders || value === null) return <p className="muted">Leyendo las carpetas del vault…</p>;
  const exists = value === '' || (folders.includes(value) && !fresh.includes(value));
  const children = [...folders, ...fresh].filter(f => parentOf(f) === value).sort((a, b) => a.localeCompare(b, 'es'));
  const parts = value ? value.split('/') : [];
  const create = () => {
    const name = vaultName(naming ?? '');
    if (!name) return;
    // The Mac's disk does not tell «proyectos» from «Proyectos»: a sibling with the same name is that folder.
    const same = [...folders, ...fresh].find(f => parentOf(f) === value && f.split('/').pop()!.normalize('NFC').toLowerCase() === name.toLowerCase());
    const folder = same ?? `${value}/${name}`;
    if (!same) setFresh([...fresh, folder]);
    onChange(folder);
    setNaming(null);
  };
  return <div className="folder-browser" aria-label="Carpeta del vault">
    <div className="folder-path">
      <button type="button" className="folder-crumb" onClick={() => onChange('')}>{label}</button>
      {parts.map((part, n) => <span key={n}> › <button type="button" className="folder-crumb" onClick={() => onChange(parts.slice(0, n + 1).join('/'))}>{part}</button></span>)}
      {!exists && <small className="muted"> (carpeta nueva)</small>}
    </div>
    <div className="folder-children" role="list">
      {value && <button type="button" className="folder-item" onClick={() => onChange(parentOf(value))}>↑ Subir</button>}
      {children.map(folder => <button type="button" key={folder} className="folder-item" role="listitem" onClick={() => onChange(folder)}>
        <span aria-hidden="true">📁</span> {folder.split('/').pop()} <span aria-hidden="true">›</span></button>)}
      {!children.length && <small className="muted">No hay subcarpetas aquí.</small>}
    </div>
    {value && exists && (naming === null
      ? <button type="button" className="button" onClick={() => setNaming('')}>Nueva carpeta aquí</button>
      : <span className="meeting-actions">
          <input value={naming} maxLength={100} placeholder="Nombre de la carpeta" aria-label="Nombre de la carpeta nueva" autoFocus
            onChange={event => setNaming(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); create(); } else if (event.key === 'Escape') setNaming(null); }}/>
          <button type="button" className="button" disabled={!naming?.trim()} onClick={create}>Crear</button>
          <button type="button" className="button" onClick={() => setNaming(null)}>Cancelar</button>
        </span>)}
    {!value && <small className="muted">Para crear una carpeta nueva, entra antes en una que ya exista.</small>}
    <small>Se guardará en: <strong>{value ? `${label} › ${parts.join(' › ')}` : `${label} (raíz)`}</strong></small>
  </div>;
}
