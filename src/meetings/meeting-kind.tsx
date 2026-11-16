import { useRef, useState } from 'react';
import { exportMeeting, kindLabels, updateMeeting, type MeetingClass, type MeetingDetail, type MeetingKind } from '../api/core';
import { ModernSelect } from '../ui/modern-select';

const kinds = (Object.keys(kindLabels) as MeetingKind[]).map(value => ({ value, label: kindLabels[value] }));
const failed = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;
/** «Ana, Luis Pérez» → ['Ana', 'Luis Pérez']. */
export const peopleOf = (text: string) => text.split(/[,;\n]/).map(name => name.trim()).filter(Boolean);

/** What the meeting was, the client it was about and who was in it: in the note's properties, and what Watson
 * finds it by later. */
export function KindFields({ value, onChange }: { value: { kind: MeetingKind; client: string; people: string }; onChange: (next: { kind: MeetingKind; client: string; people: string }) => void }) {
  return <div className="meeting-save-fields">
    <label className="field">Tipo<ModernSelect value={value.kind} options={kinds} onChange={kind => onChange({ ...value, kind: kind as MeetingKind })}/></label>
    <label className="field">Cliente<input value={value.client} onChange={event => onChange({ ...value, client: event.target.value })} maxLength={200} placeholder="Opcional"/></label>
    <label className="field">Con quién<input value={value.people} onChange={event => onChange({ ...value, people: event.target.value })} maxLength={1000} placeholder="Ana, Luis… (opcional)"/></label>
  </div>;
}

export const asClass = (fields: { kind: MeetingKind; client: string; people: string }): MeetingClass =>
  ({ kind: fields.kind, client: fields.client.trim() || null, people: peopleOf(fields.people) });

/** Changing the kind, client or people of a recorded meeting. The vault note and the file use the new ones. */
export function MeetingClassCard({ detail, onSaved }: { detail: MeetingDetail; onSaved: () => void }) {
  const [fields, setFields] = useState({ kind: detail.kind, client: detail.client ?? '', people: detail.people.join(', ') });
  const [state, setState] = useState<{ saving: boolean; done: string; error: string }>({ saving: false, done: '', error: '' });
  const wanted = asClass(fields);
  const same = wanted.kind === detail.kind && wanted.client === detail.client && wanted.people.join('\n') === detail.people.join('\n');
  const save = async () => {
    setState({ saving: true, done: '', error: '' });
    try { await updateMeeting(detail.id, wanted); setState({ saving: false, done: 'Guardado.', error: '' }); onSaved(); }
    catch (failure) { setState({ saving: false, done: '', error: failed(failure, 'No se pudo guardar.') }); }
  };
  return <section aria-label="Clasificación" className="meeting-save">
    <h3>Qué fue y con quién</h3>
    <KindFields value={fields} onChange={next => { setFields(next); setState({ saving: false, done: '', error: '' }); }}/>
    <span className="meeting-actions">
      <button type="button" className="button" disabled={same || state.saving} onClick={() => void save()}>{state.saving ? 'Guardando…' : 'Guardar'}</button>
      {state.done && <small className="ok-note" role="status">{state.done}</small>}
    </span>
    {state.error && <small className="dictation-error" role="alert">{state.error}</small>}
  </section>;
}

/** The whole meeting (summaries, tasks and transcript) for Claude, Codex or anyone: a Markdown file in
 * Downloads, or copied to the clipboard. */
export function MeetingExport({ detail }: { detail: MeetingDetail }) {
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const timer = useRef(0);
  const say = (text: string, error = false) => { window.clearTimeout(timer.current); setNote({ text, error }); if (!error) timer.current = window.setTimeout(() => setNote(null), 6000); };
  if (!detail.draft) return null;
  if (detail.confidentiality !== 'normal') return <section aria-label="Exportar" className="meeting-save">
    <h3>Para Claude o Codex</h3>
    <p className="muted">Esta reunión es privada o solo de este Mac: no se exporta ni se copia para un modelo de fuera.</p>
  </section>;
  const download = async () => {
    try { const made = await exportMeeting(detail.id); say(`Guardado en Descargas: ${made.name}`); }
    catch (failure) { say(failed(failure, 'No se pudo crear el archivo.'), true); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(detail.draft!.content); say('Copiado: pégalo en Claude o Codex.'); }
    catch { say('No se pudo copiar; usa «Descargar el archivo».', true); }
  };
  return <section aria-label="Exportar" className="meeting-save">
    <h3>Para Claude o Codex</h3>
    <p className="muted">Toda la reunión en un archivo Markdown: tipo, cliente, personas, resumen, resumen extendido, decisiones, tareas y la transcripción completa.</p>
    <span className="meeting-actions">
      <button type="button" className="button" onClick={() => void download()}>Descargar el archivo</button>
      <button type="button" className="button" onClick={() => void copy()}>Copiar todo</button>
    </span>
    {note && <small className={note.error ? 'dictation-error' : 'ok-note'} role={note.error ? 'alert' : 'status'}>{note.text}</small>}
  </section>;
}
