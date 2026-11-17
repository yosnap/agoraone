import { useState } from 'react';
import { vaultName } from '../inbox/project-note-text';
import './vault-folder-browser.css';

export const parentOf = (folder: string) => folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';

/** The folder and every folder above it («A/B/C» gives A, A/B and A/B/C). */
export const withParents = (folder: string) => folder.split('/').filter(Boolean).map((_, n, parts) => parts.slice(0, n + 1).join('/'));

/** Browsing a tree of folders to pick one: into a folder, back up, or a new folder inside the one open. `planned`
 * are folders that do not exist yet but are offered (a suggestion); nothing is created here. */
export function FolderBrowser({ label, folders, planned = [], value, onChange, newAtRoot = false, maxBytes = 240, ariaLabel }: {
  label: string; folders: string[]; planned?: string[]; value: string; onChange: (folder: string) => void; newAtRoot?: boolean; maxBytes?: number; ariaLabel: string;
}) {
  const [naming, setNaming] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string[]>([]);  // new folders, made only with the note (none inside them)
  const known = [...new Set([...folders, ...planned, ...fresh])];
  const exists = value === '' || folders.includes(value);
  const children = known.filter(f => parentOf(f) === value).sort((a, b) => a.localeCompare(b, 'es'));
  const parts = value ? value.split('/') : [];
  const canCreate = (value ? exists : newAtRoot);
  const create = () => {
    const name = vaultName(naming ?? '', maxBytes);
    if (!name) return;
    // The Mac's disk does not tell «proyectos» from «Proyectos»: a sibling with the same name is that folder.
    const same = known.find(f => parentOf(f) === value && f.split('/').pop()!.normalize('NFC').toLowerCase() === name.toLowerCase());
    const folder = same ?? (value ? `${value}/${name}` : name);
    if (!same) setFresh([...fresh, folder]);
    onChange(folder);
    setNaming(null);
  };
  return <div className="folder-browser" aria-label={ariaLabel}>
    <div className="folder-path">
      <button type="button" className="folder-crumb" onClick={() => onChange('')}>{label}</button>
      {parts.map((part, n) => <span key={n}> › <button type="button" className="folder-crumb" onClick={() => onChange(parts.slice(0, n + 1).join('/'))}>{part}</button></span>)}
      {!exists && <small className="muted"> (carpeta nueva)</small>}
    </div>
    <div className="folder-children" role="list">
      {value && <button type="button" className="folder-item" onClick={() => onChange(parentOf(value))}>↑ Subir</button>}
      {children.map(folder => <button type="button" key={folder} className="folder-item" role="listitem" onClick={() => onChange(folder)}>
        <span aria-hidden="true">📁</span> {folder.split('/').pop()}{!folders.includes(folder) && <small className="muted"> (nueva)</small>} <span aria-hidden="true">›</span></button>)}
      {!children.length && <small className="muted">No hay subcarpetas aquí.</small>}
    </div>
    {canCreate && (naming === null
      ? <button type="button" className="button" onClick={() => setNaming('')}>Nueva carpeta aquí</button>
      : <span className="folder-new">
          <input value={naming} maxLength={100} placeholder="Nombre de la carpeta" aria-label="Nombre de la carpeta nueva" autoFocus
            onChange={event => setNaming(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); create(); } else if (event.key === 'Escape') setNaming(null); }}/>
          <button type="button" className="button" disabled={!naming?.trim()} onClick={create}>Crear</button>
          <button type="button" className="button" onClick={() => setNaming(null)}>Cancelar</button>
        </span>)}
    {!value && !newAtRoot && <small className="muted">Para crear una carpeta nueva, entra antes en una que ya exista.</small>}
    <small>Se guardará en: <strong>{[label, ...(parts.length ? parts : ['(raíz)'])].join(' › ')}</strong></small>
  </div>;
}
