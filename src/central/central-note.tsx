import { useState } from 'react';
import { ChangeReview, useCentralChange } from './central-change';

const MAX = 5000;

/** A new note on a client or a project of Central: the text is shown as it will be saved, and only «Guardar en
 * Central» creates it. Notes are never changed nor deleted from AgoraOne. */
export function CentralNote({ target, id, onDone, onCancel }: { target: 'cliente' | 'proyecto'; id: string; onDone: (said: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  const change = useCentralChange(onDone);
  if (change.preview || change.conflict) return <ChangeReview change={change} onCancel={() => { change.reset(); onCancel(); }} onReview={change.reset}/>;
  return <form className="central-edit" onSubmit={event => { event.preventDefault(); void change.ask({ kind: 'nota', target, id, body: text }); }}>
    <label className="field">Nota nueva<textarea value={text} maxLength={MAX} rows={4} onChange={event => setText(event.target.value)}/></label>
    <small className="muted">{text.length} de {MAX} caracteres</small>
    {change.error && <p className="error" role="alert">{change.error}</p>}
    <div className="actions central-actions">
      <button type="button" className="button" onClick={onCancel}>Cancelar</button>
      <button type="submit" className="button primary" disabled={!text.trim() || change.busy}>{change.busy ? 'Preparando…' : 'Revisar la nota'}</button>
    </div>
  </form>;
}
