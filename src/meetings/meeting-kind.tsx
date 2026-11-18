import { useRef, useState } from 'react';
import { exportMeeting, kindLabels, updateMeeting, type MeetingClass, type MeetingDetail, type MeetingKind, type MeetingPerson } from '../api/core';
import { PeopleField } from './people-field';
import { ModernSelect } from '../ui/modern-select';
import { useClients } from '../data/clients-store';
import { ActionButton } from '../ui/action-button';
import { hereLabel } from '../ui/platform';

const kinds = (Object.keys(kindLabels) as MeetingKind[]).map(value => ({ value, label: kindLabels[value] }));
const failed = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;

/** What the meeting was, the client it was about (one of the user's) and who was in it: in the note's
 * properties, and what Watson finds it by later. */
export type Fields = { kind: MeetingKind; client: string; project: string; people: MeetingPerson[] };
export const emptyFields: Fields = { kind: 'meeting', client: '', project: '', people: [] };
export function KindFields({ value, onChange, onTyping }: { value: Fields; onChange: (next: Fields) => void; onTyping?: (text: string) => void }) {
  const { clients, failed, retrying, reread } = useClients();
  const names = (clients ?? []).map(c => c.name);
  const projects = (clients ?? []).find(c => c.name === value.client)?.projects ?? [];
  const projectOptions = [{ value: '', label: !value.client ? 'Elige antes el cliente' : projects.length ? 'Sin proyecto' : 'Sin proyectos en Central' },
    ...[...projects.map(p => p.name), ...(value.project && !projects.some(p => p.name === value.project) ? [value.project] : [])]
      .map(name => ({ value: name, label: `${name}${projects.find(p => p.name === name)?.repo ? ' · GitHub' : ''}` }))];
  // A client saved before (or renamed since) stays visible as it is.
  const options = [{ value: '', label: clients === null ? 'Leyendo tus clientes…' : failed ? 'No se pudieron leer tus clientes' : names.length ? 'Sin cliente' : 'Sin clientes todavía' },
    ...[...names, ...(value.client && !names.includes(value.client) ? [value.client] : [])].map(name => ({ value: name, label: name }))];
  return <div className="meeting-save-fields">
    <label className="field">Tipo<ModernSelect value={value.kind} options={kinds} onChange={kind => onChange({ ...value, kind: kind as MeetingKind })}/></label>
    <label className="field">Cliente<ModernSelect value={value.client} options={options} disabled={!names.length && !value.client} onChange={client => onChange({ ...value, client, project: client === value.client ? value.project : '' })}/></label>
    <label className="field">Proyecto (de Central)<ModernSelect value={value.project} options={projectOptions} disabled={!value.client} onChange={project => onChange({ ...value, project })}/></label>
    {clients !== null && !names.length && <p className="meeting-central-retry">
      <small className="muted">{failed ? 'No se pudieron leer tus clientes.' : 'Aún no tienes clientes: créalos en Trabajos › Clientes o conecta Central (Conectores › Central).'}</small>
      {retrying ? <small className="muted">Se vuelve a intentar sola…</small>
        : <ActionButton icon="refresh" label="Volver a leer" onClick={reread}/>}
    </p>}
    <PeopleField value={value.people} onChange={people => onChange({ ...value, people })} onTyping={onTyping}/>
  </div>;
}

export const asClass = (fields: Fields): MeetingClass =>
  ({ kind: fields.kind, client: fields.client.trim() || null, project: fields.project || null, people: fields.people });

/** Changing the kind, client or people of a recorded meeting. The vault note and the file use the new ones. */
export function MeetingClassCard({ detail, onSaved }: { detail: MeetingDetail; onSaved: () => void }) {
  const [fields, setFields] = useState<Fields>({ kind: detail.kind, client: detail.client ?? '', project: detail.project ?? '', people: detail.people });
  const [state, setState] = useState<{ saving: boolean; done: string; error: string }>({ saving: false, done: '', error: '' });
  const wanted = asClass(fields);
  const [typing, setTyping] = useState('');
  const same = typing.trim() === '' && wanted.kind === detail.kind && wanted.client === detail.client && wanted.project === detail.project && JSON.stringify(wanted.people) === JSON.stringify(detail.people);
  const save = async () => {
    setState({ saving: true, done: '', error: '' });
    try { await updateMeeting(detail.id, wanted); setState({ saving: false, done: 'Guardado.', error: '' }); onSaved(); }
    catch (failure) { setState({ saving: false, done: '', error: failed(failure, 'No se pudo guardar.') }); }
  };
  return <section aria-label="Clasificación" className="meeting-save">
    <h3>Qué fue y con quién</h3>
    <KindFields value={fields} onTyping={setTyping} onChange={next => { setFields(next); setState({ saving: false, done: '', error: '' }); }}/>
    <span className="meeting-actions">
      <ActionButton icon="save" label="Guardar" busyLabel={state.saving && 'Guardando…'} disabled={same || state.saving} onClick={() => void save()}/>
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
    <p className="muted">Esta reunión es privada o solo de {hereLabel}: no se exporta ni se copia para un modelo de fuera.</p>
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
      <ActionButton icon="download" label="Descargar el archivo" onClick={() => void download()}/>
      <ActionButton icon="copy" label="Copiar todo" onClick={() => void copy()}/>
    </span>
    {note && <small className={note.error ? 'dictation-error' : 'ok-note'} role={note.error ? 'alert' : 'status'}>{note.text}</small>}
  </section>;
}
