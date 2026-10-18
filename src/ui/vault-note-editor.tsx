import { useRef, useState } from 'react';
import { ApiError, saveVaultNote } from '../api/client';

const markers = (text: string) => text.match(/^\s*\[línea oculta \d+\]\s*$/gm)?.map(line => line.trim()) ?? [];

// Edits a real Obsidian note (user's decision, 18/10/2026). The text starts as shown in the book: with
// hidden credential-like lines as markers, which the server puts back from disk when saving. Saving asks
// for confirmation; the previous version is copied first and a change made meanwhile is never overwritten:
// the user can reload that version keeping their own text, or discard it.
export function VaultNoteEditor({ vaultId, note, draft, onSaved, onCancel, onReload }: {
  vaultId: string; note: { id: string; title: string; content: string; revision: string; revealed: boolean };
  draft: string | null; onSaved: () => void; onCancel: () => void; onReload: (keep: string | null) => void;
}) {
  const [text, setText] = useState(draft ?? note.content);
  const [step, setStep] = useState<'edit' | 'confirm' | 'discard'>('edit');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const changed = text !== note.content;
  // Hidden lines are put back by their marker: a removed marker deletes that line from the file, a repeated one copies it.
  const before = markers(note.content), after = markers(text);
  const removed = before.filter(marker => !after.includes(marker)).length;
  const repeated = after.length - new Set(after).size;
  const back = () => { setStep('edit'); setTimeout(() => area.current?.focus()); };
  async function save() {
    setSaving(true); setError('');
    try { await saveVaultNote(vaultId, note.id, { content: text, revision: note.revision, revealed: note.revealed }); onSaved(); }
    catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar la nota.');
      setConflict(e instanceof ApiError && e.status === 409); setStep('edit'); setSaving(false);
    }
  }
  return <section className="vault-editor" aria-label={`Editar ${note.title}`}>
    <label htmlFor="vault-editor-text">Texto de la nota (Markdown)</label>
    <textarea id="vault-editor-text" ref={area} value={text} onChange={event => setText(event.target.value)} disabled={saving} spellCheck/>
    {!note.revealed && before.length > 0 && <small>Las líneas «[línea oculta N]» se reponen al guardar con su texto real; si quitas una, esa línea se borra del archivo.</small>}
    {error && <p role="alert" className="error">{error}</p>}
    {conflict ? <div className="editor-actions">
      <button type="button" className="primary" onClick={() => onReload(text)}>Recargar y conservar mi texto</button>
      <button type="button" onClick={() => onReload(null)}>Descartar mi texto</button>
    </div>
      : step === 'confirm' ? <div className="editor-confirm" role="alertdialog" aria-label="Confirmar guardado">
        <p>¿Guardar los cambios en «{note.title}» en tu vault de Obsidian? Se guardará antes una copia de la versión actual.</p>
        {removed > 0 && <p className="approval-warning">Se borrarán del archivo {removed} {removed === 1 ? 'línea oculta' : 'líneas ocultas'} que parecían claves.</p>}
        {repeated > 0 && <p className="approval-warning">Hay {repeated} {repeated === 1 ? 'línea oculta repetida' : 'líneas ocultas repetidas'}: su texto real se copiará varias veces.</p>}
        <div><button type="button" className="primary" autoFocus disabled={saving} onClick={save}>{saving ? 'Guardando…' : 'Confirmar y guardar'}</button><button type="button" disabled={saving} onClick={back}>Volver</button></div>
      </div>
      : step === 'discard' ? <div className="editor-confirm" role="alertdialog" aria-label="Descartar cambios">
        <p>¿Descartar los cambios sin guardar?</p>
        <div><button type="button" autoFocus onClick={onCancel}>Descartar cambios</button><button type="button" className="primary" onClick={back}>Seguir editando</button></div>
      </div>
      : <div className="editor-actions"><button type="button" className="primary" disabled={!changed} onClick={() => setStep('confirm')}>Guardar en el vault</button><button type="button" onClick={() => changed ? setStep('discard') : onCancel()}>Cancelar</button></div>}
  </section>;
}
