import { useRef, useState } from 'react';
import { getRepoFolders, type RepoFolders } from '../api/core';
import { FolderBrowser, withParents } from '../ui/folder-browser';
import { ActionButton } from '../ui/action-button';

/** The folders of the project's local copy (the one Orca uses) to choose where a note to act on goes; the
 * suggested folder (`docs/notas`) is offered even when it does not exist yet. A public repository is warned of. */
export function RepoFolderPicker({ client, project, value, onChange }: {
  client: string; project: string; value: string | null; onChange: (client: string, project: string, folder: string) => void;
}) {
  const [place, setPlace] = useState<RepoFolders | null>(null);
  const [error, setError] = useState('');
  const asked = useRef('');
  const key = JSON.stringify([client, project]);
  if (asked.current !== key) {
    asked.current = key;
    setPlace(null); setError('');
    void getRepoFolders(client, project).then(found => {
      if (asked.current !== key) return;
      setPlace(found);
      if (value === null) onChange(client, project, found.suggested);  // the parent drops it if the project changed meanwhile
    }).catch(failure => { if (asked.current === key) setError(failure instanceof Error ? failure.message : 'No se pudo leer el repositorio.'); });
  }
  if (error) return <p className="dictation-error" role="alert">{error} <ActionButton icon="refresh" label="Reintentar" onClick={() => { asked.current = ''; setError(''); }}/></p>;
  if (!place || value === null) return <p className="muted">Leyendo las carpetas del repositorio…</p>;
  return <>
    <FolderBrowser label={place.repo} folders={place.folders} planned={place.folders.includes(place.suggested) ? [] : withParents(place.suggested)}
      value={value} onChange={folder => onChange(client, project, folder)} newAtRoot maxBytes={120} ariaLabel="Carpeta del repositorio"/>
    <small className="muted">Copia local: {place.root}</small>
    {place.visibility === 'public' && <p className="fiscal-warning" role="note">Este repositorio es público: si haces commit de la nota, cualquiera podrá leerla.</p>}
  </>;
}
