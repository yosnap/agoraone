import { useRef, useState } from 'react';
import { useAssistantName } from '../assistant/assistant-name';
import { createVaultNote, getHermesCatalog, listVaultNotes } from '../api/client';
import { decideInbox, type InboxItem } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { clientFolder, noteContent, noteTitle, projectsBase, withLevel } from './project-note-text';

type Vault = { id: string; name: string; folders: string[] };
const NO_PROJECT = '';

/** «Añadir a la nota del proyecto»: a client's mail becomes one new note in the client's folder of the vault.
 * The user sees and can change the folder, the title and the whole text, and nothing is written until
 * «Crear la nota»; no existing note is ever changed. The card then goes to «Hechos». */
export function ProjectNote({ item, onDone, onCancel }: { item: InboxItem; onDone: (note: string) => void; onCancel: () => void }) {
  const assistant = useAssistantName();
  const [vaults, setVaults] = useState<Vault[] | null>(null);
  const [vaultId, setVaultId] = useState('');
  const [client, setClient] = useState(item.client?.name ?? '');
  const [project, setProject] = useState(item.client?.projects[0] ?? NO_PROJECT);
  const [folder, setFolder] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [touched, setTouched] = useState({ title: false, content: false, folder: false });
  // The note already exists (only marking the card failed): trying again must not create it twice.
  const [made, setMade] = useState<{ folder: string; title: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);

  const vault = vaults?.find(v => v.id === vaultId);
  const base = vault ? projectsBase(vault.folders) : null;
  // Fills in what the user has not written by hand: folder, title and text follow the client and project.
  const suggest = (found: Vault | undefined, name: string, chosen: string, keep = touched) => {
    if (!found) return;
    const where = projectsBase(found.folders);
    const target = keep.folder ? folder : where && name.trim() ? clientFolder(found.folders, where, name.trim()).folder : where ?? '';
    setFolder(target);
    if (!keep.title) setTitle(noteTitle(target || name || 'Cliente', item.subject, item.sentAt));
    if (!keep.content) setContent(noteContent({ ...item, asks: item.details.asks }, chosen || null));
  };
  if (!asked.current) {
    asked.current = true;
    (async () => {
      const catalog = await getHermesCatalog();
      const found: Vault[] = [];
      for (const v of (catalog.vaults ?? []).filter(v => v.available)) {
        try { found.push({ id: v.id, name: v.name, folders: [...new Set((await listVaultNotes(v.id)).notes.map(n => n.folder))] }); } catch { /* an unreadable vault is left out */ }
      }
      const preferred = found.find(v => projectsBase(v.folders)) ?? found[0];
      setVaults(found);
      if (preferred) { setVaultId(preferred.id); suggest(preferred, client, project); }
    })().catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer los vaults.'));
  }

  const folderOptions = (() => {
    if (!vault) return [];
    const existing = base ? [...new Set(vault.folders.filter(f => f.startsWith(`${base}/`)).map(f => `${base}/${f.slice(base.length + 1).split('/')[0]}`))]
      : vault.folders.filter(Boolean);
    const all = folder && !existing.includes(folder) ? [folder, ...existing] : existing;
    return all.sort((a, b) => a.localeCompare(b, 'es')).map(f => ({ value: f, label: vault.folders.includes(f) || existing.includes(f) ? f : `${f} (carpeta nueva)` }));
  })();
  const create = async () => {
    if (!vault) return;
    setBusy(true); setError('');
    try {
      const note = made ?? await createVaultNote(vault.id, folder, title.trim(), withLevel(content, item.confidentiality));
      setMade(note);
      await decideInbox(item.id, 'done');
      onDone(`Nota creada en ${note.folder}: «${note.title}». La tarjeta pasa a «Hechos».`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo crear la nota.'); }
    finally { setBusy(false); }
  };

  if (vaults === null && !error) return <Loading label="Buscando la carpeta del cliente en el vault" lines={2}/>;
  if (vaults?.length === 0) return <p className="muted">No hay ningún vault de Obsidian disponible.</p>;
  return <form className="project-note" aria-label="Añadir a la nota del proyecto" onSubmit={event => { event.preventDefault(); void create(); }}>
    <div className="project-note-grid">
      {(vaults?.length ?? 0) > 1 && <label className="field">Vault<ModernSelect value={vaultId} options={(vaults ?? []).map(v => ({ value: v.id, label: v.name }))}
        onChange={value => { setVaultId(value); suggest(vaults?.find(v => v.id === value), client, project); }}/></label>}
      <label className="field">Cliente<input value={client} maxLength={80} onChange={event => { setClient(event.target.value); suggest(vault, event.target.value, project); }}/></label>
      {item.client && item.client.projects.length > 0 && <label className="field">Proyecto<ModernSelect value={project}
        options={[...item.client.projects.map(p => ({ value: p, label: p })), { value: NO_PROJECT, label: 'Sin proyecto concreto' }]}
        onChange={value => { setProject(value); if (!touched.content) setContent(noteContent({ ...item, asks: item.details.asks }, value || null)); }}/></label>}
      <label className="field">Carpeta<ModernSelect value={folder} options={folderOptions}
        onChange={value => { setFolder(value); setTouched({ ...touched, folder: true }); if (!touched.title) setTitle(noteTitle(value, item.subject, item.sentAt)); }}/></label>
    </div>
    <label className="field">Título<input value={title} maxLength={200} required onChange={event => { setTitle(event.target.value); setTouched({ ...touched, title: true }); }}/></label>
    <label className="field">Texto de la nota<textarea value={content} rows={12} onChange={event => { setContent(event.target.value); setTouched({ ...touched, content: true }); }}/></label>
    {item.confidentiality !== 'normal' && <p className="muted">El correo es {item.confidentiality === 'private' ? 'privado' : 'solo de este Mac'}: la nota se guarda marcada igual
      («confidencialidad: {item.confidentiality === 'private' ? 'privado' : 'solo-local'}»), y ni {assistant} ni ningún modelo remoto la leerán.</p>}
    {made && <p className="muted">La nota ya está creada; falta marcar la tarjeta como hecha.</p>}
    <p className="muted">Se crea una nota nueva, «{title.trim() || '…'}.md», en «{folder || '…'}»{vault && folder && !vault.folders.some(f => f === folder || f.startsWith(`${folder}/`)) ? ', que se crea con ella' : ''}. No se cambia ninguna nota que ya exista.</p>
    {error && <LoadError message={error}/>}
    <div className="inbox-actions">
      <button type="submit" className="button primary" disabled={busy || !vault || !folder || !title.trim()}>{busy ? 'Creando…' : made ? 'Marcar como hecha' : 'Crear la nota'}</button>
      <button type="button" className="button" disabled={busy} onClick={onCancel}>Cancelar</button>
    </div>
  </form>;
}
