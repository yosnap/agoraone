import { useRef, useState } from 'react';
import { listVaultNotes } from '../api/client';
import { clientFolder, projectsBase } from '../inbox/project-note-text';
import { FolderBrowser, withParents } from './folder-browser';

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

/** The vault's folders to pick where the note goes (the vault only creates a new folder inside an existing one).
 * Nothing is created until the note is. */
export function VaultFolderBrowser({ vaultId, vaultName: label, client, value, onChange: tell }: {
  vaultId: string; vaultName: string; client: string | null; value: string | null; onChange: (vaultId: string, folder: string) => void;
}) {
  const [folders, setFolders] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [planned, setPlanned] = useState<string[]>([]);  // the suggested folder when it does not exist yet
  const asked = useRef('');
  // Every choice says which vault it is for: the parent drops one that arrives late from another vault.
  const onChange = (folder: string) => tell(vaultId, folder);
  if (asked.current !== vaultId) {
    asked.current = vaultId;
    setFolders(null); setError(''); setPlanned([]);
    void listVaultNotes(vaultId).then(listing => {
      if (asked.current !== vaultId) return;
      const found = allFolders(listing.notes.map(note => note.folder));
      setFolders(found);
      if (value === null) {
        const first = suggested(found, client);
        if (first && !found.includes(first)) setPlanned(withParents(first));  // the client's new folder stays reachable while browsing
        onChange(first);
      }
    }).catch(failure => { if (asked.current === vaultId) setError(failure instanceof Error ? failure.message : 'No se pudieron leer las carpetas del vault.'); });
  }
  if (error) return <p className="dictation-error" role="alert">{error} <button type="button" className="button" onClick={() => { asked.current = ''; setError(''); }}>Reintentar</button></p>;
  if (!folders || value === null) return <p className="muted">Leyendo las carpetas del vault…</p>;
  return <FolderBrowser label={label} folders={folders} planned={planned} value={value} onChange={onChange} ariaLabel="Carpeta del vault"/>;
}
