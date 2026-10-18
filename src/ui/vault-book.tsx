import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readVaultNote, type DocumentSource, type VaultNote } from '../api/client';
import { ago } from '../data/activity-format';
import { ConsultWith, type ConsultTarget } from './consult-with';
import { HiddenLines } from './hidden-lines';
import { VaultNoteEditor } from './vault-note-editor';
import { headingsOf, Markdown } from './markdown';
import { noteFinder } from './vault-links';
import './vault-book.css';

type Note = VaultNote & { content: string; revision: string; hidden: number; revealed: boolean };

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
    setNote(null); void load(noteId, false); setSaved(false);
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
        {note && meta?.readable && !editing && <button type="button" className="book-edit" onClick={() => { setEditing(true); setSaved(false); }}>Editar nota</button>}
        {saved && !editing && <p role="status" className="book-saved">Guardada en tu vault. La versión anterior quedó en la copia de seguridad de AgoraOne.</p>}
        {note && meta && <ConsultWith what="esta nota" targets={targets} onConsult={target => onConsult({ id: note.id, title: `${vaultName} · ${meta.folder ? `${meta.folder}/` : ''}${meta.title}`, revision: note.revision }, target)}/>}
        {note && note.bytes > 24 * 1024 && <small>La consulta envía los primeros 24 KiB de la nota.</small>}
        <div className="book-turn">
          <button disabled={editing || at <= 0} onClick={() => onOpen(shelf[at - 1].id)} aria-label="Nota anterior de la carpeta">← Anterior</button>
          <span>{at + 1} / {shelf.length}</span>
          <button disabled={editing || at < 0 || at >= shelf.length - 1} onClick={() => onOpen(shelf[at + 1].id)} aria-label="Nota siguiente de la carpeta">Siguiente →</button>
        </div>
      </aside>
      <div className="book-page book-right" ref={page} tabIndex={-1}>
        <button autoFocus className="book-close" aria-label="Cerrar libro" disabled={editing} title={editing ? 'Guarda o cancela la edición para cerrar' : undefined} onClick={onClose}>×</button>
        {failure && <p className="error" role="alert">{failure}</p>}
        {!note && !failure && <p role="status">Abriendo el libro…</p>}
        {editing && note ? <VaultNoteEditor key={`${note.id}:${note.revision}:${note.revealed}:${draft !== null}`} vaultId={vaultId} note={{ ...note, title: meta?.title ?? 'nota' }} draft={draft} notes={titles}
          onCancel={() => { setEditing(false); setDraft(null); }}
          onReload={keep => { setDraft(keep); if (keep === null) setEditing(false); void load(note.id, note.revealed); }}
          onSaved={() => { setEditing(false); setDraft(null); setSaved(true); void load(note.id, note.revealed); onChanged(); }}/> : body}
      </div>
    </section>
  </dialog>;
}
