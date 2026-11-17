import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readVaultNote, type DocumentSource, type VaultNote } from '../api/client';
import { ago } from '../data/activity-format';
import { ConsultWith, type ConsultTarget } from './consult-with';
import { HiddenLines } from './hidden-lines';
import { VaultNoteEditor } from './vault-note-editor';
import { VaultNoteMove } from './vault-note-move';
import { headingsOf, Markdown } from './markdown';
import { noteFinder } from './vault-links';
import { OrcaLaunch } from '../orca/orca-launch';
import { useOrcaProjects } from '../orca/orca-projects';
import './vault-book.css';

type Note = VaultNote & { content: string; revision: string; hidden: number; revealed: boolean };
/** A note that declares any level but normal in its properties does not offer Orca, as the core reads it (an
 * unknown value counts as private); folder rules and the rest are checked by the core. */
const DECLARED = /^\s*["']?(?:confidencialidad|confidentiality)["']?\s*:\s*["']?([^"'\n#]*)/gim;
const keptHere = (content: string) => [...(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? '').matchAll(DECLARED)]
  .some(found => !['normal', 'publico', 'público'].includes(found[1].trim().toLowerCase()));

// An opened note shown as a book: index and actions on the left page, the formatted note on the
// right, or the editor when editing; the note only reaches a model through «Consultar con…» and a sent message.
export function VaultBook({ vaultId, vaultName, noteId, notes, onOpen, onClose, targets, onConsult, onChanged, startEditing = false }: {
  vaultId: string; vaultName: string; noteId: string; notes: VaultNote[]; onOpen: (id: string) => void; onClose: () => void;
  targets: ConsultTarget[]; onConsult: (document: DocumentSource, target: string) => void;
  onChanged: () => void; startEditing?: boolean;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [failure, setFailure] = useState('');
  const [editing, setEditing] = useState(startEditing);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  // The note the Orca card was opened for: editing, moving or going to another note closes it.
  const [orcaFor, setOrcaFor] = useState<string | null>(null);
  const orcaProjects = useOrcaProjects();
  // The id a note got after being moved or renamed: its book then says so.
  const [movedTo, setMovedTo] = useState<string | null>(null);
  const latest = useRef(0);
  const page = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const pressed = useRef<EventTarget | null>(null);
  async function load(id: string, reveal: boolean) {
    const turn = ++latest.current;
    setFailure('');
    try { const data = await readVaultNote(vaultId, id, reveal); if (turn === latest.current) setNote({ ...data, revealed: reveal }); }
    catch (e) { if (turn === latest.current) { setNote(null); setFailure(e instanceof Error ? e.message : 'No se pudo leer la nota.'); } }
  }
  // A new note starts at the top and takes the focus; revealing hidden lines keeps the reading position.
  const first = useRef(true);
  useEffect(() => {
    setNote(null); void load(noteId, false); setSaved(false); setOrcaFor(null);
    page.current?.scrollTo(0, 0);
    if (!first.current) page.current?.focus();
    first.current = false;
  }, [vaultId, noteId]);
  // A native modal dialog traps the focus, makes the rest inert and closes with Escape; the focus
  // returns to whatever opened the book.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => opener?.focus?.();
  }, []);
  const meta = notes.find(item => item.id === noteId);
  const shelf = useMemo(() => notes.filter(item => item.folder === meta?.folder).sort((a, b) => a.title.localeCompare(b.title, 'es')), [notes, meta?.folder]);
  const at = shelf.findIndex(item => item.id === noteId);
  const headings = useMemo(() => note ? headingsOf(note.content) : [], [note]);
  const find = useMemo(() => noteFinder(notes), [notes]);
  const titles = useMemo(() => [...new Set(notes.map(item => item.title))].sort((a, b) => a.localeCompare(b, 'es')), [notes]);
  const resolve = useCallback((target: string) => {
    const found = find(target, meta?.folder);
    return found ? () => onOpen(found.id) : null;
  }, [find, meta?.folder, onOpen]);
  // Parsing a large note is the costly part: it reruns only when the note or its links change.
  const body = useMemo(() => note && (note.content.trim() ? <Markdown source={note.content} resolve={resolve}/> : <p className="book-empty">Esta nota está vacía.</p>), [note, resolve]);
  const folder = meta?.folder ? meta.folder.split('/').join(' › ') : 'Notas sueltas';
  // Only a press that starts and ends on the backdrop closes the book, so selecting text never does.
  return <dialog ref={dialog} className="vault-book-backdrop" aria-label={`Libro: ${meta?.title ?? 'nota'}`}
    onCancel={event => { event.preventDefault(); if (!editing) onClose(); }}
    // Chrome closes a modal on a second Escape even if «cancel» was prevented: never while editing, and
    // a dialog closed anyway reopens (editing) or closes the book (reading).
    onKeyDown={event => { if (event.key === 'Escape' && editing) event.preventDefault(); }}
    onClose={() => { if (editing) dialog.current?.showModal(); else onClose(); }}
    onPointerDown={event => { pressed.current = event.target; }}
    onClick={event => { if (!editing && event.target === dialog.current && pressed.current === dialog.current) onClose(); }}>
    <section className="vault-book">
      <aside className="book-page book-left">
        <div className="book-eyebrow">{vaultName} · {folder}</div>
        <h2>{meta?.title ?? 'Nota'}</h2>
        {note && <small>{note.bytes} bytes · modificada {ago(note.modifiedAt)}</small>}
        {headings.length > 1 && <nav className="book-index" aria-label="Índice de la nota">
          <strong>Índice</strong>
          {headings.slice(0, 40).map(item => <button key={item.anchor} style={{ paddingLeft: `${(item.level - 1) * 10}px` }}
            onClick={() => page.current?.querySelector(`#${CSS.escape(item.anchor)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{item.text}</button>)}
        </nav>}
        {note && <HiddenLines count={note.hidden} revealed={note.revealed} disabled={editing} onToggle={() => load(note.id, !note.revealed)}/>}
        {note && meta?.readable && !editing && !moving && <div className="book-actions">
          <button type="button" className="book-edit" onClick={() => { setEditing(true); setSaved(false); setMovedTo(null); setOrcaFor(null); }}>Editar nota</button>
          <button type="button" className="book-edit" onClick={() => { setMoving(true); setSaved(false); setMovedTo(null); setOrcaFor(null); }}>Mover o renombrar</button>
          {orcaProjects.length > 0 && !keptHere(note.content) && <button type="button" className="book-edit" disabled={orcaFor === noteId}
            onClick={() => setOrcaFor(noteId)}>Llevar a Orca…</button>}
        </div>}
        {saved && !editing && <p role="status" className="book-saved">Guardada en tu vault. La versión anterior quedó en la copia de seguridad de AgoraOne.</p>}
        {movedTo === noteId && !moving && <p role="status" className="book-saved">Movida o renombrada en tu vault. Antes se guardó una copia en AgoraOne.</p>}
        {note && meta && <ConsultWith what="esta nota" targets={targets} onConsult={target => onConsult({ id: note.id, title: `${vaultName} · ${meta.folder ? `${meta.folder}/` : ''}${meta.title}`, revision: note.revision }, target)}/>}
        {note && note.bytes > 24 * 1024 && <small>La consulta envía los primeros 24 KiB de la nota.</small>}
        <div className="book-turn">
          <button disabled={editing || moving || at <= 0} onClick={() => onOpen(shelf[at - 1].id)} aria-label="Nota anterior de la carpeta">← Anterior</button>
          <span>{at + 1} / {shelf.length}</span>
          <button disabled={editing || moving || at < 0 || at >= shelf.length - 1} onClick={() => onOpen(shelf[at + 1].id)} aria-label="Nota siguiente de la carpeta">Siguiente →</button>
        </div>
      </aside>
      <div className="book-page book-right" ref={page} tabIndex={-1}>
        <button autoFocus className="book-close" aria-label="Cerrar libro" disabled={editing} title={editing ? 'Guarda o cancela la edición para cerrar' : undefined} onClick={onClose}>×</button>
        {failure && <p className="error" role="alert">{failure}</p>}
        {!note && !failure && <p role="status">Abriendo el libro…</p>}
        {moving && note && meta ? <VaultNoteMove vaultId={vaultId} vaultName={vaultName} note={{ id: note.id, title: meta.title, folder: meta.folder, revision: note.revision }} notes={notes}
          onCancel={() => setMoving(false)} onReload={() => { setMoving(false); void load(note.id, note.revealed); }}
          onMoved={id => { setMoving(false); setMovedTo(id); onChanged(); onOpen(id); }}/>
          : editing && note ? <VaultNoteEditor key={`${note.id}:${note.revision}:${note.revealed}:${draft !== null}`} vaultId={vaultId} note={{ ...note, title: meta?.title ?? 'nota' }} draft={draft} notes={titles}
          onCancel={() => { setEditing(false); setDraft(null); }}
          onReload={keep => { setDraft(keep); if (keep === null) setEditing(false); void load(note.id, note.revealed); }}
          onSaved={() => { setEditing(false); setDraft(null); setSaved(true); void load(note.id, note.revealed); onChanged(); }}/>
          : orcaFor === noteId && note ? <OrcaLaunch choices={orcaProjects} source={{ kind: 'note', source: vaultId, ref: note.id, revision: `${note.modifiedAt}|${note.bytes}` }}
            task="Lee la nota que va debajo y haz en este repositorio lo que plantea. Antes de cambiar nada, explica tu plan." onClose={() => setOrcaFor(null)}/> : body}
      </div>
    </section>
  </dialog>;
}
