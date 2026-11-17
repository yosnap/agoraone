import { useRef, useState } from 'react';
import { useAssistantName } from '../assistant/assistant-name';
import { createVaultNote, getHermesCatalog, listVaultNotes } from '../api/client';
import { decideInbox, getCentral, type CentralClient, type InboxItem } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';
import { VaultFolderBrowser } from '../ui/vault-folder-browser';
import { noteContent, noteTitle, projectsBase, withLevel } from './project-note-text';

type Vault = { id: string; name: string; folders: string[] };
const NO_PROJECT = '';

/** «Añadir a la nota del proyecto»: a client's mail becomes one new note in the vault. The client and project
 * come from Central (the mail's own preselected), the folder is browsed to (the client's folder suggested, any
 * other reachable, a new one inside an existing one), and the user can change the title and the whole text.
 * Nothing is written until «Crear la nota»; no existing note is ever changed. The card then goes to «Hechos». */
export function ProjectNote({ item, onDone, onCancel }: { item: InboxItem; onDone: (note: string) => void; onCancel: () => void }) {
  const assistant = useAssistantName();
  const [vaults, setVaults] = useState<Vault[] | null>(null);
  const [vaultId, setVaultId] = useState('');
  const [client, setClient] = useState(item.client?.name ?? '');
  const [project, setProject] = useState(item.client?.projects[0] ?? NO_PROJECT);
  const [folder, setFolder] = useState<string | null>(null);  // null: the browser is still suggesting one
  const [browser, setBrowser] = useState(0);  // a new browser (and suggestion) when the client changes and the folder was not chosen
  const [central, setCentral] = useState<CentralClient[]>([]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [touched, setTouched] = useState({ title: false, content: false, folder: false });
  // The note already exists (only marking the card failed): trying again must not create it twice.
  const [made, setMade] = useState<{ folder: string; title: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);

  const vault = vaults?.find(v => v.id === vaultId);
  const known = central.find(c => c.name === client);
  const projects = known ? known.projects.map(p => p.name) : item.client?.projects ?? [];
  // Fills in what the user has not written by hand: the text follows the project; the folder (and with it the
  // title) follows the client until the user picks one.
  const suggest = (name: string, chosen: string) => {
    if (!touched.folder) { setFolder(null); setBrowser(n => n + 1); if (!touched.title) setTitle(noteTitle(name || 'Cliente', item.subject, item.sentAt)); }
    if (!touched.content) setContent(noteContent({ ...item, asks: item.details.asks }, chosen || null));
  };
  const pickFolder = (next: string) => {
    if (folder !== null) setTouched({ ...touched, folder: true });  // the first one is the browser's own suggestion
    setFolder(next);
    if (!touched.title) setTitle(noteTitle(next || client || 'Cliente', item.subject, item.sentAt));
  };
  if (!asked.current) {
    asked.current = true;
    void getCentral().then(found => setCentral(found.snapshot?.clients ?? [])).catch(() => undefined);  // without Central, the client is typed
    (async () => {
      const catalog = await getHermesCatalog();
      const found: Vault[] = [];
      for (const v of (catalog.vaults ?? []).filter(v => v.available)) {
        try { found.push({ id: v.id, name: v.name, folders: [...new Set((await listVaultNotes(v.id)).notes.map(n => n.folder))] }); } catch { /* an unreadable vault is left out */ }
      }
      const preferred = found.find(v => projectsBase(v.folders)) ?? found[0];
      setVaults(found);
      if (preferred) setVaultId(preferred.id);
      setContent(noteContent({ ...item, asks: item.details.asks }, project || null));
    })().catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer los vaults.'));
  }

  const clientOptions = [...new Set([...central.map(c => c.name), ...(item.client ? [item.client.name] : [])])]
    .sort((a, b) => a.localeCompare(b, 'es')).map(name => ({ value: name, label: name }));
  const chooseClient = (name: string) => {
    const next = central.find(c => c.name === name)?.projects.map(p => p.name) ?? (name === item.client?.name ? item.client.projects : []);
    const chosen = next.includes(project) ? project : next[0] ?? NO_PROJECT;
    setClient(name); setProject(chosen); suggest(name, chosen);
  };
  const create = async () => {
    if (!vault || folder === null) return;
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
        onChange={value => { setVaultId(value); setFolder(null); setTouched({ ...touched, folder: false }); }}/></label>}
      {clientOptions.length > 0
        ? <label className="field">Cliente<ModernSelect value={client} options={client && !clientOptions.some(o => o.value === client) ? [{ value: client, label: client }, ...clientOptions] : clientOptions}
            onChange={chooseClient}/></label>
        : <label className="field">Cliente<input value={client} maxLength={80} onChange={event => setClient(event.target.value)} onBlur={() => suggest(client, project)}/></label>}
      {projects.length > 0 && <label className="field">Proyecto<ModernSelect value={project}
        options={[...projects.map(p => ({ value: p, label: p })), { value: NO_PROJECT, label: 'Sin proyecto concreto' }]}
        onChange={value => { setProject(value); if (!touched.content) setContent(noteContent({ ...item, asks: item.details.asks }, value || null)); }}/></label>}
    </div>
    {vault && <div className="field"><span>Carpeta</span><VaultFolderBrowser key={`${vault.id}|${browser}`} vaultId={vault.id} vaultName={vault.name}
      client={client.trim() || null} value={folder} onChange={(from, next) => { if (from === vault.id) pickFolder(next); }}/></div>}
    <label className="field">Título<input value={title} maxLength={200} required onChange={event => { setTitle(event.target.value); setTouched({ ...touched, title: true }); }}/></label>
    <label className="field">Texto de la nota<textarea value={content} rows={12} onChange={event => { setContent(event.target.value); setTouched({ ...touched, content: true }); }}/></label>
    {item.confidentiality !== 'normal' && <p className="muted">El correo es {item.confidentiality === 'private' ? 'privado' : 'solo de este Mac'}: la nota se guarda marcada igual
      («confidencialidad: {item.confidentiality === 'private' ? 'privado' : 'solo-local'}»), y ni {assistant} ni ningún modelo remoto la leerán.</p>}
    {made && <p className="muted">La nota ya está creada; falta marcar la tarjeta como hecha.</p>}
    <p className="muted">Se crea una nota nueva, «{title.trim() || '…'}.md»{vault && folder !== null ? ` en ${[vault.name, ...(folder ? folder.split('/') : ['(raíz)'])].join(' › ')}` : ''}{vault && folder && !vault.folders.some(f => f === folder || f.startsWith(`${folder}/`)) ? ', una carpeta nueva que se crea con ella' : ''}. No se cambia ninguna nota que ya exista.</p>
    {error && <LoadError message={error}/>}
    <div className="inbox-actions">
      <button type="submit" className="button primary" disabled={busy || !vault || folder === null || !title.trim()}>{busy ? 'Creando…' : made ? 'Marcar como hecha' : 'Crear la nota'}</button>
      <button type="button" className="button" disabled={busy} onClick={onCancel}>Cancelar</button>
    </div>
  </form>;
}
