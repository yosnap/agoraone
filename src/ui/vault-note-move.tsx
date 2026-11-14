import { useMemo, useState } from 'react';
import { ApiError, moveVaultNote, type VaultNote } from '../api/client';
import { ModernSelect, type ModernSelectOption } from './modern-select';
import { folderColor, folderTree, type FolderNode } from './vault-folders';

// Moves a real Obsidian note to another folder and/or renames it (user's decision, 13/11/2026). Nothing
// changes until the user confirms; the server copies the note first, checks it is still the version shown
// and never overwrites another note. Links to it from other notes are not rewritten.
export function VaultNoteMove({ vaultId, vaultName, note, notes, onMoved, onCancel, onReload }: {
  vaultId: string; vaultName: string; note: { id: string; title: string; folder: string; revision: string };
  notes: VaultNote[]; onMoved: (id: string) => void; onCancel: () => void; onReload: () => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [folder, setFolder] = useState(note.folder);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  // Folders that hold notes at any depth (the ones the server accepts), indented like the vault's tree.
  const options = useMemo(() => {
    const list: ModernSelectOption[] = [{ value: '', label: `${vaultName} (raíz)` }];
    const walk = (nodes: FolderNode[], depth: number) => nodes.forEach(node => {
      list.push({ value: node.path, label: node.path.split('/').join(' › '), render: <span style={{ paddingLeft: depth * 14 }}>
        <span className="vault-tree-dot" style={{ background: folderColor(node.path) }} aria-hidden="true"/> {node.name}</span> });
      walk(node.children, depth + 1);
    });
    walk(folderTree(notes), 0);
    return list;
  }, [notes, vaultName]);
  const name = title.trim();
  const changed = name !== '' && (name !== note.title || folder !== note.folder);
  const where = (path: string) => path ? path.split('/').join(' › ') : `la raíz de ${vaultName}`;
  async function move() {
    setBusy(true); setError('');
    try { const moved = await moveVaultNote(vaultId, note.id, { folder, title: name, revision: note.revision }); onMoved(moved.id); }
    catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo mover la nota.');
      setStale(e instanceof ApiError && e.status === 409 && /cambió/.test(e.message));
      setConfirming(false); setBusy(false);
    }
  }
  return <section className="vault-move" aria-label={`Mover o renombrar ${note.title}`}>
    <label htmlFor="vault-move-title">Título</label>
    <input id="vault-move-title" autoFocus maxLength={120} value={title} disabled={busy || confirming} onChange={event => setTitle(event.target.value)}/>
    <label htmlFor="vault-move-folder">Carpeta</label>
    <ModernSelect id="vault-move-folder" value={folder} onChange={setFolder} options={options} disabled={busy || confirming}/>
    <small>Los enlaces [[…]] de otras notas a esta no se actualizan; Obsidian los marcará como rotos si cambias el título.</small>
    {error && <p role="alert" className="error">{error}</p>}
    {stale ? <div className="editor-actions"><button type="button" className="primary" onClick={onReload}>Recargar la nota</button><button type="button" onClick={onCancel}>Cancelar</button></div>
      : confirming ? <div className="editor-confirm" role="alertdialog" aria-label="Confirmar el cambio">
        <p>¿{folder !== note.folder ? `Mover «${note.title}» de ${where(note.folder)} a ${where(folder)}` : `Renombrar «${note.title}»`}{name !== note.title ? `${folder !== note.folder ? ' y llamarla' : ' a'} «${name}»` : ''}? Se guardará antes una copia de la nota.</p>
        <div><button type="button" className="primary" autoFocus disabled={busy} onClick={move}>{busy ? 'Moviendo…' : 'Confirmar'}</button><button type="button" disabled={busy} onClick={() => setConfirming(false)}>Volver</button></div>
      </div>
      : <div className="editor-actions"><button type="button" className="primary" disabled={!changed} onClick={() => setConfirming(true)}>Revisar el cambio</button><button type="button" onClick={onCancel}>Cancelar</button></div>}
  </section>;
}
